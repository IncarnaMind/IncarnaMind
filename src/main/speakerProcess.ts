/**
 * The speaker pass's utility process (#138, see ./speakerSeparator): takes one request, clusters
 * the voices in its audio with src/core/transcription/diarization.ts, answers, and is stopped.
 * It runs at low priority, so the app and live transcription stay responsive.
 */
import { constants, setPriority } from "node:os";
import type { ClusteredVoices } from "../core";
import { answerEngineCheck, ENGINE_CHECK_ARGUMENT } from "../core/engineModules";
import { createSherpaClusterer, type SeparationRequest } from "../core/transcription/diarization";
import { SHERPA } from "../core/transcription/sherpa";

export type SeparationReply = { clustered: ClusteredVoices } | { message: string };

const parent = process.parentPort;

try {
  setPriority(constants.priority.PRIORITY_LOW);
} catch (error) {
  console.error("The speaker process couldn't lower its priority:", error);
}

if (process.argv.includes(ENGINE_CHECK_ARGUMENT)) {
  answerEngineCheck(parent, [SHERPA]);
} else {
  parent.once("message", ({ data }: { data: SeparationRequest }) => {
    void createSherpaClusterer()
      .then((cluster) => parent.postMessage({ clustered: cluster(data) } satisfies SeparationReply))
      .catch((error: unknown) =>
        parent.postMessage({
          message: error instanceof Error ? error.message : String(error),
        } satisfies SeparationReply),
      );
  });
}
