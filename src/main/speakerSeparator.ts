/**
 * The core's `SpeakerSeparator` (#138): each request's voices are clustered in an Electron
 * utility process of its own (./speakerProcess), started for it and gone once it answers or is
 * aborted, so the pass's memory is freed and its CPU time never holds up live transcription. At
 * its peak the pass holds about 0.7 GB for half an hour of audio, 1 GB for an hour, 1.2 GB for
 * two and 1.6 GB for three (WINDOW_SECONDS in src/core/transcription/voiceprints.ts). A crash, out of memory included,
 * rejects, and the labels stay.
 */
import type { SpeakerSeparator } from "../core";
import { type EngineProcess, startEngineProcess } from "./engineProcess";
import type { SeparationReply } from "./speakerProcess";
import speakerProcessPath from "./speakerProcess?modulePath";

export const SPEAKER_PROCESS: EngineProcess = {
  modulePath: speakerProcessPath,
  serviceName: "IncarnaMind speakers",
};

export function createUtilityProcessSeparator(): SpeakerSeparator {
  return {
    cluster: (request, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const child = startEngineProcess(SPEAKER_PROCESS, []);
        // A process not spawned yet can't be killed: it is killed once it has.
        const stop = () => {
          if (!child.kill()) child.once("spawn", () => child.kill());
        };
        let answered = false;
        const abort = () => {
          if (answered) return;
          answered = true;
          stop();
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.on("message", (reply: SeparationReply) => {
          signal?.removeEventListener("abort", abort);
          stop();
          if (answered) return;
          answered = true;
          if ("clustered" in reply) resolve(reply.clustered);
          else reject(new Error(reply.message));
        });
        child.on("exit", (code) => {
          signal?.removeEventListener("abort", abort);
          if (answered) return;
          answered = true;
          reject(new Error(`The speaker process stopped (exit code ${code}).`));
        });
        child.postMessage(request);
      }),
  };
}
