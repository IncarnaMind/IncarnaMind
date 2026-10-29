/**
 * The transcription utility process (#136): runs the speech-to-text engine
 * and Silero VAD off the main process (see ./transcriber), serving the
 * protocol in src/core/transcription/channel.ts, and the streams that go to a
 * cloud service with the User's key instead (#141).
 *
 * Started with --fake by the smoke tests' INCARNAMIND_TEST_TRANSCRIBER=fake
 * flag: it then runs the fake engine, with no model, and a pretend cloud
 * service, as --fake-options=<JSON> asks (slow, failing to read stretches,
 * failing over, the cloud dropping).
 */
import { answerEngineCheck, ENGINE_CHECK_ARGUMENT } from "../core/engineModules";
import {
  type CloudServing,
  serveTranscriber,
  type TranscriberPort,
  type TranscriberRequest,
} from "../core/transcription/channel";
import { connectWebSocket } from "../core/transcription/cloud/socket";
import {
  createFakeSpeechEngine,
  type FakeTranscriberOptions,
  failingOver,
} from "../core/transcription/fake";
import { createFakeCloud } from "../core/transcription/fakeCloud";
import {
  createSherpaEngine,
  createSileroDetectors,
  SHERPA,
  SHERPA_ADDON,
} from "../core/transcription/sherpa";

const fake = process.argv.includes("--fake");
const FAKE_OPTIONS = "--fake-options=";
const fakeOptions: FakeTranscriberOptions = JSON.parse(
  process.argv.find((each) => each.startsWith(FAKE_OPTIONS))?.slice(FAKE_OPTIONS.length) ?? "{}",
);
const parent = process.parentPort;

const port: TranscriberPort = {
  onRequest: (listener) =>
    parent.on("message", ({ data }: { data: TranscriberRequest }) => listener(data)),
  respond: (response) => parent.postMessage(response),
};

const cloud: CloudServing = fake
  ? {
      connect: createFakeCloud(fakeOptions.cloud),
      detectors: async () => createFakeSpeechEngine(fakeOptions).detector,
    }
  : { connect: connectWebSocket, detectors: createSileroDetectors };

if (process.argv.includes(ENGINE_CHECK_ARGUMENT)) {
  answerEngineCheck(parent, [SHERPA, SHERPA_ADDON]);
} else {
  serveTranscriber(
    fake ? async () => createFakeSpeechEngine(fakeOptions) : createSherpaEngine,
    fake && fakeOptions.failover ? failingOver(port, fakeOptions.failover) : port,
    cloud,
  );
}
