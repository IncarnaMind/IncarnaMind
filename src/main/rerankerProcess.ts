/**
 * The reranking utility process: runs the built-in reranking model off the
 * main process (see ./reranker), serving requests one at a time, in order
 * (see `serveCrossEncoder`).
 *
 * Started with --fake by the smoke tests' INCARNAMIND_TEST_EMBEDDER=fake flag:
 * it then runs the deterministic fake model instead, with no files.
 */
import type { CrossEncoder } from "../core";
import {
  answerEngineCheck,
  ENGINE_CHECK_ARGUMENT,
  ONNX_RUNTIME,
  TOKENIZERS,
} from "../core/engineModules";
import { type CrossEncoderRequest, serveCrossEncoder } from "../core/reranking/channel";
import { createFakeCrossEncoder } from "../core/reranking/fake";
import { createOnnxCrossEncoder } from "../core/reranking/onnx";

const fake = process.argv.includes("--fake");
const crossEncoder: CrossEncoder = fake ? createFakeCrossEncoder() : createOnnxCrossEncoder();

const port = process.parentPort;

if (process.argv.includes(ENGINE_CHECK_ARGUMENT)) {
  answerEngineCheck(port, [ONNX_RUNTIME, TOKENIZERS]);
} else {
  serveCrossEncoder(crossEncoder, {
    onRequest: (listener) =>
      port.on("message", ({ data }: { data: CrossEncoderRequest }) => listener(data)),
    respond: (response) => port.postMessage(response),
  });
}
