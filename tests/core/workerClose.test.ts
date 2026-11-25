import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { closeWorkerThread } from "../../src/core/workerClose";
import { answerEnded, citingModel, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { note, question, writeMind } from "../helpers/minds";

const EXAMPLES = resolve(__dirname, "../../resources/examples");

afterEach(() => {
  vi.useRealTimers();
});

describe("closeWorkerThread", () => {
  test("asks the worker to close cleanly, unrefs it, and skips terminate once it exits", () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const messages: unknown[] = [];
    const unref = vi.fn();
    const terminate = vi.fn(async () => 0);

    closeWorkerThread({
      postMessage: (value) => {
        messages.push(value);
      },
      terminate,
      unref,
      once: (event, listener) => emitter.once(event, listener),
    });

    expect(unref).toHaveBeenCalledTimes(1);
    expect(messages).toEqual([{ close: true }]);
    emitter.emit("exit", 0);
    vi.advanceTimersByTime(10_000);
    expect(terminate).not.toHaveBeenCalled();
  });

  test("falls back to terminate if a hung worker never exits", () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const terminate = vi.fn(async () => 0);

    closeWorkerThread({
      postMessage: () => undefined,
      terminate,
      unref: () => undefined,
      once: (event, listener) => emitter.once(event, listener),
    });

    expect(terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("falls back to terminate immediately if postMessage throws", () => {
    const emitter = new EventEmitter();
    const terminate = vi.fn(async () => 0);

    closeWorkerThread({
      postMessage: () => {
        throw new Error("port closed");
      },
      terminate,
      unref: () => undefined,
      once: (event, listener) => emitter.once(event, listener),
    });

    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

describe("core.close() while background work is in flight", () => {
  test("closing right after an Answer ends never reports database-is-not-open from judgement preparation", async () => {
    const reported: unknown[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      reported.push(args);
    });
    try {
      const model = citingModel({
        query: "tides",
        records: (passages) => [
          {
            marker: 1,
            passage: passages[0]?.id ?? "none",
            quote: "Spring tides happen at new moon and at full moon.",
          },
        ],
        answer: "Spring tides happen at new moon and at full moon.[^1]",
      });
      const { core, client, mind } = await setUpWithDocuments(model, [
        {
          name: "Tides.md",
          contents: "# Tides\n\nSpring tides happen at new moon and at full moon.\n",
        },
      ]);
      const asked = question("When do spring tides happen?");
      writeMind(client, [note("Notes."), asked]);
      await client.settled();
      const started = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
      if (!started.asked) throw new Error("The Question wasn't asked.");
      await answerEnded(core, started.answerId);

      // Close immediately while judgeAnswer is still preparing its model asynchronously.
      core.close();
      await new Promise((done) => setTimeout(done, 50));
      expect(reported).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("closing core mid-processing of example documents exits cleanly", async () => {
    for (let round = 0; round < 3; round += 1) {
      const dataDir = await createTempDataFolder();
      const core = startCore(dataDir, {
        paths: { dataDir, examples: EXAMPLES },
        systemLanguages: () => ["en-US"],
      });
      await core.createExamples();
      await new Promise((done) => setTimeout(done, 30));
      core.close();
    }
  });
});
