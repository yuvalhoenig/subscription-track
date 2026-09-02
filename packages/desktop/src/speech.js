/**
 * Native macOS speech recognition.
 *
 * Uses Apple's Speech framework (SFSpeechRecognizer) through a tiny Swift
 * helper, which is the only way to reach it from Electron. Two advantages
 * over the renderer's Web Speech API: recognition can run entirely
 * on-device (`requiresOnDeviceRecognition`), so audio never leaves the
 * machine, and it uses the dictation model the user has already trained.
 *
 * The helper is compiled on first use and cached in userData. If the Swift
 * toolchain is absent — a machine without Xcode command line tools — this
 * module reports itself unavailable and the renderer falls back to the Web
 * Speech API. Nothing breaks either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import { config } from './config.js';

const run = promisify(execFile);

const SWIFT_SOURCE = `import Foundation
import Speech
import AVFoundation

// Recognises a single utterance from the default input and prints the
// final transcript to stdout. Exits non-zero with a message on stderr.
final class Recogniser {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recogniser: SFSpeechRecognizer
    private var finished = false

    init(locale: String) {
        recogniser = SFSpeechRecognizer(locale: Locale(identifier: locale)) ?? SFSpeechRecognizer()!
    }

    func finish(_ text: String?, error: String?) {
        guard !finished else { return }
        finished = true
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        task?.cancel()
        if let text = text, !text.isEmpty {
            print(text)
            exit(0)
        } else {
            FileHandle.standardError.write((error ?? "No speech detected").data(using: .utf8)!)
            exit(1)
        }
    }

    func start(timeout: Double) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                self.finish(nil, error: "Speech recognition permission was not granted")
                return
            }
            DispatchQueue.main.async { self.listen(timeout: timeout) }
        }
    }

    private func listen(timeout: Double) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        // Keep audio on the device when the model supports it.
        if recogniser.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            finish(nil, error: "Could not start audio input: \\(error.localizedDescription)")
            return
        }

        task = recogniser.recognitionTask(with: request) { result, error in
            if let result = result, result.isFinal {
                self.finish(result.bestTranscription.formattedString, error: nil)
            } else if let error = error {
                self.finish(nil, error: error.localizedDescription)
            }
        }

        // Stop listening after a pause so the process cannot hang forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            request.endAudio()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                self.finish(nil, error: "Listening timed out")
            }
        }
    }
}

let locale = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "en-US"
let timeout = CommandLine.arguments.count > 2 ? (Double(CommandLine.arguments[2]) ?? 6.0) : 6.0
let recogniser = Recogniser(locale: locale)
recogniser.start(timeout: timeout)
RunLoop.main.run()
`;

let compiled = null;
let compileFailed = false;

function helperPath() {
  return path.join(app.getPath('userData'), 'subtrack-speech');
}

async function hasSwift() {
  try {
    await run('xcrun', ['--find', 'swiftc'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Compile the helper once, caching the binary in userData. */
async function ensureHelper() {
  if (compiled) return compiled;
  if (compileFailed) return null;

  const target = helperPath();
  if (fs.existsSync(target)) {
    compiled = target;
    return compiled;
  }
  if (!(await hasSwift())) {
    compileFailed = true;
    return null;
  }

  const source = `${target}.swift`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, SWIFT_SOURCE, 'utf8');
    // -O for a responsive helper; compilation takes a couple of seconds
    // and happens once per install.
    await run('xcrun', ['swiftc', '-O', '-o', target, source], { timeout: 120_000 });
    fs.chmodSync(target, 0o755);
    fs.unlinkSync(source);
    compiled = target;
    return compiled;
  } catch (error) {
    process.stderr.write(`[speech] could not build the helper: ${error.message}\n`);
    compileFailed = true;
    return null;
  }
}

/**
 * Whether native recognition can be used.
 * Reported to the renderer so it knows whether to call `listen` or fall
 * back to the Web Speech API.
 */
export async function speechAvailable() {
  if (!config.isMac) return false;
  if (compiled) return true;
  if (compileFailed) return false;
  return hasSwift();
}

/** Listen for one utterance and return the transcript. */
export async function listen({ language = 'en-US', timeoutSeconds = 6 } = {}) {
  if (!config.isMac) throw new Error('Native speech recognition is only available on macOS.');
  const helper = await ensureHelper();
  if (!helper) {
    throw new Error(
      'Native speech recognition needs the Xcode command line tools '
      + '(xcode-select --install). Using the browser recogniser instead.',
    );
  }
  try {
    const { stdout } = await run(helper, [language, String(timeoutSeconds)], {
      timeout: (timeoutSeconds + 8) * 1000,
    });
    return stdout.trim();
  } catch (error) {
    const detail = (error.stderr ?? error.message ?? '').toString().trim();
    throw new Error(detail || 'Speech recognition failed');
  }
}

export default { speechAvailable, listen };
