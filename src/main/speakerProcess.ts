/**
 * The speaker pass's utility process (#138, see ./speakerSeparator): takes one request, tells
 * the voices in its audio apart with src/core/transcription/diarization.ts, answers, and is
 * stopped. It runs at low priority, so the app and live transcription stay responsive.
 */
import { constants, setPriority } from "node:os";
import type { VoiceTurn } from "../core";
import { createSherpaSeparator, type SeparationRequest } from "../core/transcription/diarization";

export type SeparationReply = { turns: VoiceTurn[] } | { message: string };

const parent = process.parentPort;

try {
  setPriority(constants.priority.PRIORITY_LOW);
} catch (error) {
  console.error("The speaker process couldn't lower its priority:", error);
}

parent.once("message", ({ data }: { data: SeparationRequest }) => {
  void createSherpaSeparator()
    .then((separate) => parent.postMessage({ turns: separate(data) } satisfies SeparationReply))
    .catch((error: unknown) =>
      parent.postMessage({
        message: error instanceof Error ? error.message : String(error),
      } satisfies SeparationReply),
    );
});
