import { describe, expect, test } from "vitest";
import type { TranscriberListener, TranscriptionModelFiles } from "../../src/core";
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

/**
 * A process for the channel: it records its requests, answers a load when asked to, and the test
 * answers the rest with `answer` and ends it with `exit`.
 */
function fakeProcess({ answers }: { answers: boolean }) {
  const requests: TranscriberRequest[] = [];
  const responses = new Set<(response: TranscriberResponse) => void>();
  const exits = new Set<(code: number | null) => void>();
  let stopped = false;
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
    stop() {
      stopped = true;
    },
  };
  return {
    channel,
    requests,
    get stopped() {
      return stopped;
    },
    /** Answers every request it was sent that takes an answer, as done. */
    answer() {
      for (const request of requests) {
        if ("id" in request) {
          for (const listener of responses) listener({ type: "done", id: request.id });
        }
      }
    },
    exit(code: number | null) {
      for (const listener of exits) listener(code);
    },
  };
}

/** Starts the given processes in turn, the last again after them. */
function starting(...processes: ReturnType<typeof fakeProcess>[]) {
  let starts = 0;
  const start = () => {
    const next = processes[Math.min(starts, processes.length - 1)];
    starts++;
    if (!next) throw new Error("No process to start.");
    return next.channel;
  };
  return {
    start,
    get starts() {
      return starts;
    },
  };
}

/** A listener that keeps whether the engine was heard to stop or unload. */
function heard() {
  const told: string[] = [];
  const listener: TranscriberListener = {
    segment: () => {},
    progress: () => {},
    failed: () => {},
    stopped: (reason) => told.push(`stopped: ${reason}`),
    unloaded: () => told.push("unloaded"),
    switched: () => {},
    lost: () => {},
    opened: () => {},
  };
  return { listener, told };
}

describe("The channel to the transcription process", () => {
  // protects=a load the idle unload caught in flight is asked again, of the process it starts, so the Meeting loads (#2673); fails_when=the Meeting's load fails on a process that ended by design and the Meeting waits on Try again; no_claim=how long a real process takes to end.
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

  // protects=a load or a finish still out when the channel is closed fails as closed on purpose instead of waiting for ever, while one answered before stands (#2957); fails_when=either never settles, or fails as if the engine crashed; no_claim=how long a real process takes to stop.
  test("closed with a load and a finish out, both fail as closed on purpose; a load answered before stands", async () => {
    const first = fakeProcess({ answers: false });
    const transcriber = createChannelTranscriber(starting(first).start);
    const loaded = transcriber.load(files);
    first.answer();
    await expect(loaded).resolves.toBeUndefined();

    const finishing = expect(transcriber.finish("meeting:1:microphone")).rejects.toThrow(
      "The transcription model was stopped.",
    );
    const loading = expect(transcriber.load({ ...files, threads: 2 })).rejects.toThrow(
      "The transcription model was stopped.",
    );
    transcriber.close();

    await finishing;
    await loading;
    expect(first.stopped).toBe(true);
  });

  // protects=a closed process's late exit, a crash or an idle unload, fails only what was out on it: the next process's load is answered, and the Meeting hears nothing of the old one (#2957); fails_when=the old exit rejects the new load, or says the engine stopped or unloaded; no_claim=the order a real process's messages arrive in.
  test("a closed process's late exit leaves the next process's load, and is heard by no one", async () => {
    const first = fakeProcess({ answers: true });
    const second = fakeProcess({ answers: false });
    const { listener, told } = heard();
    const transcriber = createChannelTranscriber(starting(first, second).start);
    transcriber.listen(listener);
    await transcriber.load(files);
    transcriber.close();

    const loading = transcriber.load(files);
    first.exit(1);
    first.exit(0);
    second.answer();

    await expect(loading).resolves.toBeUndefined();
    expect(second.requests.map((request) => request.type)).toEqual(["load"]);
    expect(told).toEqual([]);
  });

  // protects=the idle unload behaves as before #2957: a finish out on the process that unloaded fails as an idle unload, not as a close or a crash, the Meeting hears it unloaded, and the next load starts a new process (#2673); fails_when=the idle unload is read as a crash or a close; no_claim=when a real process decides it is idle.
  test("an idle unload still fails what was out as an idle unload, and the next load starts a new process", async () => {
    const first = fakeProcess({ answers: true });
    const second = fakeProcess({ answers: true });
    const { listener, told } = heard();
    const processes = starting(first, second);
    const transcriber = createChannelTranscriber(processes.start);
    transcriber.listen(listener);
    await transcriber.load(files);

    const finishing = expect(transcriber.finish("meeting:1:microphone")).rejects.toThrow(
      "unloaded its models while idle",
    );
    first.exit(0);
    await finishing;
    expect(told).toEqual(["unloaded"]);

    await transcriber.load(files);
    expect(processes.starts).toBe(2);
    expect(second.requests.map((request) => request.type)).toEqual(["load"]);
  });
});
