/**
 * The text recognition utility process (#397): reads scanned pages' pictures
 * with the built-in model off the main process (see ./scanReader), serving
 * requests one at a time, in order (see `serveTextRecognizer`).
 *
 * Started with --fake by the smoke tests' INCARNAMIND_TEST_EMBEDDER=fake
 * flag: it then runs the fake model, reading what the JSON file named after
 * it scripts (INCARNAMIND_TEST_SCANS), a little slowly, so a test can see
 * the pages being read.
 */
import { readFileSync } from "node:fs";
import type { TextRecognizer } from "../core";
import { serveTextRecognizer, type TextRecognizerRequest } from "../core/documents/scan/channel";
import { createFakeTextRecognizer, type FakeScanScript } from "../core/documents/scan/fake";
import { createOnnxTextRecognizer } from "../core/documents/scan/onnx";
import { CANVAS } from "../core/documents/scan/picture";
import { answerEngineCheck, ENGINE_CHECK_ARGUMENT, ONNX_RUNTIME } from "../core/engineModules";

const fake = process.argv.indexOf("--fake");
const scriptFile = fake === -1 ? undefined : process.argv[fake + 1];
const recognizer: TextRecognizer =
  fake === -1
    ? createOnnxTextRecognizer()
    : createFakeTextRecognizer({
        delayMs: 400,
        ...(scriptFile && {
          script: JSON.parse(readFileSync(scriptFile, "utf8")) as FakeScanScript,
        }),
      });

const port = process.parentPort;

if (process.argv.includes(ENGINE_CHECK_ARGUMENT)) {
  answerEngineCheck(port, [ONNX_RUNTIME, CANVAS]);
} else {
  serveTextRecognizer(recognizer, {
    onRequest: (listener) =>
      port.on("message", ({ data }: { data: TextRecognizerRequest }) => listener(data)),
    respond: (response) => port.postMessage(response),
  });
}
