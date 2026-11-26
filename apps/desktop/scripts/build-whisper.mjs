import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const release = "v1.8.3";
const commit = "2eeeba56e9edd762b4b38467bab96c2517163158";
const windows = process.platform === "win32";
const mac = process.platform === "darwin";
const arch = process.argv[2] ?? process.arch;
if (arch !== process.arch || (windows && arch !== "x64")) {
  throw new Error("Build the Whisper sidecar on a runner matching the desktop target architecture.");
}
const metal = mac && arch === "arm64";
const output = fileURLToPath(new URL("../build/nova-speech/", import.meta.url));
const exe = windows ? "whisper-server.exe" : "whisper-server";
const stamp = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url)))
  .update(`${process.platform}/${arch}`).digest("hex");
const marker = join(output, "build-id");
const binary = join(output, exe);
const digest = () => createHash("sha256").update(readFileSync(binary)).digest("hex");
if (existsSync(join(output, exe)) && existsSync(join(output, "whisper.cpp.LICENSE")) &&
    existsSync(marker) && readFileSync(marker, "utf8") === `${stamp}\n${digest()}\n`) {
  console.log(`Using cached whisper.cpp ${release} (${arch}).`);
  process.exit(0);
}
const temporary = mkdtempSync(join(tmpdir(), "openadminos-whisper-"));
const source = join(temporary, "source");
const build = join(temporary, "build");
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

try {
  run("git", ["clone", "--depth=1", "--branch", release, "https://github.com/ggml-org/whisper.cpp.git", source]);
  if (execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== commit) {
    throw new Error("The pinned whisper.cpp tag points to an unexpected commit.");
  }
  const server = join(source, "examples", "server", "server.cpp");
  const original = readFileSync(server, "utf8").replaceAll("\r\n", "\n");
  const start = original.indexOf('    svr->Post(sparams.request_path + "/load"');
  const end = original.indexOf('    svr->Get(sparams.request_path + "/health"', start);
  const bind = "    if (!svr->bind_to_port(sparams.hostname, sparams.port))";
  const publicFiles = "    svr->set_base_dir(sparams.public_path);";
  const report = "sparams.hostname.c_str(), sparams.port);\n\n    shutdown_handler";
  const headers = original.indexOf("    svr->set_default_headers(");
  const defaults = original.indexOf("    // store default params", headers);
  const rootRoute = original.indexOf("    // this is only called if no index.html");
  const inference = original.indexOf("    svr->Post(sparams.request_path + sparams.inference_path", rootRoute);
  const stdinAt = '    if (params.language != "auto"';
  const beam = /    if \(req.has_file\("(?:best_of|beam_size)"\)\)\n    \{[^}]+\}\n/g;
  const simpleTranscript = '{"text", results}\n';
  const errorHandler = /^    svr->set_error_handler\([\s\S]*?^    \}\);\n\n/m;
  if (start < 0 || end < 0 || headers < 0 || defaults < 0 || rootRoute < 0 || inference < 0 ||
      !original.includes(stdinAt) || !original.includes(simpleTranscript) || [...original.matchAll(beam)].length !== 2 ||
      !errorHandler.test(original) || !original.includes(bind) || !original.includes(publicFiles) || !original.includes(report)) {
    throw new Error("The pinned Whisper server layout changed.");
  }
  // Check OS support as well as CPU support before loading any optimized backend.
  // This also makes the packaged --help probe reject an incompatible x64 host.
  const cpuProbe = `#if defined(_M_X64) && defined(_MSC_VER)
#include <intrin.h>
static bool nova_supported_cpu() {
    int regs[4];
    __cpuid(regs, 1);
    const int features = (1 << 12) | (1 << 27) | (1 << 28) | (1 << 29);
    if ((regs[2] & features) != features || (_xgetbv(0) & 6) != 6) return false;
    __cpuidex(regs, 7, 0);
    return (regs[1] & (1 << 5)) != 0;
}
#elif defined(__x86_64__)
static bool nova_supported_cpu() { return __builtin_cpu_supports("avx2"); }
#else
static bool nova_supported_cpu() { return true; }
#endif
`;
  writeFileSync(server, ("#include <iostream>\n" + cpuProbe + original.slice(0, headers) +
    "    svr->set_payload_max_length(8 * 1024 * 1024 + 64 * 1024);\n" +
    original.slice(defaults, rootRoute) + original.slice(inference, start) + original.slice(end))
    .replace(beam, "")
    .replace(errorHandler, "")
    .replace(/^.*"--request-path".*\n/gm, "")
    .replace(/^.*--request-path PATH.*\n/gm, "")
    .replace("    ggml_backend_load_all();", "    if (!nova_supported_cpu()) return 132;\n    ggml_backend_load_all();")
    .replace(stdinAt, `    sparams.hostname = "127.0.0.1";
    if (!std::getline(std::cin, sparams.request_path) || sparams.request_path.size() != 49 ||
        sparams.request_path[0] != '/' || sparams.request_path.find_first_not_of("0123456789abcdef", 1) != std::string::npos) {
        return 2;
    }
    std::thread([] { while (std::cin.get() != EOF) {} std::_Exit(0); }).detach();

` + stdinAt)
    .replace(bind, "    sparams.port = svr->bind_to_any_port(sparams.hostname);\n    if (sparams.port <= 0)")
    .replace(publicFiles, "")
    .replace(simpleTranscript, '{"text", results}, {"language", whisper_lang_str(whisper_full_lang_id(ctx))}\n')
    .replace(report, "sparams.hostname.c_str(), sparams.port);\n    fflush(stdout);\n\n    shutdown_handler"));

  // Language detection already encodes the first window. Reuse it when
  // transcription starts at the same offset with the same context.
  const engine = join(source, "src", "whisper.cpp");
  const code = readFileSync(engine, "utf8").replaceAll("\r\n", "\n");
  const detect = "    // auto-detect language if not specified";
  const detected = "        state->lang_id = lang_id;\n        params.language";
  const encode = "        if (!whisper_encode_internal(*ctx, *state, seek, params.n_threads, params.abort_callback, params.abort_callback_user_data))";
  const contextStart = code.indexOf("    // overwrite audio_ctx, max allowed is hparams.n_audio_ctx");
  const contextEnd = code.indexOf("    // these tokens determine the task", contextStart);
  if (![detect, detected, encode].every(line => code.includes(line)) || contextStart < 0 || contextEnd < 0) {
    throw new Error("The pinned Whisper engine layout changed.");
  }
  writeFileSync(engine, (code.slice(0, contextStart) + code.slice(contextEnd))
    .replace(detect, code.slice(contextStart, contextEnd) + "    bool encoded_first_window = false;\n" + detect)
    .replace(detected, "        encoded_first_window = params.offset_ms == 0;\n" + detected)
    .replace(encode, encode.replace("if (!", "if (!(encoded_first_window && seek == 0) && !")));

  run("cmake", ["-S", source, "-B", build,
    "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DGGML_NATIVE=OFF",
    "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=ON",
    "-DGGML_OPENMP=OFF", "-DGGML_METAL=" + (metal ? "ON" : "OFF"),
    ...(metal ? ["-DGGML_METAL_EMBED_LIBRARY=ON"] : []),
    ...(mac ? ["-DCMAKE_OSX_ARCHITECTURES=" + (arch === "x64" ? "x86_64" : arch), "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"] : []),
    // TODO(ugur): Evaluate CUDA or Vulkan builds after measuring signed CPU installers.
    ...(arch === "x64" ? ["-DGGML_AVX=ON", "-DGGML_AVX2=ON", "-DGGML_FMA=ON", "-DGGML_F16C=ON", "-DGGML_AVX512=OFF"] : []),
    ...(windows ? ["-A", "x64", "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW", "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"] : []),
  ]);
  run("cmake", ["--build", build, "--config", "Release", "--target", "whisper-server", "--parallel", "2"]);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  copyFileSync(join(build, "bin", ...(windows ? ["Release"] : []), exe), join(output, exe));
  copyFileSync(join(source, "LICENSE"), join(output, "whisper.cpp.LICENSE"));
  writeFileSync(marker, `${stamp}\n${digest()}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
