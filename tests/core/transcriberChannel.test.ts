import { describe, expect, test } from "vitest";
import type { TranscriptionModelFiles } from "../../src/core";
import {
  createChannelTranscriber,
  type TranscriberChannel,
  type TranscriberRequest,
  type TranscriberResponse,
} from "../../src/core/transcription/channel";

const files: TranscriptionModelFiles = {
  engine: "qwen3-asr",
  files: { encoder: "/tmp/encoder.onnx" },
  vad: "/tmp/vad.onnx",
  threads: 1,
};

/** A process for the channel: it records its requests, answers a load when asked to, and the test ends it. */
function fakeProcess({ answers }: { answers: boolean }) {
  const requests: TranscriberRequest[] = [];
  const responses = new Set<(response: TranscriberResponse) => void>();
  const exits = new Set<(code: number | null) => void>();
  const channel: TranscriberChannel = {
    send(request) {
      requests.push(request);
      if (answers && request.type === "load") {
        for (const listener of responses) listener({ type: "done", id: request.id });
      }
    },
    onResponse(listener) {
      responses.add(listener);
    },
    onExit(listener) {
      exits.add(listener);
    },
    stop() {},
  };
  return {
    channel,
    requests,
    exit(code: number | null) {
      for (const listener of exits) listener(code);
    },
  };
}

describe("The channel to the transcription process", () => {
  // protects=a load the idle unload ended before its answer is sent again, of the process it starts, so the Meeting loads (#2673); fails_when=the Meeting's load fails on a process that ended by design and the Meeting waits on Try again; no_claim=how long a real process takes to end.
  test("a load the idle unload caught in flight is asked again, and the Meeting's load succeeds", async () => {
    const first = fakeProcess({ answers: false });
    const second = fakeProcess({ answers: true });
    const processes = [first.channel, second.channel];
    let starts = 0;
    const transcriber = createChannelTranscriber(() => {
      const channel = processes[starts] ?? second.channel;
      starts++;
      return channel;
    });

    const loading = transcriber.load(files);
    expect(first.requests.map((request) => request.type)).toEqual(["load"]);
    first.exit(0);

    await expect(loading).resolves.toBeUndefined();
    expect(second.requests.map((request) => request.type)).toEqual(["load"]);
  });

  // protects=a load a crash ended is not asked again: the process is gone for another reason, and the Meeting says so (#2673); fails_when=a crash is retried as if it were the idle unload, hiding it.
  test("a load the process crashed on is not asked again", async () => {
    const first = fakeProcess({ answers: false });
    let starts = 0;
    const transcriber = createChannelTranscriber(() => {
      starts++;
      return first.channel;
    });

    const loading = transcriber.load(files);
    first.exit(1);

    await expect(loading).rejects.toThrow("exit code 1");
    expect(starts).toBe(1);
  });
});
