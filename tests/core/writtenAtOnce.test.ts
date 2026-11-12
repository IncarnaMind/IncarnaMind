/**
 * A write's checked sentences go twelve at once on a model measured to take them, staggered and
 * checking no less (#2532): the first six start as at six, the other six once the first six's
 * first replies are back, none later than at six places; a rate limit drops the run to six and
 * every sentence still gets its verdict; and each sentence's check sends what it sends at six.
 * A refused request waits inside its check, as long as the service says, and goes again (#2944).
 * The model's replies are scripted.
 */
import { expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { claimsAtOnce, writtenChecksAtOnce } from "../../src/core/answers/checks/runChecks";
import { stagger } from "../../src/core/answers/checks/stagger";
import type { ChatProviderKind, ConversationAnswer } from "../../src/core/api";
import { resolveCapabilities } from "../../src/core/providers/capabilities";
import {
  catalogFacts,
  catalogModels,
  modelsProviderOfKind,
  providersWithModels,
} from "../../src/core/providers/catalog";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import { mindCallText } from "../../src/renderer/src/answerStepWords";
import { formatDateTime } from "../../src/shared/dates";
import { translate } from "../../src/shared/i18n";
import { answerEnded } from "../helpers/citations";
import { checkClock } from "../helpers/heldClock";
import type { ScriptedReply } from "../helpers/models";
import {
  gate,
  indexOf,
  isFirstTurn,
  isVerdict,
  keyWrites,
  marksOf,
  numberOf,
  type Seen,
  settle,
  startsOf,
  TWELVE_SUPPORTED,
  virtualClock,
  waitUntil,
  writeChecked,
} from "../helpers/writeChecked";

/** A rate limit as a service refuses one: the AI SDK would send it again, after `retryAfter` s if given. */
const limit = (retryAfter?: string): ScriptedReply => ({
  error: {
    status: 429,
    message: "Rate limit reached.",
    retryable: true,
    ...(retryAfter !== undefined && { retryAfter }),
  },
});

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

// protects=a rate limit met at twelve that says how long to wait has the refused request sent again inside its check once that wait is over, before any other check has ended, and every sentence lands with its verdict, none Not checked for the limit (#2532, #2944); fails_when=the limited sentence waits for six others to end, starts its check over, or lands Not checked; no_claim=a limit that outlasts every pause, which the bound's test below holds.
test("a rate limit at twelve: the refused request goes again inside its check, and all twelve marks land", async () => {
  let limited = false;
  const verdicts = new Map<number, ReturnType<typeof gate>>();
  const { seen, ask, client } = await writeChecked(12, 12, (call, reply) => {
    const n = numberOf(call);
    if (n === 12 && isFirstTurn(call) && !limited) {
      limited = true;
      return limit("1");
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
    expect(verdicts.size).toBe(11);
    expect(marksOf(client).get(12)).toBe("supported");
  });
  expect(seen.events.filter((event) => event.kind === "verdict")).toEqual([
    { kind: "verdict", n: 12 },
  ]);
  for (const held of verdicts.values()) held.open();
  await asked;

  expect(seen.most).toBe(12);
  expect(seen.events.filter((event) => event.kind === "limited")).toEqual([
    { kind: "limited", n: 12 },
  ]);
  const marks = marksOf(client);
  expect(marks.size).toBe(12);
  expect([...marks.values()]).toEqual(TWELVE_SUPPORTED);
});

// protects=a rate limit met on one of the first six's first requests, while the other six still wait their turn, keeps the run six wide: the waiting six go back to the run untried, none starts before the pause has run, never more than six run from the limit on, and all twelve marks land (#2532); fails_when=the waiting six start once the other first replies are back, eleven running after a limit; no_claim=a limit that outlasts every pause, which lands as at six.
test("a rate limit on a first request while the other six wait keeps the run six wide, and all twelve marks land", async () => {
  const clock = checkClock();
  let limitedAt: number | null = null;
  const others = gate();
  const pausesAtStart = new Map<number, number>();
  const { seen, ask, client } = await writeChecked(
    12,
    12,
    (call, reply, seen) => {
      const n = numberOf(call);
      if (isFirstTurn(call) && !pausesAtStart.has(n)) pausesAtStart.set(n, clock.pauses().length);
      if (n === 3 && isFirstTurn(call) && limitedAt === null) {
        limitedAt = seen.events.length;
        others.open();
        return limit("1");
      }
      // The other five first replies come only once the limit is met, so the later six still wait.
      if (n <= 6 && isFirstTurn(call))
        return { ...reply, pause: { after: 0, until: others.until } };
      return reply;
    },
    { paceTimers: clock.timers },
  );
  await ask();

  expect(limitedAt).not.toBeNull();
  const fromLimit = seen.events.slice(limitedAt ?? 0);
  const starts = fromLimit.flatMap((event) => (event.kind === "start" ? [event] : []));
  expect(Math.max(...starts.map((event) => event.running))).toBeLessThanOrEqual(6);
  // The limited sentence goes again first, then the six that waited, in their order.
  expect(starts.flatMap((event) => (event.n >= 7 ? [event.n] : []))).toEqual([7, 8, 9, 10, 11, 12]);
  expect(indexOf(seen, "start", 3, 2)).toBeLessThan(indexOf(seen, "start", 7));
  for (const later of [7, 8, 9, 10, 11, 12]) {
    expect(indexOf(seen, "start", later)).toBeGreaterThan(limitedAt ?? 0);
    expect(pausesAtStart.get(later)).toBeGreaterThanOrEqual(1);
  }
  expect(indexOf(seen, "start", 3, 2)).toBeGreaterThan(limitedAt ?? 0);
  expect(seen.most).toBe(6);
  const marks = marksOf(client);
  expect(marks.size).toBe(12);
  expect([...marks.values()]).toEqual(TWELVE_SUPPORTED);
});

/** The write's row in the Answer as it is stored now, in `language`. */
async function writeRow(core: Core, conversationId: string, language: "en" | "zh-CN") {
  const { messages } = await core.getConversation(conversationId);
  const answer = messages.findLast(
    (message): message is ConversationAnswer => message.kind === "answer",
  );
  const call = answer?.toolCalls.find((each) => each.tool === "add_to_mind");
  if (!call) return null;
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(language, key, params);
  return { row: mindCallText(t, call, "Harbour notes", language), call };
}

// protects=a check request refused with a stated wait, 40 s as #2944 names and 90 s past what the AI SDK's own retry takes, is sent again inside its check only once the wait is over, never sooner, and its verdict lands; the check doesn't start over; while it waits the write's row says "Rate limit reached · resumes at {time}" in Tags' words, in English and Chinese, and says it is checking again once the wait is over (#2944); fails_when=the request goes again sooner than the service said, the check is sent from its first turn again, the verdict doesn't land, or the row keeps saying it is checking while it waits; no_claim=what a real service states.
test.each([40, 90])(
  "a request refused with a stated wait of %i s goes again once it is over, and the row says when",
  async (seconds) => {
    const clock = virtualClock();
    let refusedAt: number | null = null;
    let sentAgainAt: number | null = null;
    const { core, seen, start, client } = await writeChecked(
      6,
      6,
      (call, reply) => {
        if (numberOf(call) === 1 && !isFirstTurn(call)) {
          if (refusedAt === null) {
            refusedAt = clock.now();
            return limit(String(seconds));
          }
          sentAgainAt ??= clock.now();
        }
        return { ...reply, pause: { after: 0, until: clock.after(100) } };
      },
      { paceTimers: clock.timers },
    );
    const rows: string[] = [];
    let conversationId: string | null = null;
    await clock.until(
      async () => {
        const asked = await start();
        conversationId = asked.conversationId;
        await answerEnded(core, asked.answerId);
      },
      async (to) => {
        if (refusedAt === null || sentAgainAt !== null || to !== refusedAt + seconds * 1000) return;
        const id = conversationId;
        if (id === null) return;
        // The Answer is stored a moment after it changes, on the computer's own clock.
        const resumes = await vi.waitFor(
          async () => {
            const until = (await writeRow(core, id, "en"))?.call.mindChange?.limitedUntil;
            if (until === undefined) throw new Error("The row doesn't say when yet.");
            return until;
          },
          { timeout: 5_000, interval: 20 },
        );
        expect(resumes).toBe(new Date(refusedAt + seconds * 1000).toISOString());
        const en = await writeRow(core, id, "en");
        const zh = await writeRow(core, id, "zh-CN");
        rows.push(en?.row ?? "", zh?.row ?? "");
        expect(rows).toEqual([
          `Rate limit reached · resumes at ${formatDateTime(resumes, "en")}`,
          `已达到速率上限 · ${formatDateTime(resumes, "zh-CN")} 继续`,
        ]);
      },
    );

    expect(rows).toHaveLength(2);
    expect(refusedAt).not.toBeNull();
    expect((sentAgainAt ?? 0) - (refusedAt ?? 0)).toBe(seconds * 1000);
    expect(startsOf(seen).filter((n) => n === 1)).toEqual([1]);
    expect([...marksOf(client).values()]).toEqual(Array.from({ length: 6 }, () => "supported"));
    const id: string | null = conversationId;
    if (id === null) throw new Error("No conversation.");
    await vi.waitFor(
      async () =>
        expect((await writeRow(core, id, "en"))?.call.mindChange?.limitedUntil).toBe(undefined),
      { timeout: 5_000, interval: 20 },
    );
  },
);

// protects=one request waits on rate limits two minutes in all at most: refused with a stated wait of 50 s a third time, past the bound, its sentence is Not checked for the rate limit with today's words in English and Chinese, and the sentences not yet started aren't sent, as when a limit outlasts every pause today (#2944); fails_when=a request waits past two minutes, a sentence is dropped without its reason, or the later sentences are sent; no_claim=how a real service's limit clears.
test("refused past two minutes of waiting, the sentence is Not checked for the rate limit and the later ones aren't sent", async () => {
  const clock = virtualClock();
  const refusedAt: number[] = [];
  const { seen, write } = await writeChecked(
    3,
    1,
    (call, reply) => {
      if (numberOf(call) === 1 && !isFirstTurn(call)) {
        refusedAt.push(clock.now());
        return limit("50");
      }
      return { ...reply, pause: { after: 0, until: clock.after(100) } };
    },
    { paceTimers: clock.timers },
  );
  const note = await clock.until(write);

  expect(refusedAt.map((at) => at - (refusedAt[0] ?? 0))).toEqual([0, 50_000, 100_000]);
  expect([...marksOf(note)]).toEqual([
    [1, "not-checked: rate-limit"],
    [2, "not-checked: rate-limit"],
    [3, "not-checked: rate-limit"],
  ]);
  expect(startsOf(seen)).toEqual([1]);
  expect(translate("en", "claim.reason.rate-limit")).toBe(
    "The model’s service is busy for now. Check again in a moment.",
  );
  expect(translate("zh-CN", "claim.reason.rate-limit")).toBe("模型服务暂时繁忙，请稍后重新核对。");
});

/**
 * A write of six whose first sentence's second request is refused with a stated wait of 40 s, and
 * `during` done once every request of the run waits on it: what was sent after, and when the
 * write ended.
 */
async function interruptedWait(
  during: (core: Core, asked: { conversationId: string; answerId: string }) => Promise<void>,
  answerEnds: boolean,
) {
  const clock = virtualClock();
  let refusedAt: number | null = null;
  let interrupted = false;
  let sentAfter = 0;
  const { core, start } = await writeChecked(
    6,
    6,
    (call, reply) => {
      if (interrupted) sentAfter++;
      if (numberOf(call) === 1 && !isFirstTurn(call) && refusedAt === null) {
        refusedAt = clock.now();
        return limit("40");
      }
      return { ...reply, pause: { after: 0, until: clock.after(100) } };
    },
    { paceTimers: clock.timers },
  );
  let asked: { conversationId: string; answerId: string } | null = null;
  const done = gate();
  await clock.until(
    async () => {
      asked = await start();
      await (answerEnds ? answerEnded(core, asked.answerId) : done.until);
    },
    async (to) => {
      if (refusedAt === null || interrupted || asked === null || to !== refusedAt + 40_000) return;
      interrupted = true;
      await during(core, asked);
      done.open();
    },
  );
  const endedAt = clock.now();
  // Past the stated wait: nothing that waited goes on.
  await clock.until(() => clock.after(60_000));
  return { interrupted, sentAfter, endedAt, refusedAt: refusedAt ?? 0 };
}

// protects=a request waiting on a rate limit ends when the User stops the Answer: nothing is sent afterwards, and the write ends at once rather than once the stated wait is over (#2944); fails_when=a stopped write sends again once the wait is over, or waits it out; no_claim=what a stopped check lands, which ./writtenChecks.test.ts holds.
test("Stop during a rate limit's wait ends it, and nothing is sent afterwards", async () => {
  const { interrupted, sentAfter, endedAt, refusedAt } = await interruptedWait(
    (core, { conversationId, answerId }) =>
      core.stopConversationAnswer({ conversationId, answerId }),
    true,
  );

  expect(interrupted).toBe(true);
  expect(sentAfter).toBe(0);
  expect(endedAt).toBeLessThan(refusedAt + 40_000);
});

// protects=a request waiting on a rate limit ends when the core closes: nothing is sent to the model afterwards, even once the stated wait is over (#2944); fails_when=the wait outlives the core and sends once it is over; no_claim=the stopped check's record and marks, which no closed core can keep, as for any check whose request is out when it closes.
test("closing the core during a rate limit's wait ends it, and nothing is sent afterwards", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { interrupted, sentAfter, endedAt, refusedAt } = await interruptedWait(async (core) => {
    core.close();
  }, false);
  logged.mockRestore();

  expect(interrupted).toBe(true);
  expect(sentAfter).toBe(0);
  expect(endedAt).toBeLessThan(refusedAt + 40_000);
});

// protects=a check's time limit doesn't run while its request waits on a rate limit: with a 30 s limit and a stated wait of 40 s, the check goes on after the wait and its verdict lands, never Not checked as timed out (#2944); fails_when=the wait counts against the time limit; no_claim=a reply that never comes, which still times out (./checkRunner.test.ts).
test("a check's time limit doesn't run while its request waits on a rate limit", async () => {
  const clock = virtualClock();
  let refused = false;
  const { write } = await writeChecked(
    1,
    6,
    (call, reply) => {
      if (!isFirstTurn(call) && !refused) {
        refused = true;
        return limit("40");
      }
      return { ...reply, pause: { after: 0, until: clock.after(100) } };
    },
    {
      paceTimers: clock.timers,
      contradictionWatch: { delayMs: 60 * 60_000, claimTimeLimitMs: 30_000 },
    },
  );
  const note = await clock.until(write);

  expect(refused).toBe(true);
  expect([...marksOf(note)]).toEqual([[1, "supported"]]);
});

// protects=a key that refuses one of the later six's first requests once, saying nothing of how long, gets a write at twelve no more than the AI SDK's own 2 s retry later than at six, and the write after it, which starts at twelve again, the same (#2532, #2944); fails_when=the refusal holds the twelve-wide write past the SDK's retry, or starts the check over; no_claim=keys that refuse several requests, which eval/speed/gates/key-cells.md runs.
test("a key refusing once gets a write no more than the AI SDK's retry later at twelve than at six", async () => {
  const ends = async (replyMs: number) => {
    const writes = async (atOnce: number) => {
      const clock = virtualClock();
      let mayLimit = true;
      const { write } = await writeChecked(
        12,
        atOnce,
        (call, reply) => {
          if (atOnce > 6 && numberOf(call) >= 7 && isFirstTurn(call) && mayLimit) {
            mayLimit = false;
            return limit();
          }
          return { ...reply, pause: { after: 0, until: clock.after(replyMs) } };
        },
        { paceTimers: clock.timers },
      );
      const ended: number[] = [];
      for (let each = 0; each < 2; each++) {
        mayLimit = true;
        const started = clock.now();
        await clock.until(write);
        ended.push(clock.now() - started);
      }
      return ended;
    };
    return { six: await writes(6), twelve: await writes(12) };
  };

  expect({
    100: await ends(100),
    500: await ends(500),
    1000: await ends(1000),
    2000: await ends(2000),
  }).toEqual({
    100: { six: [600, 600], twelve: [2400, 2400] },
    500: { six: [3000, 3000], twelve: [4000, 4000] },
    1000: { six: [6000, 6000], twelve: [6000, 6000] },
    2000: { six: [12000, 12000], twelve: [10000, 10000] },
  });
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

// protects=with no rate limit met, a write's checks send the same requests, as many at once and in the same order as at the gated head (142eb8985) whose cells held the gate: the change only acts on a refusal (#2944); fails_when=the request-level wait, the pause or the width rule moves a request of a write no service refused; no_claim=what each request holds, which the test above holds at six and twelve.
test("with no rate limit, a write's requests go as at the gated head: as many at once, in the same order", async () => {
  const never = { kind: "at-once", atOnce: 100 } as const;
  /** Each request sent, as its sentence and turn, by when it was sent: each reply takes a second. */
  const sentAt = async (atOnce: number) => {
    const [write] = await keyWrites(12, atOnce, 1000, never, 1);
    const at: Record<string, string> = {};
    for (const entry of write?.timeline ?? []) {
      const [ms = "", request = ""] = entry.split(" ");
      at[ms] = at[ms] ? `${at[ms]} ${request}` : request;
    }
    return { end: write?.end, refused: write?.refused, marks: write?.marks, at };
  };

  // As the gated head (142eb8985) sent them on the same scripted key, eval/speed/gates/key-cells.md.
  expect(await sentAt(6)).toEqual({
    end: 6000,
    refused: 0,
    marks: { supported: 12 },
    at: {
      "0": "1:0 2:0 3:0 4:0 5:0 6:0",
      "1000": "1:1 2:1 3:1 4:1 5:1 6:1",
      "2000": "1:2 2:2 3:2 4:2 5:2 6:2",
      "3000": "7:0 8:0 9:0 10:0 11:0 12:0",
      "4000": "7:1 8:1 9:1 10:1 11:1 12:1",
      "5000": "7:2 8:2 9:2 10:2 11:2 12:2",
    },
  });
  expect(await sentAt(12)).toEqual({
    end: 4000,
    refused: 0,
    marks: { supported: 12 },
    at: {
      "0": "1:0 2:0 3:0 4:0 5:0 6:0",
      "1000": "7:0 8:0 9:0 10:0 11:0 12:0 1:1 2:1 3:1 4:1 5:1 6:1",
      "2000": "1:2 2:2 3:2 4:2 5:2 6:2 7:1 8:1 9:1 10:1 11:1 12:1",
      "3000": "7:2 8:2 9:2 10:2 11:2 12:2",
    },
  });
});

// protects=a later sentence waiting its turn is let go at once when the run is stopped, so a Stop never hangs on the stagger, and the first six never wait (#2532); fails_when=a stopped write's later sentences wait for first replies that never come; no_claim=what a stopped check lands, which ./writtenChecks.test.ts holds.
test("a stopped run lets a waiting later sentence go, and the first six never wait", async () => {
  const stopped = new AbortController();
  const order = stagger(6, stopped.signal);
  let seventh = false;
  void order.turn(6).then(() => {
    seventh = true;
  });
  await order.turn(5);
  await settle();
  expect(seventh).toBe(false);
  stopped.abort();
  await waitUntil(() => expect(seventh).toBe(true));
});

// protects=the catalog gives twelve at once only to the models whose two cells held the gate, on their providers' own services: Claude Haiku 5.5 on Anthropic and GPT-6.1 Sol on OpenAI (#2532, eval/speed/gates/check-speed-twelve.md); fails_when=Claude Sonnet 5.5, whose English cell failed, or the same model through OpenRouter or a plan's sign-in, gets twelve; no_claim=a model the gate never ran.
test("twelve at once only for the models the gate passed, on their own providers", () => {
  const listed = providersWithModels().flatMap((provider) =>
    catalogModels(provider)
      .filter((model) => catalogFacts(provider, model.id)?.writtenChecksAtOnce !== undefined)
      .map((model) => `${provider}/${model.id}`),
  );
  expect(listed).toEqual(["anthropic/claude-haiku-5-5", "openai/gpt-6.1-sol"]);
  const atOnce = (kind: ChatProviderKind, modelId: string) =>
    writtenChecksAtOnce({
      provider: { kind, service: { id: kind } },
      capabilities: resolveCapabilities({
        catalog: catalogFacts(modelsProviderOfKind(kind), modelId),
      }),
    } as unknown as PreparedChatModel);

  expect(atOnce("anthropic", "claude-haiku-5-5")).toBe(12);
  expect(atOnce("openai", "gpt-6.1-sol")).toBe(12);
  expect(atOnce("anthropic", "claude-sonnet-5-5")).toBe(6);
  expect(atOnce("openai", "gpt-6-luna")).toBe(6);
  expect(atOnce("openrouter", "openai/gpt-6.1-sol")).toBe(6);
  expect(atOnce("chatgpt", "gpt-6.1-sol")).toBe(6);
  expect(atOnce("claude-account", "claude-haiku-5-5")).toBe(6);
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
