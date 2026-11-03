/**
 * The core's `SpeakerSeparator` (#138): each Meeting's voices are told apart in an Electron
 * utility process of its own (./speakerProcess), started for it and gone once it answers, so
 * the pass's memory is freed and its CPU time never holds up live transcription. At its peak
 * the pass holds about 0.7 GB for half an hour of audio, 1 GB for an hour, 1.2 GB for two and
 * 1.6 GB for three (WINDOW_SECONDS in diarization.ts). A crash, out of memory included, rejects,
 * and the labels stay.
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
    separate: (request) =>
      new Promise((resolve, reject) => {
        const child = startEngineProcess(SPEAKER_PROCESS, []);
        let answered = false;
        child.on("message", (reply: SeparationReply) => {
          answered = true;
          child.kill();
          if ("turns" in reply) resolve(reply.turns);
          else reject(new Error(reply.message));
        });
        child.on("exit", (code) => {
          if (!answered) reject(new Error(`The speaker process stopped (exit code ${code}).`));
        });
        child.postMessage(request);
      }),
  };
}
