/**
 * The core's `TextRecognizer` (#397), backed by an Electron utility process
 * of its own (./scanReaderProcess), so reading scanned pages never runs on
 * the main process. The process starts on the first `load`, the first time a
 * scanned page needs reading. If it dies (a crash, or out of memory), the
 * page it was reading fails, and the next `load` starts a new one (see
 * `createChannelTextRecognizer`).
 */
import type { TextRecognizer } from "../core";
import {
  createChannelTextRecognizer,
  type TextRecognizerResponse,
} from "../core/documents/scan/channel";
import { startEngineProcess } from "./engineProcess";
import scanReaderProcessPath from "./scanReaderProcess?modulePath";

export interface UtilityProcessTextRecognizerOptions {
  /**
   * Runs the fake model instead of the real one (smoke tests), reading the
   * pages this JSON file scripts (`FakeScanScript`), or none.
   */
  fake?: { script: string | null };
}

export function createUtilityProcessTextRecognizer(
  options: UtilityProcessTextRecognizerOptions = {},
): TextRecognizer {
  const args = options.fake
    ? ["--fake", ...(options.fake.script ? [options.fake.script] : [])]
    : [];
  return createChannelTextRecognizer(() => {
    const child = startEngineProcess(scanReaderProcessPath, args, "IncarnaMind text recognition");
    return {
      send: (request) => child.postMessage(request),
      onResponse: (listener) =>
        child.on("message", (response: TextRecognizerResponse) => listener(response)),
      onExit: (listener) => child.on("exit", (code) => listener(code)),
      stop: () => child.kill(),
    };
  });
}
