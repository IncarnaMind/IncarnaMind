/**
 * The assistant writing cited sentences into a Note, each checked by a scripted model, for the
 * written check's tests (#2532, #2944): what each check sent and when, the marks it landed, and a
 * clock the test moves, with a key that refuses as a provider's rate limit does.
 */
import { vi } from "vitest";
import type { CoreAdapters } from "../../src/core";
import { CLAIM_TIME_LIMIT_MS } from "../../src/core/answers/checks/runCheck";
import type { PaceTimers } from "../../src/core/sources/pace";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant } from "./assistant";
import { checkReply, isCheckRun, type Plan, sentenceOf } from "./checks";
import { shownPassages } from "./citations";
import { createTempDataFolder, startCore } from "./core";
import { addAndProcess, writeSourceFile } from "./documents";
import { checkClock } from "./heldClock";
import { connectToMind, type MindClient } from "./mindClient";
import { readMind } from "./minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "./models";

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

export const TWELVE_SUPPORTED = Array.from({ length: 12 }, () => "supported");

/** A Question the scripted assistant answers in its conversation, citing the sentences it would write. */
const ANSWERED = "Tell me about the spring tides";

/** Which of the write's sentences a check request is for, from 1. */
export const numberOf = (call: ModelCall) =>
  Number(/Spring tide (\d+) /.exec(sentenceOf(call))?.[1]);

export const isFirstTurn = (call: ModelCall) => call.results.length === 0;

export const isVerdict = (reply: ScriptedReply) =>
  "text" in reply && typeof reply.text === "string" && reply.text.startsWith("Verdict");

/** One sentence's check starting (its first request) or ending (its verdict given), in order. */
export type Event =
  | { kind: "start"; n: number; running: number }
  | { kind: "verdict"; n: number }
  | { kind: "limited"; n: number };

/** What a write's checks did: each check's start and end in order, and each one's requests. */
export interface Seen {
  events: Event[];
  running: Set<number>;
  most: number;
  sent: Map<number, string[]>;
  /** Every check request in the order it was sent: its sentence and turn. */
  order: string[];
}

export const startsOf = (seen: Seen) =>
  seen.events.flatMap((event) => (event.kind === "start" ? [event.n] : []));

export const indexOf = (seen: Seen, kind: Event["kind"], n: number, nth = 1) => {
  let found = 0;
  return seen.events.findIndex((event) => event.kind === kind && event.n === n && ++found === nth);
};

/**
 * The assistant writes `count` cited sentences into a Note, each its own paragraph, checked
 * `atOnce` at a time; each check replies as `PLANS` says, unless `hold` holds or replaces it.
 * `write` writes them into a new Note of the same session, and gives that Note. `answer` replies
 * to any other Question the test asks, where it gives a reply.
 */
export async function writeChecked(
  count: number,
  atOnce: number,
  hold: (call: ModelCall, reply: ScriptedReply, seen: Seen) => ScriptedReply = (_, reply) => reply,
  adapters: Partial<CoreAdapters> = {},
  answer: (call: ModelCall) => ScriptedReply | null = () => null,
) {
  const seen: Seen = { events: [], running: new Set(), most: 0, sent: new Map(), order: [] };
  const content = Array.from(
    { length: count },
    (_, index) => `${words(index + 1)} [^${index + 1}].`,
  ).join("\n\n");
  const model = scriptedModel(
    (call): ScriptedReply => {
      if (isCheckRun(call)) {
        const n = numberOf(call);
        seen.sent.set(n, [
          ...(seen.sent.get(n) ?? []),
          [call.system, call.tools.join(","), call.prompt].join("\n"),
        ]);
        seen.order.push(`${n}:${call.results.length}`);
        if (isFirstTurn(call)) {
          seen.running.add(n);
          seen.events.push({ kind: "start", n, running: seen.running.size });
          seen.most = Math.max(seen.most, seen.running.size);
        }
        const reply = hold(call, checkReply(call, PLANS), seen);
        if ("error" in reply) seen.events.push({ kind: "limited", n });
        if (isVerdict(reply)) {
          // A held verdict ends its check only once it is given.
          const given = "pause" in reply && reply.pause ? reply.pause.until : Promise.resolve();
          void given.then(() => {
            seen.events.push({ kind: "verdict", n });
            seen.running.delete(n);
          });
        }
        return reply;
      }
      const other = answer(call);
      if (other) return other;
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
      // Asked in a conversation, it answers there, its sentences cited, and they are checked there.
      if (call.prompt.includes(ANSWERED)) return { text: content.replaceAll("\n\n", " ") };
      if (!call.results.some((result) => result.tool === "add_to_mind"))
        return { calls: [{ tool: "add_to_mind", input: { content } }] };
      return { text: "Wrote it from your Documents." };
    },
    { generate: judgesNothing },
  );
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), {
    createChatModel: models.createChatModel,
    modelFacts: () => ({ writtenChecksAtOnce: atOnce }),
    paceTimers: checkClock().timers,
    ...adapters,
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
  const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  await client.settled();
  const askInto = (mindId: string) =>
    askAssistant(core, {
      text: "Add a short note on tides to this Mind",
      mindId,
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
    });
  let notes = 1;
  return {
    core,
    seen,
    client,
    ask: () => askInto(mind.id),
    folderId: folder.id,
    /** Every request the model was sent, as the AI SDK sent it, and each model asked for. */
    sent: () => ({
      streamed: model.doStreamCalls,
      generated: model.doGenerateCalls,
      models: models.specs.map((spec) => spec.modelId),
    }),
    /** The same sentences answered in a conversation, cited, so the Answer's own check reads them. */
    answer: () =>
      askAssistant(core, {
        text: ANSWERED,
        scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      }),
    /** Asks for the write into the Note, and gives the Answer as it starts. */
    start: async () => {
      const asked = await core.askInConversation({
        text: "Add a short note on tides to this Mind",
        mindId: mind.id,
        scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      });
      if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
      return { mindId: mind.id, answerId: asked.answerId, conversationId: asked.conversation.id };
    },
    /** The same write into another Note of the same session. */
    askAnother: async () =>
      askInto((await core.createMind({ title: "More harbour notes", folderId: folder.id })).id),
    /** The same write into a new Note of the same session, which it gives once written. */
    async write(): Promise<MindClient> {
      notes++;
      const into = await core.createMind({ title: `Harbour notes ${notes}`, folderId: folder.id });
      const note = await connectToMind(core, into.id);
      await askInto(into.id);
      return note;
    },
  };
}

/** Each written sentence's mark on the page, by its number: its state, or Not checked's reason. */
export function marksOf(client: MindClient): Map<number, string> {
  return new Map(
    claimSpans(readMind(client)).flatMap((span) => {
      const n = Number(/Spring tide (\d+) /.exec(span.sentence.text)?.[1]);
      if (Number.isNaN(n)) return [];
      const { state, reason } = span.check;
      return [[n, state === "not-checked" ? `not-checked: ${reason ?? ""}` : state] as const];
    }),
  );
}

/** A promise, and the function that resolves it. */
export function gate() {
  let open: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open };
}

export const waitUntil = (condition: () => void) =>
  vi.waitFor(condition, { timeout: 20_000, interval: 5 });

/** Lets every callback already due run: a request that was about to go out has. */
export const settle = async () => {
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
export function virtualClock() {
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
    /**
     * Runs `work` to its end, moving the clock to the next thing due whenever nothing else can go
     * on; `beforeMove` runs first each time, given when the clock moves to.
     */
    async until<T>(work: () => Promise<T>, beforeMove?: (to: number) => Promise<void>): Promise<T> {
      const restore = ownTimers();
      try {
        let done = false;
        const result = work().finally(() => {
          done = true;
        });
        while (!done) {
          await settle();
          if (done) break;
          if (due.length === 0) continue;
          if (beforeMove) {
            await beforeMove(Math.min(...due.map((each) => each.at)));
            await settle();
            if (done || due.length === 0) continue;
          }
          const next = Math.min(...due.map((each) => each.at));
          now = next;
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

/**
 * How a scripted key refuses, as the provider answers a rate limit (an HTTP 429 the AI SDK may send
 * again):
 * - `bucket`: a bucket of `holds` requests refilled `refillsPerReply` a reply's time, whose refusal
 *   says how long until there is room, as Anthropic's token bucket does. With `countsRefused`, a
 *   refused request takes its room too, as OpenAI says ("unsuccessful requests contribute to your
 *   per-minute limit"): the bucket goes below empty, and the refusal says how long until a request
 *   fits again;
 * - `at-once`: `atOnce` requests out at a time, whose refusal says nothing of how long;
 * - `tokens`: a provider's published limits a minute (`requests`, `input` tokens, `output` tokens:
 *   null for none of its own), each a bucket holding `minutes` of it; each request costs `costs`
 *   tokens in and out, the first of a write `firstCosts` in (its prompt's cache written), and its
 *   refusal says how long until there is room.
 */
export type KeyShape =
  | { kind: "bucket"; holds: number; refillsPerReply: number; countsRefused?: true }
  | { kind: "at-once"; atOnce: number }
  | {
      kind: "tokens";
      requests: number;
      input: number;
      output: number | null;
      minutes: number;
      costs: { input: number; output: number };
      firstCosts: number;
    };

/** One write of a key-shaped run: when it ended, what was refused, and what each mark came to. */
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

/** A bucket refilled at `perMs` a ms up to `holds`, from full. */
function bucket(holds: number, perMs: number) {
  let level = holds;
  let at = 0;
  return {
    level(now: number) {
      level = Math.min(holds, level + (now - at) * perMs);
      at = now;
      return level;
    },
    take(amount: number) {
      level -= amount;
    },
    /** How long from now until it holds `amount`, in ms. */
    until(now: number, amount: number) {
      const short = amount - this.level(now);
      return short <= 0 ? 0 : short / perMs;
    },
  };
}

/**
 * `writes` writes of `count` sentences, one after another in one session, checked `atOnce` at a
 * time, on a key shaped as `key`: each check request takes `replyMs`, and one the key has no room
 * for is refused as the provider refuses it.
 */
export async function keyWrites(
  count: number,
  atOnce: number,
  replyMs: number,
  key: KeyShape,
  writes = 2,
): Promise<KeyWrite[]> {
  const clock = virtualClock();
  let refused = 0;
  let sent = 0;
  let out = 0;
  let firstOfWrite = true;
  let started = 0;
  const timeline: string[] = [];
  const minute = 60_000;
  const requests =
    key.kind === "bucket"
      ? bucket(key.holds, key.refillsPerReply / replyMs)
      : key.kind === "tokens"
        ? bucket(key.requests * key.minutes, key.requests / minute)
        : null;
  const input = key.kind === "tokens" ? bucket(key.input * key.minutes, key.input / minute) : null;
  const output =
    key.kind === "tokens" && key.output !== null
      ? bucket(key.output * key.minutes, key.output / minute)
      : null;
  const refusal = (waitMs: number | null): ScriptedReply => {
    refused++;
    return {
      error: {
        status: 429,
        message: "Rate limit reached.",
        retryable: true,
        ...(waitMs !== null && { retryAfter: String(Math.max(1, Math.ceil(waitMs / 1000))) }),
      },
    };
  };
  const { write, seen } = await writeChecked(
    count,
    atOnce,
    (call, planned) => {
      const reply = keyed(planned);
      timeline.push(
        `${clock.now() - started} ${numberOf(call)}:${call.results.length}${"error" in reply ? " refused" : ""}`,
      );
      return reply;
    },
    { paceTimers: clock.timers },
  );
  /** The planned reply, or the key's refusal when it has no room for the request. */
  function keyed(reply: ScriptedReply): ScriptedReply {
    const now = clock.now();
    if (key.kind === "at-once") {
      if (out >= key.atOnce) return refusal(null);
    } else if (key.kind === "bucket") {
      if (!requests) return refusal(null);
      if (requests.level(now) < 1) {
        if (key.countsRefused) requests.take(1);
        return refusal(requests.until(now, 1));
      }
      requests.take(1);
    } else if (requests && input) {
      const costs = firstOfWrite ? key.firstCosts : key.costs.input;
      const waits = [
        requests.until(now, 1),
        input.until(now, costs),
        output ? output.until(now, 1) : 0,
      ];
      const wait = Math.max(...waits);
      if (wait > 0) return refusal(wait);
      requests.take(1);
      input.take(costs);
      firstOfWrite = false;
    }
    sent++;
    out++;
    const given = clock.after(replyMs).then(() => {
      out--;
      if (key.kind === "tokens") output?.take(key.costs.output);
    });
    return { ...reply, pause: { after: 0, until: given } };
  }
  const results: KeyWrite[] = [];
  for (let each = 0; each < writes; each++) {
    const before = { refused, sent, order: seen.order.length, timeline: timeline.length };
    firstOfWrite = true;
    started = clock.now();
    const note = await clock.until(write);
    const marks: Record<string, number> = {};
    for (const mark of marksOf(note).values()) marks[mark] = (marks[mark] ?? 0) + 1;
    results.push({
      end: clock.now() - started,
      refused: refused - before.refused,
      sent: sent - before.sent,
      marks,
      order: seen.order.slice(before.order),
      timeline: timeline.slice(before.timeline),
    });
  }
  return results;
}
