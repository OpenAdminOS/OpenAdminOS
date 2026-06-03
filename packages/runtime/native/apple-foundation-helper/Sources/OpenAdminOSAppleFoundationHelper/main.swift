import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

private let modelName = "system-language-model"
private let defaultMaximumResponseTokens = 512
private let minimumResponseTokens = 64
private let contextSafetyMarginTokens = 32

struct HelperRequest: Decodable {
  let command: String
  let system: String?
  let prompt: String?
  let temperature: Double?
  let maxTokens: Int?
}

struct HelperResponse: Encodable {
  let ok: Bool
  let ready: Bool?
  let detail: String?
  let error: String?
  let model: String?
  let models: [String]?
  let defaultModel: String?
  let contextSize: Int?
  let supportedLanguages: [String]?
}

struct StreamResponse: Encodable {
  let ok: Bool
  let type: String
  let error: String?
  let delta: String?
  let accumulated: String?
  let done: Bool?
  let model: String?
  let promptTokens: Int?
  let completionTokens: Int?
  let totalTokens: Int?
}

struct TokenCountResult {
  let value: Int
  let exact: Bool
}

@main
struct OpenAdminOSAppleFoundationHelper {
  static func main() async {
    guard let data = FileHandle.standardInput.readDataToEndOfFile().nonEmpty else {
      emitErrorResponse("No JSON request was supplied.", exitCode: 2)
      return
    }

    let request: HelperRequest
    do {
      request = try JSONDecoder().decode(HelperRequest.self, from: data)
    } catch {
      emitErrorResponse("Invalid JSON request: \(error.localizedDescription)", exitCode: 2)
      return
    }

    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
      await handle(request)
    } else {
      emitUnavailable("Apple Foundation requires macOS 26 or later.")
      Foundation.exit(1)
    }
    #else
    emitUnavailable("FoundationModels.framework is not available in this build environment.")
    Foundation.exit(1)
    #endif
  }
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private func handle(_ request: HelperRequest) async {
  switch request.command {
  case "probe":
    emitProbe()
  case "stream":
    await streamCompletion(request)
  default:
    emitErrorResponse("Unsupported command: \(request.command)", exitCode: 2)
  }
}

@available(macOS 26.0, *)
private func emitProbe() {
  switch SystemLanguageModel.default.availability {
  case .available:
    let contextSize = SystemLanguageModel.default.contextSize
    emit(
      HelperResponse(
        ok: true,
        ready: true,
        detail: "Apple Intelligence Foundation Models available locally. Context: \(contextSize) tokens.",
        error: nil,
        model: modelName,
        models: [modelName],
        defaultModel: modelName,
        contextSize: contextSize,
        supportedLanguages: supportedLanguageIdentifiers()
      )
    )
  case .unavailable(let reason):
    emit(
      HelperResponse(
        ok: true,
        ready: false,
        detail: availabilityDetail(reason),
        error: nil,
        model: modelName,
        models: [],
        defaultModel: nil,
        contextSize: nil,
        supportedLanguages: nil
      )
    )
  @unknown default:
    emit(
      HelperResponse(
        ok: true,
        ready: false,
        detail: "Apple Intelligence model availability is unknown.",
        error: nil,
        model: modelName,
        models: [],
        defaultModel: nil,
        contextSize: nil,
        supportedLanguages: nil
      )
    )
  }
}

@available(macOS 26.0, *)
private func streamCompletion(_ request: HelperRequest) async {
  guard case .available = SystemLanguageModel.default.availability else {
    emitStreamError("Apple Intelligence Foundation Models are not available. Check Settings -> Apple Intelligence & Siri.")
    Foundation.exit(1)
  }

  let prompt = (request.prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  guard !prompt.isEmpty else {
    emitStreamError("Prompt is required.")
    Foundation.exit(2)
  }

  let instructions = request.system?.trimmingCharacters(in: .whitespacesAndNewlines)
  let contextSize = SystemLanguageModel.default.contextSize
  let promptInput = [instructions, prompt]
    .compactMap { $0 }
    .filter { !$0.isEmpty }
    .joined(separator: "\n\n")
  let promptTokenCount = await tokenCount(for: promptInput)
  let requestedMaxTokens =
    sanitizedMaxTokens(request.maxTokens) ?? defaultMaximumResponseTokens
  let availableResponseTokens =
    contextSize - promptTokenCount.value - contextSafetyMarginTokens

  guard availableResponseTokens >= minimumResponseTokens else {
    let countKind = promptTokenCount.exact ? "uses" : "is estimated at"
    emitStreamError(
      "Apple Foundation context window is too small for this prompt. The prompt \(countKind) \(promptTokenCount.value) tokens before response generation; the model supports \(contextSize) tokens total. Reduce the answer pack or switch to a larger-context provider."
    )
    Foundation.exit(1)
  }

  let maximumResponseTokens = min(requestedMaxTokens, availableResponseTokens)
  let session = instructions.isEmptyOrNil
    ? LanguageModelSession()
    : LanguageModelSession(instructions: instructions!)
  let options = GenerationOptions(
    temperature: sanitizedTemperature(request.temperature),
    maximumResponseTokens: maximumResponseTokens
  )
  let stream = session.streamResponse(to: prompt, options: options)
  var accumulated = ""

  do {
    for try await snapshot in stream {
      let content = snapshot.content
      let delta: String
      if content.hasPrefix(accumulated) {
        delta = String(content.dropFirst(accumulated.count))
      } else {
        delta = content
      }
      accumulated = content
      if !delta.isEmpty {
        emit(
          StreamResponse(
            ok: true,
            type: "chunk",
            error: nil,
            delta: delta,
            accumulated: accumulated,
            done: false,
            model: modelName,
            promptTokens: nil,
            completionTokens: nil,
            totalTokens: nil
          )
        )
      }
    }

    let completionTokenCount = await tokenCount(for: accumulated)
    let includeExactUsage = promptTokenCount.exact && completionTokenCount.exact
    emit(
      StreamResponse(
        ok: true,
        type: "chunk",
        error: nil,
        delta: "",
        accumulated: accumulated,
        done: true,
        model: modelName,
        promptTokens: includeExactUsage ? promptTokenCount.value : nil,
        completionTokens: includeExactUsage ? completionTokenCount.value : nil,
        totalTokens: includeExactUsage
          ? promptTokenCount.value + completionTokenCount.value
          : nil
      )
    )
  } catch LanguageModelSession.GenerationError.exceededContextWindowSize {
    emitStreamError(
      "Apple Foundation exceeded its \(contextSize)-token context window. Reduce the answer pack or switch to a larger-context provider."
    )
    Foundation.exit(1)
  } catch {
    emitStreamError("Apple Foundation generation failed: \(error.localizedDescription)")
    Foundation.exit(1)
  }
}

@available(macOS 26.0, *)
private func availabilityDetail(
  _ reason: SystemLanguageModel.Availability.UnavailableReason
) -> String {
  switch reason {
  case .deviceNotEligible:
    return "This Mac is not eligible for Apple Intelligence Foundation Models."
  case .appleIntelligenceNotEnabled:
    return "Apple Intelligence is disabled. Turn it on in Settings -> Apple Intelligence & Siri."
  case .modelNotReady:
    return "Apple Intelligence model is not ready yet. Keep the Mac on Wi-Fi and power while it finishes downloading."
  @unknown default:
    return "Apple Intelligence Foundation Models are unavailable: \(String(describing: reason))."
  }
}

@available(macOS 26.0, *)
private func supportedLanguageIdentifiers() -> [String] {
  SystemLanguageModel.default.supportedLanguages
    .map { $0.minimalIdentifier }
    .sorted()
}

@available(macOS 26.0, *)
private func tokenCount(for text: String) async -> TokenCountResult {
  if #available(macOS 26.4, *) {
    do {
      return TokenCountResult(
        value: try await SystemLanguageModel.default.tokenCount(for: text),
        exact: true
      )
    } catch {
      return TokenCountResult(value: estimatedTokenCount(for: text), exact: false)
    }
  }
  return TokenCountResult(value: estimatedTokenCount(for: text), exact: false)
}
#endif

private func estimatedTokenCount(for text: String) -> Int {
  if text.isEmpty {
    return 0
  }
  let containsCjk = text.unicodeScalars.contains { scalar in
    (0x4E00...0x9FFF).contains(scalar.value) ||
      (0x3040...0x30FF).contains(scalar.value) ||
      (0xAC00...0xD7AF).contains(scalar.value)
  }
  if containsCjk {
    return max(1, text.count)
  }
  return max(1, Int(ceil(Double(text.count) / 3.5)))
}

private func sanitizedTemperature(_ value: Double?) -> Double? {
  guard let value else {
    return nil
  }
  if !value.isFinite {
    return nil
  }
  return min(2.0, max(0.0, value))
}

private func sanitizedMaxTokens(_ value: Int?) -> Int? {
  guard let value else {
    return nil
  }
  return max(1, value)
}

private func emitUnavailable(_ detail: String) {
  emit(
    HelperResponse(
      ok: true,
      ready: false,
      detail: detail,
      error: nil,
      model: modelName,
      models: [],
      defaultModel: nil,
      contextSize: nil,
      supportedLanguages: nil
    )
  )
}

private func emitErrorResponse(_ message: String, exitCode: Int32) {
  emit(
    HelperResponse(
      ok: false,
      ready: nil,
      detail: nil,
      error: message,
      model: nil,
      models: nil,
      defaultModel: nil,
      contextSize: nil,
      supportedLanguages: nil
    )
  )
  Foundation.exit(exitCode)
}

private func emitStreamError(_ message: String) {
  emit(
    StreamResponse(
      ok: false,
      type: "error",
      error: message,
      delta: nil,
      accumulated: nil,
      done: nil,
      model: modelName,
      promptTokens: nil,
      completionTokens: nil,
      totalTokens: nil
    )
  )
}

private func emit<T: Encodable>(_ value: T) {
  do {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  } catch {
    let fallback = #"{"ok":false,"type":"error","error":"Failed to encode helper response."}"#
    FileHandle.standardOutput.write(Data("\(fallback)\n".utf8))
  }
}

private extension Data {
  var nonEmpty: Data? {
    isEmpty ? nil : self
  }
}

private extension Optional where Wrapped == String {
  var isEmptyOrNil: Bool {
    switch self {
    case .none:
      return true
    case .some(let value):
      return value.isEmpty
    }
  }
}
