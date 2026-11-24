import { spawn } from "node:child_process";
import { win32 } from "node:path";

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export function boundScreenText(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const suffix = "\n[Screen text truncated]";
  if (limit < Buffer.byteLength(suffix)) return suffix.slice(0, Math.max(0, limit));
  let end = limit - Buffer.byteLength(suffix);
  while (end && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

export function layoutScreenText(lines: OcrLine[], limit: number): string {
  const rows: OcrLine[][] = [];
  for (const line of [...lines].sort((a, b) => a.y - b.y)) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first && Math.abs(first.y + first.height / 2 - line.y - line.height / 2) <= Math.min(first.height, line.height) / 2) {
      row.push(line);
    } else {
      rows.push([line]);
    }
  }
  return boundScreenText(rows.map(row => row.sort((a, b) => a.x - b.x).map(line => line.text).join(" | ")).join("\n"), limit);
}

export function parseTesseract(tsv: string): OcrLine[] {
  const lines = new Map<string, OcrLine>();
  for (const row of tsv.split("\n")) {
    const [level, page, block, paragraph, line, , x, y, width, height, confidence, ...content] = row.split("\t");
    const text = content.join("\t").trim();
    if (level !== "5" || !text) continue;
    const key = [page, block, paragraph, line].join("/");
    const entry = lines.get(key);
    const word = { text, x: Number(x), y: Number(y), width: Number(width), height: Number(height), confidence: Number(confidence) / 100 };
    if (!entry) {
      lines.set(key, word);
      continue;
    }
    const right = Math.max(entry.x + entry.width, word.x + word.width);
    const bottom = Math.max(entry.y + entry.height, word.y + word.height);
    entry.x = Math.min(entry.x, word.x);
    entry.y = Math.min(entry.y, word.y);
    entry.width = right - entry.x;
    entry.height = bottom - entry.y;
    entry.confidence = Math.min(entry.confidence, word.confidence);
    entry.text += " " + text;
  }
  return [...lines.values()];
}

const windowsOcr = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (!$engine) { exit 12 }
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name.Split([char]96)[0] -eq 'IAsyncOperation'
} | Select-Object -First 1
function Await($operation, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$source = [Console]::OpenStandardInput()
$memory = [System.IO.MemoryStream]::new()
$source.CopyTo($memory)
$memory.Position = 0
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @(
  foreach ($line in $result.Lines) {
    $left = ($line.Words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
    $top = ($line.Words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
    $right = ($line.Words | ForEach-Object { $_.BoundingRect.Right } | Measure-Object -Maximum).Maximum
    $bottom = ($line.Words | ForEach-Object { $_.BoundingRect.Bottom } | Measure-Object -Maximum).Maximum
    @{text=$line.Text; x=$left; y=$top; width=$right-$left; height=$bottom-$top; confidence=-1}
  }
)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write((ConvertTo-Json -InputObject $lines -Compress))
`;

function parseNativeOcr(output: string, windows: boolean): OcrLine[] {
  const value: unknown = JSON.parse(output);
  const lines = Array.isArray(value) ? value : windows ? [value] : undefined;
  if (!lines || !lines.every((line): line is OcrLine =>
    line && typeof line === "object" && typeof line.text === "string" &&
    [line.x, line.y, line.width, line.height, line.confidence].every(Number.isFinite) &&
    line.x >= 0 && line.y >= 0 && line.width > 0 && line.height > 0 &&
    line.confidence >= -1 && line.confidence <= 1)) {
    throw new Error("Invalid OCR output.");
  }
  return lines.filter(line => line.text.trim());
}

export async function recognizeScreen(png: Buffer, appleHelper: string, options: {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
} = {}): Promise<{ engine: string; lines: OcrLine[] }> {
  const platform = options.platform ?? process.platform;
  const mac = platform === "darwin";
  const windows = platform === "win32";
  const engine = mac ? "apple-vision" : windows ? "windows-ocr" : "tesseract";
  const root = options.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const command = mac ? appleHelper : windows
    ? win32.resolve(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "tesseract";
  const args = mac ? ["ocr"] : windows
    ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsOcr, "utf16le").toString("base64")]
    : ["stdin", "stdout", "tsv"];
  const failure = () => new Error(mac
    ? "Apple Vision could not read this area. Check that OpenAdminOS is up to date and try again."
    : windows ? "Windows could not read this area. Select a smaller area and try again."
      : "On-device screen reading is unavailable. Install Tesseract and an OCR language pack, then try again.");
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const child = (options.spawnProcess ?? spawn)(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], signal });
      const fail = () => reject(failure());
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { child.kill(); fail(); return; }
        chunks.push(chunk);
      });
      child.once("error", fail);
      // Wait for close after a broken stdin pipe so exit 12 still reports the missing language pack.
      child.stdin!.on("error", () => {});
      child.once("close", code => {
        if (windows && code === 12) reject(new Error("Install a Windows OCR language pack in Settings, Time & language, then try again."));
        else if (code !== 0) fail();
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin!.end(png);
    });
    return { engine, lines: mac || windows ? parseNativeOcr(output, windows) : parseTesseract(output) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Install a Windows OCR language pack")) throw error;
    throw failure();
  }
}
