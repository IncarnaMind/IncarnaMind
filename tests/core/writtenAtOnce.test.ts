/**
 * A write's checked sentences go twelve at once on a model measured to take them, staggered and
 * checking no less (#2532): the first six start as at six, the other six once the first six's
 * first replies are back, none later than at six places; a rate limit drops the run to six and
 * every sentence still gets its verdict; and each sentence's check sends what it sends at six. The
 * model's replies are scripted.
 */
import { expect, test, vi } from "vitest";
import type { CoreAdapters } from "../../src/core";
import { claimsAtOnce, writtenChecksAtOnce } from "../../src/core/answers/checks/runChecks";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { askAssistant } from "../helpers/assistant";
import { checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { checkClock } from "../helpers/heldClock";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import {
  judgesNothing,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/** The words of the write's sentence `n`, from 1, which the tide table's line `n` states. */
const words = (n: number) => `Spring tide ${n} comes at new and full moon`;

const LINES = Array.from({ length: 12 }, (_, index) => `${words(index + 1)}.`);

/** Sentence `n` as its check reads it: its Citation left out before the full stop. */
const asChecked = (n: number) => `${words(n)} .`;

const PLANS: Record<string, Plan> = Object.fromEntries(
  LINES.map((line, index) => [
    asChecked(index + 1),
    { verdict: "supported", quote: line, says: line },
  ]),
);

const TWELVE_SUPPORTED = Array.from({ length: 12 }, () => "supported");

/** Which of the write's sentences a check request is for, from 1. */
const numberOf = (call: ModelCall) => Number(/Spring tide (\d+) /.exec(sentenceOf(call))?.[1]);

const isFirstTurn = (call: ModelCall) => call.results.length === 0;

const isVerdict = (reply: ScriptedReply) =>
  "text" in reply && typeof reply.text === "string" && reply.text.startsWith("Verdict");

/** One sentence's check starting (its first request) or ending (its verdict given), in order. */
type Event =
  | { kind: "start"; n: number; running: number }
  | { kind: "verdict"; n: number }
  | { kind: "limited"; n: number };

/** What a write's checks did: each check's start and end in order, and each one's requests. */
interface Seen {
  events: Event[];
  running: Set<number>;
  most: number;
  sent: Map<number, string[]>;
}

const startsOf = (seen: Seen) =>
  seen.events.flatMap((event) => (event.kind === "start" ? [event.n] : []));

const indexOf = (seen: Seen, kind: Event["kind"], n: number, nth = 1) => {
  let found = 0;
  return seen.events.findIndex((event) => event.kind === kind && event.n === n && ++found === nth);
};

/**
 * The assistant writes `count` cited sentences into a Note, each its own paragraph, checked
 * `atOnce` at a time; each check replies as `PLANS` says, unless `hold` holds or replaces it.
 */
async function writeChecked(
  count: number,
  atOnce: number,
  hold: (call: ModelCall, reply: ScriptedReply, seen: Seen) => ScriptedReply = (_, reply) => reply,
  adapters: Partial<CoreAdapters> = {},
) {
  const seen: Seen = { events: [], running: new Set(), most: 0, sent: new Map() };
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
  return {
    seen,
    client,
    ask: () =>
      askAssistant(core, {
        text: "Add a short note on tides to this Mind",
        mindId: mind.id,
        scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      }),
  };
}

/** Each written sentence's mark on the page, by its number. */
function marksOf(client: MindClient): Map<number, string> {
  return new Map(
    claimSpans(readMind(client)).flatMap((span) => {
      const n = Number(/Spring tide (\d+) /.exec(span.sentence.text)?.[1]);
      return Number.isNaN(n) ? [] : [[n, span.check.state] as const];
    }),
  );
}

/** A promise, and the function that resolves it. */
function gate() {
  let open: () => void = () => undefined;
  const until = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { until, open };
}

const waitUntil = (condition: () => void) =>
  vi.waitFor(condition, { timeout: 20_000, interval: 5 });

/** Lets every callback already due run: a request that was about to go out has. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// protects=at twelve, the first six of a write's checks start together and the other six only once each of the first six's first replies is back, so the key is never sent twelve first requests together (#2532); then all twelve run at once; fails_when=a later sentence's first request goes out while a first one's first reply is held, or the later six wait for the first six to end; no_claim=a real provider's speed.
test("the other six start once the first six's first replies are back, then twelve run at once", async () => {
  const firstReplies = gate();
  const laterSix = gate();
  const { seen, ask, client } = await writeChecked(12, 12, (call, reply) => {
    const n = numberOf(call);
    if (n <= 6 && isFirstTurn(call))
      return { ...reply, pause: { after: 0, until: firstReplies.until } };
    // The first six's verdicts wait until the other six have started, so twelve run together.
    if (n <= 6 && isVerdict(reply)) return { ...reply, pause: { after: 0, until: laterSix.until } };
    return reply;
  });
  const asked = ask();

  await waitUntil(() => expect(startsOf(seen)).toHaveLength(6));
  await settle();
  expect(startsOf(seen)).toEqual([1, 2, 3, 4, 5, 6]);
  firstReplies.open();
  await waitUntil(() => expect(startsOf(seen)).toHaveLength(12));
  laterSix.open();
  await asked;

  expect(
    startsOf(seen)
      .slice(6)
      .sort((a, b) => a - b),
  ).toEqual([7, 8, 9, 10, 11, 12]);
  expect(seen.most).toBe(12);
  expect([...marksOf(client).values()]).toEqual(TWELVE_SUPPORTED);
});

// protects=a later sentence never starts later than it would at six places: while the first six's first replies are slow, the place a finished check frees is taken at once, as at six, and no more than six run (#2532); fails_when=the later six wait for every first reply though checks have ended, or more than six run before the first replies are back; no_claim=which of the first six ends first.
test("a later sentence takes the place a finished check frees, as at six, while first replies are slow", async () => {
  const slow = gate();
  const { seen, ask, client } = await writeChecked(12, 12, (call, reply) => {
    const n = numberOf(call);
    return n >= 2 && n <= 6 && isFirstTurn(call)
      ? { ...reply, pause: { after: 0, until: slow.until } }
      : reply;
  });
  const asked = ask();

  // With five first replies held, the other six go one after another through the freed place.
  await waitUntil(() => expect(indexOf(seen, "verdict", 12)).toBeGreaterThan(-1));
  expect(seen.most).toBe(6);
  for (const [later, freedBy] of [
    [7, 1],
    [8, 7],
    [9, 8],
    [10, 9],
    [11, 10],
    [12, 11],
  ] as const) {
    expect(indexOf(seen, "verdict", freedBy)).toBeLessThan(indexOf(seen, "start", later));
  }
  expect(
    seen.events.some((event) => event.kind === "verdict" && event.n >= 2 && event.n <= 6),
  ).toBe(false);
  slow.open();
  await asked;

  expect([...marksOf(client).values()]).toEqual(TWELVE_SUPPORTED);
});

// protects=a rate limit met at twelve drops the run straight to six places, the limited sentence is tried again, and every sentence lands with its verdict, none Not checked for the limit (#2532); fails_when=the run keeps eleven places, or the limited sentence lands Not checked; no_claim=a limit that outlasts every pause, which lands as at six.
test("a rate limit at twelve drops the run to six, and all twelve marks land", async () => {
  let limited = false;
  const verdicts = new Map<number, ReturnType<typeof gate>>();
  const { seen, ask, client } = await writeChecked(12, 12, (call, reply) => {
    const n = numberOf(call);
    if (n === 12 && isFirstTurn(call) && !limited) {
      limited = true;
      return { error: { status: 429, message: "Rate limit reached." } };
    }
    if (n !== 12 && isVerdict(reply)) {
      const held = gate();
      verdicts.set(n, held);
      return { ...reply, pause: { after: 0, until: held.until } };
    }
    return reply;
  });
  const asked = ask();

  await waitUntil(() => {
    expect(limited).toBe(true);
    expect(verdicts.size).toBe(11);
  });
  const retried = () => indexOf(seen, "start", 12, 2) >= 0;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    verdicts.get(n)?.open();
    await waitUntil(() => expect(marksOf(client).get(n)).toBe("supported"));
    // Once a sixth has ended, five run: the limited sentence takes the sixth place.
    if (n === 6) await waitUntil(() => expect(retried()).toBe(true));
  }
  await asked;

  expect(seen.most).toBe(12);
  const retry = indexOf(seen, "start", 12, 2);
  expect(seen.events.slice(0, retry).filter((event) => event.kind === "verdict")).toHaveLength(6);
  expect(seen.events[retry]).toEqual({ kind: "start", n: 12, running: 6 });
  const marks = marksOf(client);
  expect(marks.size).toBe(12);
  expect([...marks.values()]).toEqual(TWELVE_SUPPORTED);
});

// protects=sending a write's sentences twelve at once changes nothing a sentence's check sends or concludes: each sends the same requests and lands the same mark at six and at twelve (#2532); fails_when=a check's requests or its verdict depend on how many run beside it; no_claim=the order in which replies come.
test("each sentence's check sends the same requests and lands the same mark at six and at twelve", async () => {
  const atSix = await writeChecked(12, 6);
  await atSix.ask();
  const atTwelve = await writeChecked(12, 12);
  await atTwelve.ask();

  expect(atSix.seen.most).toBe(6);
  expect(atTwelve.seen.most).toBeGreaterThan(6);
  const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const sentBy = (seen: Seen, n: number) =>
    (seen.sent.get(n) ?? []).map((each) => each.replace(ID, "<id>"));
  for (let n = 1; n <= 12; n++) {
    expect(sentBy(atTwelve.seen, n).length).toBeGreaterThan(0);
    expect(sentBy(atTwelve.seen, n)).toEqual(sentBy(atSix.seen, n));
  }
  expect([...marksOf(atTwelve.client)]).toEqual([...marksOf(atSix.client)]);
  expect([...marksOf(atTwelve.client).values()]).toEqual(TWELVE_SUPPORTED);
});

// protects=twelve at once is the written check's alone, and only on its provider's own service for a model measured to take it: a Claude or ChatGPT sign-in and a model on this computer keep their numbers, and every other check keeps six (#2532); fails_when=a sign-in or Check this Note gets twelve; no_claim=which models the catalog lists.
test("twelve only for a write's check, on a service, never on a sign-in", () => {
  const on = (kind: string, service: boolean, facts: object = { writtenChecksAtOnce: 12 }) =>
    ({
      provider: { kind, service: service ? { id: kind } : null },
      capabilities: { known: true, facts },
    }) as unknown as PreparedChatModel;

  expect(writtenChecksAtOnce(on("anthropic", true))).toBe(12);
  expect(writtenChecksAtOnce(on("openai", true))).toBe(12);
  expect(writtenChecksAtOnce(on("anthropic", true, {}))).toBe(6);
  expect(writtenChecksAtOnce(on("claude-account", true))).toBe(6);
  expect(writtenChecksAtOnce(on("chatgpt", true))).toBe(6);
  expect(writtenChecksAtOnce(on("copilot", true))).toBe(6);
  expect(writtenChecksAtOnce(on("ollama", false))).toBe(1);
  expect(claimsAtOnce(on("anthropic", true))).toBe(6);
});
