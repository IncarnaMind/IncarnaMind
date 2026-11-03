import { randomUUID } from "node:crypto";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, Document, SaveChatProviderInput } from "../../src/core";
import {
  type BackgroundCall,
  type BackgroundJob,
  createBackgroundQueue,
} from "../../src/core/backgroundQueue";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { migrate, openDatabase } from "../../src/core/storage";
import { createTags } from "../../src/core/tags";
import type { TagClassifier } from "../../src/core/tags/classify";
import { createTagger } from "../../src/core/tags/tagger";
import { type FlowTag, flowNow, inFlow } from "../../src/core/timing/flows";
import {
  createTempDataFolder,
  nextEvent,
  nextTurn,
  startCore,
  turnOnAutomaticTagging,
} from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { question, writeMind } from "../helpers/minds";
import { controlledModel, scriptedModels } from "../helpers/models";
import { taggingModel, tagNamesOf, waitForTagging } from "../helpers/tags";

/** Lets every promise chain started so far run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A job the test ends by hand. Like a model call, a run stops when its signal aborts. */
interface TestJob extends BackgroundJob {
  /** Each run's call, in order. */
  readonly calls: BackgroundCall[];
  /** Ends the run in progress. */
  finish(): void;
  /** Makes the run in progress fail. */
  fail(error: Error): void;
}

/**
 * A job named `name` that writes what happens to it into `log`. `local`: it
 * says at once that its model call goes to a server on this computer.
 */
function testJob(log: string[], kind: string, name: string, { local = false } = {}): TestJob {
  const calls: BackgroundCall[] = [];
  let end: { resolve(): void; reject(error: unknown): void } | null = null;
  return {
    kind,
    calls,
    run(call) {
      calls.push(call);
      log.push(`${name} started`);
      if (local) call.runsLocally();
      return new Promise<void>((resolve, reject) => {
        const aborted = () => {
          log.push(`${name} aborted`);
          reject(call.signal.reason);
        };
        if (call.signal.aborted) {
          aborted();
          return;
        }
        call.signal.addEventListener("abort", aborted, { once: true });
        end = {
          resolve: () => {
            log.push(`${name} done`);
            resolve();
          },
          reject,
        };
      });
    },
    finish: () => end?.resolve(),
    fail: (error) => end?.reject(error),
  };
}

/** A queue that fails the test on any error it reports, unless `errors` collects them. */
function queueFor(errors?: unknown[]) {
  return createBackgroundQueue({
    reportError: (error) => {
      if (!errors) throw error;
      errors.push(error);
    },
  });
}

describe("The background model queue", () => {
  // protects=a job that starts as an Answer ends runs in no flow, so its requests aren't timed as that Answer's (#1624 review: tagging showed under the Answer's flow); fails_when=the job runs in the flow that let it start; no_claim=the timing records, which tests/core/aiTimings.test.ts covers.
  test("a job that starts as an Answer ends isn't that Answer's", async () => {
    const queue = createBackgroundQueue({ reportError: () => {} });
    const seen: (FlowTag | null)[] = [];
    queue.setAnswering(true);
    queue.add({
      kind: "tagging",
      run: async () => {
        seen.push(flowNow());
      },
    });
    inFlow("question", () => queue.setAnswering(false));
    await settle();
    expect(seen).toEqual([null]);
  });

  test("jobs run one at a time, in the order queued, whatever their kind", async () => {
    const log: string[] = [];
    const queue = queueFor();
    const tagA = testJob(log, "tagging", "tag A");
    const classify1 = testJob(log, "classification", "classify 1");
    const tagB = testJob(log, "tagging", "tag B");
    const classify2 = testJob(log, "classification", "classify 2");
    for (const job of [tagA, classify1, tagB, classify2]) queue.add(job);

    expect(log).toEqual(["tag A started"]);
    for (const job of [tagA, classify1, tagB, classify2]) {
      await settle();
      job.finish();
    }
    await settle();

    expect(log).toEqual([
      "tag A started",
      "tag A done",
      "classify 1 started",
      "classify 1 done",
      "tag B started",
      "tag B done",
      "classify 2 started",
      "classify 2 done",
    ]);
  });

  test("a job that fails, or throws, is reported, and the next one runs", async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const queue = queueFor(errors);
    const failing = testJob(log, "tagging", "tag A");
    const throwing: BackgroundJob = {
      kind: "classification",
      run: () => {
        throw new Error("Not even started.");
      },
    };
    const next = testJob(log, "tagging", "tag B");
    for (const job of [failing, throwing, next]) queue.add(job);

    failing.fail(new Error("The model is down."));
    await settle();

    expect(errors).toEqual([new Error("The model is down."), new Error("Not even started.")]);
    expect(log).toEqual(["tag A started", "tag B started"]);
  });

  test("while an Answer is being written, no job starts; they run once none is", async () => {
    const log: string[] = [];
    const queue = queueFor();
    queue.setAnswering(true);
    const tagA = testJob(log, "tagging", "tag A", { local: true });
    const classify1 = testJob(log, "classification", "classify 1");
    queue.add(tagA);
    queue.add(classify1);
    await settle();
    expect(log).toEqual([]);

    queue.setAnswering(false);
    await settle();
    expect(log).toEqual(["tag A started"]);
    tagA.finish();
    await settle();
    expect(log).toEqual(["tag A started", "tag A done", "classify 1 started"]);
  });

  test("an Answer starting aborts a job in flight on a local model server; it runs again first once the Answer is done", async () => {
    const log: string[] = [];
    const queue = queueFor();
    const tagA = testJob(log, "tagging", "tag A", { local: true });
    const classify1 = testJob(log, "classification", "classify 1");
    queue.add(tagA);
    queue.add(classify1);

    queue.setAnswering(true);
    await settle();
    expect(log).toEqual(["tag A started", "tag A aborted"]);
    expect(tagA.calls[0]?.gaveWay).toBe(true);

    queue.setAnswering(false);
    await settle();
    // Queued again at the front: before the job that was waiting behind it.
    expect(log).toEqual(["tag A started", "tag A aborted", "tag A started"]);
    expect(tagA.calls[1]?.gaveWay).toBe(false);
    tagA.finish();
    await settle();
    expect(log.slice(3)).toEqual(["tag A done", "classify 1 started"]);
  });

  test("a job in flight on a cloud provider finishes while the Answer is written; the next waits for it", async () => {
    const log: string[] = [];
    const queue = queueFor();
    const tagA = testJob(log, "tagging", "tag A");
    const classify1 = testJob(log, "classification", "classify 1");
    queue.add(tagA);
    queue.add(classify1);

    queue.setAnswering(true);
    await settle();
    expect(tagA.calls[0]?.signal.aborted).toBe(false);
    tagA.finish();
    await settle();
    expect(log).toEqual(["tag A started", "tag A done"]);

    queue.setAnswering(false);
    await settle();
    expect(log).toEqual(["tag A started", "tag A done", "classify 1 started"]);
  });

  test("a job that finds its call goes to a local server while an Answer is written gives way at once", async () => {
    const log: string[] = [];
    const queue = queueFor();
    const tagA = testJob(log, "tagging", "tag A");
    queue.add(tagA);
    queue.setAnswering(true);
    await settle();
    expect(log).toEqual(["tag A started"]);

    // E.g. it was still choosing its model when the Answer started.
    tagA.calls[0]?.runsLocally();
    await settle();
    expect(log).toEqual(["tag A started", "tag A aborted"]);

    queue.setAnswering(false);
    await settle();
    expect(tagA.calls).toHaveLength(2);
  });

  test("while a Meeting records, no job starts and a local one in flight gives way; they go on once it pauses or stops", async () => {
    const log: string[] = [];
    const queue = queueFor();
    const tagA = testJob(log, "tagging", "tag A", { local: true });
    const classify1 = testJob(log, "classification", "classify 1");
    queue.add(tagA);
    queue.add(classify1);

    queue.setRecording(true);
    await settle();
    expect(log).toEqual(["tag A started", "tag A aborted"]);
    // An Answer ending while the Meeting still records starts nothing.
    queue.setAnswering(true);
    queue.setAnswering(false);
    await settle();
    expect(log).toHaveLength(2);

    queue.setRecording(false);
    await settle();
    expect(log).toEqual(["tag A started", "tag A aborted", "tag A started"]);
    tagA.finish();
    await settle();
    expect(log.slice(3)).toEqual(["tag A done", "classify 1 started"]);
  });

  test("closing aborts the job in flight and drops the rest", async () => {
    const log: string[] = [];
    const queue = queueFor();
    const tagA = testJob(log, "tagging", "tag A", { local: true });
    const classify1 = testJob(log, "classification", "classify 1");
    queue.add(tagA);
    queue.add(classify1);

    queue.close();
    queue.setAnswering(true);
    queue.setAnswering(false);
    queue.add(testJob(log, "tagging", "tag B"));
    await settle();

    expect(log).toEqual(["tag A started", "tag A aborted"]);
    expect(tagA.calls[0]?.gaveWay).toBe(false);
  });
});

describe("Automatic tagging in the background queue", () => {
  test("tagging takes one turn per Document, so other jobs queued meanwhile go in between", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const now = () => new Date().toISOString();
    const tags = createTags(db, now);
    tags.seedPresets("en");
    for (const name of ["A", "B", "C"]) {
      db.run(
        `INSERT INTO documents (id, content_hash, name, kind, size, status, created_at, updated_at)
         VALUES (?, ?, ?, 'text', 1, 'ready', ?, ?)`,
        [randomUUID(), randomUUID(), name, now(), now()],
      );
    }
    const log: string[] = [];
    let running = 0;
    let mostAtOnce = 0;
    /** Ends the model call in progress. */
    let answer = () => {};
    const classifier: TagClassifier = {
      local: true,
      decide: ({ excerpt }) => {
        log.push(`tag ${excerpt.name}`);
        running++;
        mostAtOnce = Math.max(mostAtOnce, running);
        return new Promise((resolve) => {
          answer = () => {
            running--;
            resolve({ decisions: [], newTags: [] });
          };
        });
      },
    };
    const background = queueFor();
    const tagger = createTagger({
      db,
      now,
      tags,
      background,
      maySend: () => true,
      stopped: () => false,
      canRun: async () => true,
      mightBeReady: () => true,
      prepare: async () => classifier,
      announce: () => {},
      reportError: (error) => {
        throw error;
      },
      rateLimit: {
        pausedUntil: () => null,
        pause: () => null,
        succeeded: () => {},
        refusal: () => null,
        refuse: () => null,
      },
      timers: { now: () => 0, sleep: async () => {} },
    });
    /** A classification job, as Organize queues: one model call, which answers at once. */
    const classifying = (name: string): BackgroundJob => ({
      kind: "classification",
      run: async () => {
        log.push(`classify ${name}`);
        running++;
        mostAtOnce = Math.max(mostAtOnce, running);
        await Promise.resolve();
        running--;
      },
    });

    tagger.start();
    await settle();
    expect(log).toEqual(["tag A"]);
    background.add(classifying("1"));
    answer();
    await settle();
    expect(log).toEqual(["tag A", "classify 1", "tag B"]);
    background.add(classifying("2"));
    answer();
    await settle();
    answer();
    await settle();

    expect(log).toEqual(["tag A", "classify 1", "tag B", "classify 2", "tag C"]);
    expect(mostAtOnce).toBe(1);
    expect(db.all("SELECT tagging_status FROM documents")).toEqual(
      Array(3).fill({ tagging_status: "tagged" }),
    );
    tagger.close();
    background.close();
    db.close();
  });
});

const PAPER_TEXT = `Attention Is All You Need

Abstract. We propose a new simple network architecture, the Transformer, based solely on
attention mechanisms.`;

const LOCAL: SaveChatProviderInput = { kind: "ollama", modelId: "local-model" };
/** Another model server on this computer, e.g. LM Studio's. */
const LOCAL_SERVER: SaveChatProviderInput = {
  kind: "openai-compatible",
  baseUrl: "http://localhost:1234/v1",
  modelId: "local-model",
};
const OPENAI: SaveChatProviderInput = {
  kind: "openai",
  apiKey: "sk-test-openai",
  modelId: "gpt-5.4-mini",
};

/**
 * One chat model for both: Answers the test writes by hand, and tagging that
 * chooses "Paper", can be held, and stops when its request is aborted, as a
 * real provider's request does.
 */
function answeringAndTagging() {
  const answers = controlledModel();
  const tagging = taggingModel(["Paper"]);
  let aborted = 0;
  const model = new MockLanguageModelV4({
    doStream: (options) => answers.model.doStream(options),
    doGenerate: (options) =>
      new Promise((resolve, reject) => {
        const signal = options.abortSignal;
        const abort = () => {
          aborted++;
          reject(signal?.reason);
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve(tagging.model.doGenerate(options))
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", abort));
      }),
  });
  return {
    model,
    answers,
    tagging,
    /** How many tagging requests were aborted. */
    get aborted() {
      return aborted;
    },
  };
}

/** A core with `provider` set up (every data flow allowed), and a Mind with a Question to ask. */
async function setUp(provider: SaveChatProviderInput) {
  const fake = answeringAndTagging();
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(fake.model).createChatModel,
    audioCapture: createFakeCapture(),
  });
  core.on("consent.requested", ({ requestId }) => void core.respondToConsent(requestId, true));
  await core.saveChatProvider(provider);
  await turnOnAutomaticTagging(core);
  const mind = await core.createMind({ title: "Tides" });
  const writer = await connectToMind(core, mind.id);
  const asked = question("What is attention?");
  writeMind(writer, [asked]);
  await writer.settled();
  /** Asks the Question; resolves once its Answer is being written. */
  const ask = async () => {
    const result = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
    if (!result.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(result)}`);
    await fake.answers.requested();
  };
  /** Writes the Answer and resolves once it is done. */
  const finishAnswer = async () => {
    const finished = nextEvent(core, "answer.finished");
    fake.answers.push("Attention weighs every word against the others.");
    fake.answers.finish();
    expect(await finished).toMatchObject({ status: "done" });
  };
  return { core, fake, ask, finishAnswer };
}

/** Adds one text Document and waits until it is processed (ready). */
async function addDocument(core: Core): Promise<Document> {
  const sources = await createTempDataFolder();
  const [document] = await addAndProcess(core, [
    await writeSourceFile(sources, "Attention.md", PAPER_TEXT),
  ]);
  if (!document) throw new Error("Nothing was added.");
  return document;
}

/** The tagging state the core lists for a Document now. */
const taggingOf = async (core: Core, documentId: string) =>
  (await core.listDocuments()).find((each) => each.id === documentId)?.tagging;

describe("Background work gives way to Answers", { timeout: 30_000 }, () => {
  test("while an Answer is written, a new Document waits to be tagged, and is tagged once it is done", async () => {
    const { core, fake, ask, finishAnswer } = await setUp(LOCAL);
    await ask();

    const document = await addDocument(core);
    await nextTurn();
    expect(fake.tagging.requests).toEqual([]);
    expect(await taggingOf(core, document.id)).toBe("pending");

    await finishAnswer();
    await waitForTagging(core, [document.id]);
    expect(fake.tagging.requests).toHaveLength(1);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test.each([
    ["in Ollama", LOCAL],
    ["on another local server", LOCAL_SERVER],
  ])(
    "an Answer starting aborts a tagging call to a model %s, which runs again once the Answer is done",
    async (_, provider) => {
      const { core, fake, ask, finishAnswer } = await setUp(provider);
      fake.tagging.hold();
      const document = await addDocument(core);
      await fake.tagging.requested();
      expect(await taggingOf(core, document.id)).toBe("tagging");

      const waiting = waitForTagging(core, [document.id], (each) => each.tagging === "pending");
      await ask();
      await waiting;
      expect(fake.aborted).toBe(1);
      // Not tried again while the Answer is written.
      await nextTurn();
      expect(fake.tagging.requests).toHaveLength(1);

      await finishAnswer();
      await fake.tagging.requested(2);
      fake.tagging.release();
      await waitForTagging(core, [document.id]);
      expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
      expect(fake.tagging.requests).toHaveLength(2);
      expect(fake.aborted).toBe(1);
    },
  );

  test("a Meeting starting stops a tagging call to a local model, which runs again once it stops", async () => {
    const { core, fake } = await setUp(LOCAL);
    await core.updateSettings({ device: { meetingNoticeAccepted: true } });
    fake.tagging.hold();
    const document = await addDocument(core);
    await fake.tagging.requested();

    const waiting = waitForTagging(core, [document.id], (each) => each.tagging === "pending");
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await waiting;
    expect(fake.aborted).toBe(1);
    // Not tried again while the Meeting records.
    await nextTurn();
    expect(fake.tagging.requests).toHaveLength(1);

    await core.stopMeeting(meeting.id);
    await fake.tagging.requested(2);
    fake.tagging.release();
    await waitForTagging(core, [document.id]);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);
  });

  test("on a cloud provider, the tagging call in flight finishes while the Answer is written", async () => {
    const { core, fake, ask, finishAnswer } = await setUp(OPENAI);
    fake.tagging.hold();
    const document = await addDocument(core);
    await fake.tagging.requested();

    await ask();
    fake.tagging.release();
    await waitForTagging(core, [document.id]);
    expect(fake.aborted).toBe(0);
    expect(fake.tagging.requests).toHaveLength(1);
    expect(await tagNamesOf(core, document.id)).toEqual(["Paper"]);

    await finishAnswer();
  });
});
