/**
 * The assistant writing cited sentences into a Note, each checked by a scripted model on a scripted
 * key, for the written check's key cells (#2532, #2944): when each check request was sent, which
 * the key refused, and the marks that landed, on a clock the test moves.
 */
import { vi } from "vitest";
import { CLAIM_TIME_LIMIT_MS } from "../../src/core/answers/checks/runCheck";
import type { PaceTimers } from "../../src/core/sources/pace";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant } from "./assistant";
import { checkReply, isCheckRun, type Plan, sentenceOf } from "./checks";
import { shownPassages } from "./citations";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, writeSourceFile } from "./documents";
import { connectToMind, type MindClient } from "./mindClient";
import { readMind } from "./minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "./models";
import { type KeyShape, scriptedKey } from "./scriptedKeys";

/** The words of the write's sentence `n`, from 1, which the tide table's line `n` states. */
const words = (n: number) => `Spring tide ${n} comes at new and full moon`;

/** The tide table: a line for each sentence a write can hold. */
const LINES = Array.from({ length: 30 }, (_, index) => `${words(index + 1)}.`);

/** Sentence `n` as its check reads it: its Citation left out before the full stop. */
const asChecked = (n: number) => `${words(n)} .`;

const PLANS: Record<string, Plan> = Object.fromEntries(
  LINES.map((line, index) => [
    asChecked(index + 1),
    { verdict: "supported", quote: line, says: line },
  ]),
);

/** Which of the write's sentences a check request is for, from 1. */
const numberOf = (call: ModelCall) => Number(/Spring tide (\d+) /.exec(sentenceOf(call))?.[1]);

/**
 * The assistant writes `count` cited sentences, each its own paragraph, into a new Note each time
 * `write` is called, in one session; each check replies as `PLANS` says, unless `hold` holds or
 * replaces its reply.
 */
async function writeChecked(
  count: number,
  hold: (call: ModelCall, reply: ScriptedReply) => ScriptedReply,
  timers: PaceTimers,
) {
  const content = Array.from(
    { length: count },
    (_, index) => `${words(index + 1)} [^${index + 1}].`,
  ).join("\n\n");
  const model = scriptedModel(
    (call): ScriptedReply => {
      if (isCheckRun(call)) return hold(call, checkReply(call, PLANS));
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return { calls: [{ tool: "search_documents", input: { query: "spring tides" } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const shown = shownPassages(search.text);
        const citations = LINES.slice(0, count).map((quote, index) => ({
          marker: index + 1,
          passage: shown.find((passage) => passage.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return { calls: [{ tool: "add_to_mind", input: { content } }] };
      return { text: "Wrote it from your Documents." };
    },
    { generate: judgesNothing },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    paceTimers: timers,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  for (const flow of ["chat", "checks"] as const) {
    if (saved.service) await core.allowDataFlow(flow, saved.service.id);
  }
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.md", `# Tides\n\n${LINES.join("\n\n")}\n`),
  ]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  let notes = 0;
  return {
    /** The write into a new Note of the session, which it gives once written. */
    async write(): Promise<MindClient> {
      notes++;
      const into = await core.createMind({ title: `Harbour notes ${notes}`, folderId: folder.id });
      const note = await connectToMind(core, into.id);
      await askAssistant(core, {
        text: "Add a short note on tides to this Mind",
        mindId: into.id,
        scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      });
      return note;
    },
  };
}

/** Each written sentence's mark on the page, by its number: its state, or Not checked's reason. */
function marksOf(client: MindClient): Map<number, string> {
  return new Map(
    claimSpans(readMind(client)).flatMap((span) => {
      const n = Number(/Spring tide (\d+) /.exec(span.sentence.text)?.[1]);
      if (Number.isNaN(n)) return [];
      const { state, reason } = span.check;
      return [[n, state === "not-checked" ? `not-checked: ${reason ?? ""}` : state] as const];
    }),
  );
}

/** Lets every callback already due run: a request that was about to go out has. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** The longest timer `virtualClock` leaves to the computer's own clock: the test's own waits. */
const OWN_TIMER_MS = 50;

/** Where the AI SDK waits before it sends a refused request again. */
const SDK_WAIT = "@ai-sdk/provider-utils";

/**
 * A clock the test moves on by hand: a scripted reply that takes `ms` waits for it, and so do the
 * run's pauses and the AI SDK's own waits before it sends a refused request again; a check's time
 * limit never comes. Time moves only once all the work that can go on without it has, so the
 * times a run gets don't depend on this computer.
 */
function virtualClock() {
  let now = 0;
  const due: { at: number; fire(): void }[] = [];
  const after = (ms: number) =>
    new Promise<void>((resolve) => {
      due.push({ at: now + ms, fire: resolve });
    });
  const timers: PaceTimers = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const entry = { at: now + Math.max(0, ms), fire: () => resolve() };
        if (ms < CLAIM_TIME_LIMIT_MS) due.push(entry);
        signal.addEventListener(
          "abort",
          () => {
            const at = due.indexOf(entry);
            if (at >= 0) due.splice(at, 1);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
  /** The AI SDK waits on `setTimeout` before it sends a refused request again: on this clock too. */
  const ownTimers = () => {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const virtual = new Set<{ at: number; fire(): void }>();
    const set = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      run: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if ((ms ?? 0) <= OWN_TIMER_MS || !new Error().stack?.includes(SDK_WAIT)) {
        return realSet(run, ms, ...args);
      }
      const entry = {
        at: now + (ms ?? 0),
        fire: () => {
          virtual.delete(entry);
          run();
        },
        unref: () => entry,
        ref: () => entry,
        hasRef: () => false,
      };
      virtual.add(entry);
      due.push(entry);
      return entry;
    }) as unknown as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
      timer: Parameters<typeof clearTimeout>[0],
    ) => {
      const entry = [...virtual].find((each) => each === (timer as unknown));
      if (!entry) return realClear(timer);
      virtual.delete(entry);
      const at = due.indexOf(entry);
      if (at >= 0) due.splice(at, 1);
    }) as typeof clearTimeout);
    return () => {
      set.mockRestore();
      clear.mockRestore();
    };
  };
  return {
    timers,
    after,
    now: () => now,
    /** Runs `work` to its end, moving the clock to the next thing due whenever nothing else can go on. */
    async until<T>(work: () => Promise<T>): Promise<T> {
      const restore = ownTimers();
      try {
        let done = false;
        const result = work().finally(() => {
          done = true;
        });
        while (!done) {
          await settle();
          if (done || due.length === 0) continue;
          now = Math.min(...due.map((each) => each.at));
          for (const each of due.filter((entry) => entry.at <= now)) {
            due.splice(due.indexOf(each), 1);
            each.fire();
          }
        }
        return await result;
      } finally {
        restore();
      }
    },
  };
}

/** One write on a scripted key: when it ended, what was refused, and what each mark came to. */
export interface KeyWrite {
  end: number;
  refused: number;
  sent: number;
  marks: Record<string, number>;
  /** Its check requests, refused ones too, in the order sent: each sentence's number and turn. */
  order: string[];
  /** The same, each with when it was sent from the write's start, in ms, and "refused" for one refused. */
  timeline: string[];
}

/**
 * `writes` writes of `count` sentences, one after another in one session, checked as the app
 * checks them, on a key shaped as `key`: each check request takes `replyMs`, and one the key has
 * no room for is refused as the provider refuses it, an HTTP 429 the AI SDK may send again.
 */
export async function keyWrites(
  count: number,
  replyMs: number,
  key: KeyShape,
  writes = 2,
): Promise<KeyWrite[]> {
  const clock = virtualClock();
  const scripted = scriptedKey(key, replyMs);
  let refused = 0;
  let sent = 0;
  let started = 0;
  const order: string[] = [];
  const timeline: string[] = [];
  const { write } = await writeChecked(
    count,
    (call, planned) => {
      const answer = scripted.send(clock.now());
      const request = `${numberOf(call)}:${call.results.length}`;
      order.push(request);
      timeline.push(`${clock.now() - started} ${request}${answer.fits ? "" : " refused"}`);
      if (!answer.fits) {
        refused++;
        return {
          error: {
            status: 429,
            message: "Rate limit reached.",
            retryable: true,
            ...(answer.retryAfter !== null && { retryAfter: String(answer.retryAfter) }),
          },
        };
      }
      sent++;
      const given = clock.after(replyMs).then(() => scripted.replied());
      return { ...planned, pause: { after: 0, until: given } };
    },
    clock.timers,
  );
  const results: KeyWrite[] = [];
  for (let each = 0; each < writes; each++) {
    const before = { refused, sent, order: order.length, timeline: timeline.length };
    scripted.newWrite();
    started = clock.now();
    const note = await clock.until(write);
    const marks: Record<string, number> = {};
    for (const mark of marksOf(note).values()) marks[mark] = (marks[mark] ?? 0) + 1;
    results.push({
      end: clock.now() - started,
      refused: refused - before.refused,
      sent: sent - before.sent,
      marks,
      order: order.slice(before.order),
      timeline: timeline.slice(before.timeline),
    });
  }
  return results;
}
