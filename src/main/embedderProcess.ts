/**
 * The embedding utility process: runs the built-in embedding model off the
 * main process (see ./embedder), serving requests from the main process one at
 * a time, in order (see `serveEmbedder`).
 *
 * Started with --fake by the smoke tests' INCARNAMIND_TEST_EMBEDDER=fake flag:
 * it then runs the deterministic fake model instead, with no files.
 */
import type { Embedder } from "../core";
import { type EmbedderRequest, serveEmbedder } from "../core/embedding/channel";
import { createFakeEmbedder } from "../core/embedding/fake";
import { createOnnxEmbedder } from "../core/embedding/onnx";
import {
  answerEngineCheck,
  ENGINE_CHECK_ARGUMENT,
  ONNX_RUNTIME,
  TOKENIZERS,
} from "../core/engineModules";

const fake = process.argv.includes("--fake");
// The fake is slowed down so a smoke test can see a Document's "embedding" status.
const embedder: Embedder = fake ? createFakeEmbedder({ delayMs: 50 }) : createOnnxEmbedder();

const port = process.parentPort;

if (process.argv.includes(ENGINE_CHECK_ARGUMENT)) {
  answerEngineCheck(port, [ONNX_RUNTIME, TOKENIZERS]);
} else {
  serveEmbedder(embedder, {
    onRequest: (listener) =>
      port.on("message", ({ data }: { data: EmbedderRequest }) => listener(data)),
    respond: (response) => port.postMessage(response),
  });
}
