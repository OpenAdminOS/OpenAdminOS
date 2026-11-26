import AVFoundation
import CoreAudio
import Darwin
import Foundation
import os

private let system = AudioObjectID(kAudioObjectSystemObject)
private let retry: Int32 = 75
private let permissionDenied: Int32 = 77
private let maxPcmBytes = 4092
private let maxInputFrames: AVAudioFrameCount = 16_384

private struct AudioFailure: Error {
    let status: OSStatus
}

private func require(_ status: OSStatus) throws {
    if status != noErr { throw AudioFailure(status: status) }
}

private func property(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func executablePath(_ pid: pid_t) -> String? {
    var path = [CChar](repeating: 0, count: Int(PROC_PIDPATHINFO_MAXSIZE))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
    return String(cString: path)
}

private func processObjects() throws -> [AudioObjectID] {
    var address = property(kAudioHardwarePropertyProcessObjectList)
    for _ in 0..<3 {
        var size: UInt32 = 0
        try require(AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size))
        guard size <= 64 * 1024 else { break }
        var processes = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.stride)
        if processes.isEmpty { return [] }
        let status = processes.withUnsafeMutableBytes { bytes in
            AudioObjectGetPropertyData(system, &address, 0, nil, &size, bytes.baseAddress!)
        }
        if status == kAudioHardwareBadPropertySizeError { continue }
        try require(status)
        return Array(processes.prefix(Int(size) / MemoryLayout<AudioObjectID>.stride)).sorted()
    }
    throw AudioFailure(status: kAudioHardwareBadPropertySizeError)
}

private func excludedProcesses(_ processes: [AudioObjectID], parent: pid_t, appPath: String) throws -> [AudioObjectID] {
    try processes.filter { object in
        var pid: pid_t = 0
        var size = UInt32(MemoryLayout<pid_t>.size)
        var address = property(kAudioProcessPropertyPID)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid)
        // Process objects can disappear between enumeration and PID lookup.
        if status == kAudioHardwareBadObjectError { return false }
        try require(status)
        return pid == parent || pid == getpid() || executablePath(pid)?.hasPrefix(appPath) == true
    }
}

// HAL only copies into preallocated slots. The control queue owns conversion,
// process enumeration, and pipe writes. Overflow discards the generation.
private final class AudioRing {
    private struct Slot {
        let samples: UnsafeMutablePointer<Float>
        var frames = 0
    }
    private var lock = os_unfair_lock_s()
    private var slots = (0..<8).map { _ in
        let samples = UnsafeMutablePointer<Float>.allocate(capacity: Int(maxInputFrames))
        samples.initialize(repeating: 0, count: Int(maxInputFrames))
        return Slot(samples: samples)
    }
    private var reading = 0
    private var writing = 0
    private var queued = 0
    private var sampleTime: Float64?
    private var discontinuity = false

    deinit {
        for slot in slots { slot.samples.deallocate() }
    }

    func copy(_ input: UnsafePointer<AudioBufferList>, timestamp: AudioTimeStamp) {
        guard os_unfair_lock_trylock(&lock) else { return }
        defer { os_unfair_lock_unlock(&lock) }
        let audio = input.pointee.mBuffers
        let frames = Int(audio.mDataByteSize) / MemoryLayout<Float>.size
        guard input.pointee.mNumberBuffers == 1, audio.mNumberChannels == 1,
              frames > 0, frames <= maxInputFrames, let data = audio.mData else { return }
        if queued == slots.count || (timestamp.mSampleTime != 0 && sampleTime.map { abs($0 - timestamp.mSampleTime) > 1 } == true) {
            discontinuity = true
            return
        }
        sampleTime = timestamp.mSampleTime == 0 ? nil : timestamp.mSampleTime + Double(frames)
        slots[writing].samples.update(from: data.assumingMemoryBound(to: Float.self), count: frames)
        slots[writing].frames = frames
        writing = (writing + 1) % slots.count
        queued += 1
    }

    func read(into target: AVAudioPCMBuffer) throws -> Bool {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        if discontinuity { throw AudioFailure(status: kAudioHardwareUnspecifiedError) }
        guard queued > 0 else { return false }
        let slot = slots[reading]
        target.floatChannelData![0].update(from: slot.samples, count: slot.frames)
        target.frameLength = AVAudioFrameCount(slot.frames)
        reading = (reading + 1) % slots.count
        queued -= 1
        return true
    }
}

private final class Capture {
    private let queue = DispatchQueue(label: "nova.call.capture")
    private let parent: pid_t
    private let appPath: String
    private var stdinSource: DispatchSourceRead?
    private var pump: DispatchSourceTimer?
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var io: AudioDeviceIOProcID?
    private var running = false
    private var announced = false
    private var exclusions: [AudioObjectID] = []
    private var knownProcesses: [AudioObjectID] = []
    private var frame = [UInt8](repeating: 0, count: maxPcmBytes + 3)

    init(parent: pid_t, appPath: String) {
        self.parent = parent
        self.appPath = appPath
    }

    func run() {
        signal(SIGPIPE, SIG_IGN)
        for fd in [STDIN_FILENO, STDOUT_FILENO] {
            let flags = fcntl(fd, F_GETFL)
            guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) >= 0 else { finish(retry) }
        }
        let stdinSource = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: queue)
        self.stdinSource = stdinSource
        stdinSource.setEventHandler { [self] in
            var byte: UInt8 = 0
            let count = read(STDIN_FILENO, &byte, 1)
            if count == 0 || (count < 0 && errno != EAGAIN && errno != EINTR) { finish(0) }
        }
        stdinSource.resume()
        queue.async { [self] in
            do { try start() }
            catch { finish(error) }
        }
    }

    private func start() throws {
        // Route listeners are installed before opening the tap. Their callbacks
        // share the pump's serial queue and stop the stream before rebuilding.
        var routeDevices = Set<AudioObjectID>()
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDefaultSystemOutputDevice,
                         kAudioHardwarePropertyDefaultInputDevice] {
            try watch(system, selector) { [self] in finish(retry) }
            var address = property(selector)
            var object = AudioObjectID(kAudioObjectUnknown)
            var size = UInt32(MemoryLayout<AudioObjectID>.size)
            try require(AudioObjectGetPropertyData(system, &address, 0, nil, &size, &object))
            if object != kAudioObjectUnknown { routeDevices.insert(object) }
        }
        for route in routeDevices {
            try watch(route, kAudioDevicePropertyNominalSampleRate) { [self] in finish(retry) }
        }
        try watch(system, kAudioHardwarePropertyProcessObjectList) { [self] in
            do { try verifyExclusions() }
            catch { finish(error) }
        }
        knownProcesses = try processObjects()
        exclusions = try excludedProcesses(knownProcesses, parent: parent, appPath: appPath)

        let description = CATapDescription(monoGlobalTapButExcludeProcesses: exclusions)
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try require(AudioHardwareCreateProcessTap(description, &tap))

        var formatAddress = property(kAudioTapPropertyFormat)
        var stream = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try require(AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &size, &stream))
        guard let source = AVAudioFormat(streamDescription: &stream),
              source.channelCount == 1, source.commonFormat == .pcmFormatFloat32,
              let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: maxInputFrames),
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: source, to: target),
              let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: maxInputFrames) else {
            finish(retry)
        }

        // A tap-only aggregate has no physical input and never opens the mic.
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "OpenAdminOS Call Assist",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        try require(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device))
        try watch(tap, kAudioTapPropertyFormat) { [self] in finish(retry) }
        try watch(device, kAudioDevicePropertyNominalSampleRate) { [self] in finish(retry) }
        try watch(device, kAudioDevicePropertyDeviceIsAlive) { [self] in finish(retry) }

        let ring = AudioRing()
        try require(AudioDeviceCreateIOProcIDWithBlock(&io, device, nil) { _, input, time, _, _ in
            ring.copy(input, timestamp: time.pointee)
        })
        try verifyExclusions()
        try require(AudioDeviceStart(device, io))
        running = true

        let pump = DispatchSource.makeTimerSource(queue: queue)
        self.pump = pump
        // Run faster than a device buffer. The callback never waits for this timer.
        pump.schedule(deadline: .now(), repeating: .milliseconds(2), leeway: .milliseconds(1))
        pump.setEventHandler { [self] in
            do {
                for _ in 0..<8 {
                    guard try ring.read(into: input) else { return }
                    try verifyExclusions()
                    convert(converter, input: input, output: output)
                }
            } catch { finish(error) }
        }
        pump.resume()
    }

    private func verifyExclusions() throws {
        let current = try processObjects()
        guard current != knownProcesses else { return }
        let excluded = try excludedProcesses(current, parent: parent, appPath: appPath)
        guard excluded == exclusions else { finish(retry) }
        knownProcesses = current
    }

    private func watch(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, changed: @escaping () -> Void) throws {
        var address = property(selector)
        let listener: AudioObjectPropertyListenerBlock = { _, _ in changed() }
        try require(AudioObjectAddPropertyListenerBlock(object, &address, queue, listener))
    }

    private func convert(_ converter: AVAudioConverter, input: AVAudioPCMBuffer, output: AVAudioPCMBuffer) {
        var remaining = true
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            state.pointee = remaining ? .haveData : .noDataNow
            defer { remaining = false }
            return remaining ? input : nil
        }
        if status == .error { finish(retry) }
        let length = Int(output.frameLength) * MemoryLayout<Int16>.size
        guard length > 0, let data = output.int16ChannelData?[0] else { return }
        if !announced {
            emit(kind: 1, payload: nil, bytes: 0)
            announced = true
        }
        let pcm = UnsafeRawPointer(data)
        for offset in stride(from: 0, to: length, by: maxPcmBytes) {
            emit(kind: 2, payload: pcm + offset, bytes: min(length - offset, maxPcmBytes))
        }
    }

    private func emit(kind: UInt8, payload: UnsafeRawPointer?, bytes: Int) {
        let written = frame.withUnsafeMutableBytes { packet in
            packet[0] = kind
            packet[1] = UInt8(truncatingIfNeeded: bytes)
            packet[2] = UInt8(bytes >> 8)
            if let payload { memcpy(packet.baseAddress! + 3, payload, bytes) }
            return write(STDOUT_FILENO, packet.baseAddress!, bytes + 3)
        }
        if written == -1 && errno == EPIPE { finish(0) }
        // A short write or a full pipe ends this generation. Electron drops
        // its incomplete packet and restarts with a new stream.
        if written != bytes + 3 { finish(retry) }
    }

    private func finish(_ error: Error) -> Never {
        guard let status = (error as? AudioFailure)?.status else { finish(retry) }
        // Some HAL versions report 'nope' rather than the device permission error.
        finish(status == kAudioDevicePermissionsError || status == 0x6e6f7065 ? permissionDenied : retry)
    }

    private func finish(_ code: Int32) -> Never {
        pump?.cancel()
        stdinSource?.cancel()
        if running { AudioDeviceStop(device, io) }
        if let io { AudioDeviceDestroyIOProcID(device, io) }
        // HAL releases this process's listeners at exit. Removing an in-flight
        // listener from its own target queue can block teardown.
        if device != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(device) }
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        exit(code)
    }
}

guard CommandLine.arguments.count == 2,
      let parent = pid_t(CommandLine.arguments[1]), parent == getppid(),
      let executable = executablePath(parent),
      let bundle = executable.range(of: ".app/Contents/MacOS/", options: .backwards) else { exit(retry) }
private let capture = Capture(parent: parent, appPath: String(executable[..<bundle.lowerBound]) + ".app/Contents/")
capture.run()
dispatchMain()
