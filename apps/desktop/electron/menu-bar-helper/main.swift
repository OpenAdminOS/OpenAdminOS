import Foundation

func writeError(_ message: String) {
  if let data = "\(message)\n".data(using: .utf8) {
    FileHandle.standardError.write(data)
  }
}

var appURL = Bundle.main.bundleURL
for _ in 0..<4 {
  appURL.deleteLastPathComponent()
}

let executableURL = appURL
  .appendingPathComponent("Contents")
  .appendingPathComponent("MacOS")
  .appendingPathComponent("OpenAdminOS")

guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
  writeError("OpenAdminOS executable was not found at \(executableURL.path).")
  exit(1)
}

let process = Process()
process.executableURL = executableURL
process.arguments = ["--menu-bar"]
process.currentDirectoryURL = appURL.deletingLastPathComponent()

do {
  try process.run()
} catch {
  writeError("OpenAdminOS menu bar launch failed: \(error.localizedDescription)")
  exit(1)
}
