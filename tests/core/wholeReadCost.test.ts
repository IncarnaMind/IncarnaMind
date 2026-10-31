import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { readsUnasked } from "../../src/shared/readBudget";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  sentenceOf,
} from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ReportedUsage,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

interface RecordedRead {
  sentence: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens times the catalog's price. */
  usd: number;
  /** What the app's own meter recorded, with the prompt cache's reads and writes. */
  meteredUsd: number;
  /** Recorded once each window reached the model once in each request. */
  windowOnce: boolean;
}

interface Recorded {
  model: string;
  lease: { parts: number; words: number; characters: number; tokens: number };
  reads: RecordedRead[];
}

const FILLER = [
  "The Tenant shall use the Property only as a private residence for the Tenant and the members of the Tenant's household named in the Schedule.",
  "The Tenant shall pay for electricity, gas, water and broadband supplied to the Property during the tenancy, and shall put each account in the Tenant's own name within seven days of the start of the Term.",
  "The Tenant shall pay the council tax for the Property for the whole of the Term.",
  "The Tenant shall keep the interior of the Property clean, tidy and in good decorative condition, and shall replace light bulbs and smoke alarm batteries when they fail.",
  "The Landlord shall keep in repair the structure and exterior of the Property, including the roof, walls, windows and external doors, and the installations for the supply of water, gas, electricity and heating.",
  "The Tenant shall report any defect or damage in the Property to the Landlord as soon as the Tenant becomes aware of it.",
  "The Landlord or the Landlord's agent may enter the Property to inspect it or carry out repairs on giving the Tenant at least 24 hours' notice, except in an emergency.",
  "The Tenant shall allow gas and electrical safety inspections to be carried out at the times the Landlord reasonably requires.",
  "The Landlord confirms that smoke alarms are fitted on each floor and a carbon monoxide alarm is fitted in each room with a fuel-burning appliance.",
  "The Tenant shall not cause a nuisance or annoyance to neighbours, and shall keep noise to a reasonable level between 11 pm and 7 am.",
  "The Tenant shall place household rubbish in the bins provided and shall put out the bins on the collection days set by the local council.",
  "The Tenant shall keep bicycles in the cycle store on the ground floor and not in the common stairwell.",
  "The Tenant shall not smoke or allow anyone else to smoke in the Property or in the common parts of the building.",
  "The Tenant shall not decorate the Property in a way that cannot easily be reversed without the Landlord's written consent.",
  "The Landlord has provided the contents listed in the inventory attached to this lease, and the Tenant shall take reasonable care of them.",
  "The Tenant shall pay for the repair or replacement of any item in the inventory that is damaged or lost through the act or neglect of the Tenant or a visitor.",
  "The Tenant shall keep the garden terrace free of weeds and shall not plant trees or shrubs in the ground there.",
  "The Tenant shall ventilate the Property and keep it heated sufficiently to prevent condensation and damp.",
  "The Tenant shall take reasonable precautions to prevent frozen or burst pipes, and shall know where the stop tap is.",
  "The Tenant shall take out contents insurance for the Tenant's own belongings; the Landlord insures the building.",
  "The Landlord shall insure the building against fire, flood and other usual risks and shall give the Tenant a copy of the policy summary on request.",
  "The Tenant shall return all keys, fobs and entry cards to the Landlord on the last day of the tenancy and shall not make copies of them.",
  "The Tenant shall pay the Landlord a reasonable charge for a replacement key or fob if one is lost.",
  "The Tenant shall leave the Property clean and in the same condition as at the start of the Term, fair wear and tear excepted.",
  "The Tenant shall give the Landlord a forwarding address before leaving the Property.",
  "The Landlord shall give the Tenant a copy of the current gas safety certificate and energy performance certificate before the Term begins.",
  "The Tenant shall not install any satellite dish, aerial or wiring on the outside of the building.",
  "The Landlord's agent for day-to-day management is Quayside Lettings, whose address is in the Schedule.",
  "Any notice under this lease shall be in writing and may be delivered by hand or sent by first-class post to the address in the Schedule.",
  "A notice sent by first-class post is treated as received on the second working day after posting.",
  "The Tenant shall not use the Property for any business that brings customers or deliveries to the building.",
  "The Landlord's rights under this lease are not lost if the Landlord delays in using them.",
  "If any part of this lease is found to be invalid, the rest of it remains in force.",
  "The Tenant acknowledges having been given the How to Rent guide before signing this lease.",
];
const ASSETS = [
  "fire alarm panel",
  "emergency lighting",
  "lift car",
  "entry phone system",
  "roof drains",
  "water booster pumps",
  "door closers",
  "CCTV cameras",
  "sprinkler valves",
  "communal boiler",
  "gutters",
  "extractor fans",
];
const AREAS = [
  "the east stairwell",
  "the basement store",
  "the roof terrace",
  "the cycle store",
  "the refuse store",
  "the ground-floor lobby",
  "the plant room",
  "the courtyard garden",
  "the first-floor corridor",
  "the laundry room",
  "the post room",
];
const FREQUENCIES = [
  "every month",
  "every quarter",
  "twice a year",
  "every six weeks",
  "every year",
];
const ITEMS = ["furniture", "bicycles", "refuse sacks", "building materials", "garden waste"];
const PROVIDERS = ["lift engineer", "cleaning contractor", "building contractor", "electrician"];
const RECORDS = ["maintenance log", "inspection file", "contractor register", "risk assessment"];
const SERVICES = ["window cleaning", "landscaping", "lift maintenance", "gutter clearing"];
const RENT =
  "Rent. The Tenant shall pay the Landlord rent of £1,850 per month, in advance, on the first day of each month, by standing order to the account named in the Schedule.";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** The recorded lease: `sections` parts of about `words` words each, the rent clause last. */
function leaseMarkdown(sections: number, words: number): string {
  const next = seeded(60);
  const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;
  const generated = () =>
    pick([
      () =>
        `The Managing Agent shall inspect the ${pick(ASSETS)} in ${pick(AREAS)} ${pick(FREQUENCIES)} and record each inspection in the ${pick(RECORDS)}.`,
      () =>
        `The ${pick(PROVIDERS)} shall service the ${pick(ASSETS)} in ${pick(AREAS)} ${pick(FREQUENCIES)}, and the cost forms part of the service charge.`,
      () =>
        `The Tenant shall not leave ${pick(ITEMS)} in ${pick(AREAS)}, and the Managing Agent may remove them without notice.`,
      () => `The Tenant shall not obstruct ${pick(AREAS)}, which is used as a fire escape route.`,
      () =>
        `Charges for ${pick(SERVICES)} are shared among all flats in the building and form part of the service charge.`,
    ])();
  const parts = [
    "# Residential Tenancy Agreement",
    "",
    "Harbourside Court, Flat 14, Quay Road",
    "Between Marlow Property Holdings Ltd (the Landlord) and the Tenant named in the Schedule",
    "",
  ];
  let number = 0;
  let filler = 0;
  for (let section = 1; section <= sections; section++) {
    parts.push(`## Part ${section}`, "");
    let count = 0;
    while (count < words) {
      const clause = next() < 0.45 ? (FILLER[filler++ % FILLER.length] as string) : generated();
      number++;
      parts.push(`${number}. ${clause}`, "");
      count += clause.split(" ").length;
    }
  }
  parts.push(`${number + 1}. ${RENT}`, "");
  return parts.join("\n");
}

/** The recorded reads' plans; `sorted`: after a check of the Note, which sorts each sentence's parts. */
async function readPlans(recorded: Recorded, sorted = false) {
  const lease = leaseMarkdown(recorded.lease.parts, recorded.lease.words);
  expect(lease.length).toBe(recorded.lease.characters);
  const sentences = [...new Set(recorded.reads.map((each) => each.sentence))];
  const found = Object.fromEntries(
    sentences.map((each) => [each, { verdict: "unsupported" as const }]),
  );
  const scripted = scriptedModel((call) => checkReply(call, found), {
    generate: checkGenerate(found),
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(scripted).createChatModel,
  });
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-test",
    modelId: recorded.model,
  });
  if (!provider.service) throw new Error("The test provider has no service.");
  await core.allowDataFlow("document-check", provider.service.id);
  await core.allowDataFlow("checks", provider.service.id);
  const model = { providerId: provider.id, modelId: recorded.model };
  const sources = await createTempDataFolder();
  const [document] = await addAndProcess(core, [
    await writeSourceFile(sources, "Harbourside lease.md", lease),
    await writeSourceFile(
      sources,
      "Walled notes.md",
      "The walled Folder holds this private note about a 90-day notice.",
    ),
  ]);
  if (!document) throw new Error("The lease wasn't added.");
  const mind = await core.createMind({ title: "Lease checks" });
  const client = await connectToMind(core, mind.id);
  const blocks = sentences.map((each) => note(each));
  writeMind(client, blocks);
  await client.settled();
  if (sorted) {
    await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all", model });
  }
  const plans = new Map<string, Awaited<ReturnType<typeof core.planDocumentCheck>>>();
  for (const [index, sentence] of sentences.entries()) {
    const blockId = String(blocks[index]?.attrs?.id);
    plans.set(
      sentence,
      await core.planDocumentCheck({
        mindId: mind.id,
        from: { blockId, offset: 0 },
        to: { blockId, offset: sentence.length },
        within: { folderIds: [], tagIds: [], documentIds: [document.id] },
        model,
      }),
    );
  }
  return plans;
}

test("the most a whole read may cost covers every read Claude Haiku 5.5 recorded, and its calls are theirs", async () => {
  const recorded: Recorded = JSON.parse(
    await readFile(join(import.meta.dirname, "../fixtures/cost/recorded-whole-read.json"), "utf8"),
  );
  const plans = await readPlans(recorded);
  for (const read of recorded.reads) {
    const plan = plans.get(read.sentence);
    if (plan?.kind !== "ready" || plan.estimate?.billing !== "per-token") {
      throw new Error("The read has no per-token estimate.");
    }
    expect(plan.tokens).toBe(recorded.lease.tokens);
    const most = plan.estimate.upTo;
    // Each of a Run's eleven calls may write its 8,000-token limit, and the calls after it carry
    // that: about 2.7M tokens on this lease, where 500 a call would make it about 1.3M. The first
    // window's calls from the third on carry a prompt over 100,000 tokens as Claude may count it,
    // priced at the 5x tier: about $1.09, where the base price alone would make it about $0.31.
    expect(most?.tokens).toBeGreaterThan(2_400_000);
    expect(most?.cost?.amount).toBeGreaterThan(1);
    expect(most?.cost?.amount).toBeLessThan(1.2);
    expect(most?.calls).toBeGreaterThanOrEqual(read.requests);
    expect(most?.tokens).toBeGreaterThanOrEqual(read.inputTokens + read.outputTokens);
    expect(most?.cost?.amount).toBeGreaterThanOrEqual(Math.max(read.usd, read.meteredUsd));
  }
  // About as many requests as the reads made once each window reached the model once: 7 and 8.
  const sent = recorded.reads.filter((read) => read.windowOnce).map((read) => read.requests);
  const mean = sent.reduce((sum, each) => sum + each, 0) / sent.length;
  for (const plan of plans.values()) {
    expect(
      plan.kind === "ready" && plan.estimate?.billing === "per-token" && plan.estimate.calls,
    ).toBe(Math.round(mean));
  }
});

describe("A whole read held to the most it may spend", () => {
  const KEEP = "The tenant may keep a cat.";
  const RENT = "Rent is due on the first of each month.";
  const LEASE = [
    ...Array.from(
      { length: 30 },
      (_, index) => `Clause ${index + 1} covers the upkeep of the flat.`,
    ),
    "The tenant may keep a cat.",
    "Rent is due on the first of each month.",
  ].join("\n\n");
  const plans = {
    [KEEP]: { verdict: "supported" as const, quote: "The tenant may keep a cat" },
    [RENT]: { verdict: "supported" as const, quote: "Rent is due on the first of each month" },
  };
  // Twenty million input tokens of Claude Haiku 5.5 cost $2: far past any small read's most.
  const SPENT: ReportedUsage = {
    inputTokens: { total: 20_000_000, noCache: 20_000_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  };

  async function readTwice(language: "en" | "zh-CN", modelId = "claude-haiku-5-5") {
    const calls: ModelCall[] = [];
    let spend = true;
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        return checkReply(call, plans);
      },
      {
        generate(call) {
          const reply = checkGenerate(plans)(call);
          // The first sentence's parts are sorted after its Run: that request spends the budget.
          if (!spend || !call.system.startsWith("You sort the sentences") || !("text" in reply)) {
            return reply;
          }
          spend = false;
          return { ...reply, usage: SPENT };
        },
      },
    );
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Lease.md", contents: LEASE },
    ]);
    await core.updateSettings({ user: { language } });
    const provider = await core.saveChatProvider({ kind: "anthropic", apiKey: "sk-test", modelId });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("document-check", provider.service.id);
    const chosen = { providerId: provider.id, modelId };
    const block = note(`${KEEP} ${RENT}`);
    writeMind(client, [block]);
    await client.settled();
    const blockId = String(block.attrs?.id);
    const place = {
      from: { blockId, offset: 0 },
      to: { blockId, offset: KEEP.length + 1 + RENT.length },
    };
    const within = { folderIds: [], tagIds: [], documentIds: [documents[0]?.id ?? ""] };
    const spentUsd = async () =>
      (await core.getCostSummary()).spent.find((each) => each.currency === "USD")?.amount ?? 0;
    const read = async () => {
      const plan = await core.planDocumentCheck({
        mindId: mind.id,
        ...place,
        within,
        model: chosen,
      });
      if (plan.kind !== "ready" || plan.estimate?.billing !== "per-token") {
        throw new Error("The read has no per-token estimate.");
      }
      const sent = calls.length;
      await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-document",
        ...place,
        within,
        plan: plan.id,
        model: chosen,
      });
      await client.settled();
      const marks = new Map<string, ClaimCheckAttributes>(
        claimSpans(readMind(client)).map((span) => [span.check.text, span.check]),
      );
      return {
        plan,
        most: plan.estimate.upTo?.cost,
        spent: await spentUsd(),
        marks,
        runs: calls.slice(sent).filter(isCheckRun),
      };
    };
    return { first: await read(), again: await read() };
  }

  test.each(["en", "zh-CN"] as const)(
    "stops at its most: what was judged stays, the rest is Not checked, and Continue reads the rest (%s)",
    async (language) => {
      const { first, again } = await readTwice(language);

      expect(first.marks.get(KEEP)?.state).toBe("supported");
      const stopped = first.marks.get(RENT);
      expect(stopped).toMatchObject({ state: "not-checked", reason: "read-budget" });
      // What the read spent before it stopped: all of this core's spending, none of it still open.
      expect(JSON.parse(stopped?.detail ?? "null")).toMatchObject({
        most: first.most,
        spent: { currency: "USD", amount: expect.closeTo(first.spent, 9) },
      });
      // Refused before it was sent: the model never heard of the second sentence.
      expect(first.runs.some((call) => sentenceOf(call) === RENT)).toBe(false);

      // Continue sizes the rest again, and its read stays under that most.
      expect(again.plan.parts).toBe(1);
      expect(again.marks.get(KEEP)?.state).toBe("supported");
      expect(again.marks.get(RENT)?.state).toBe("supported");
      expect(again.runs.length).toBeGreaterThan(0);
      expect(again.runs.every((call) => sentenceOf(call) === RENT)).toBe(true);
    },
  );

  test("one that would start unasked, at about $0.50 or less, is held to $0.50 where it may cost more, and its card says so", async () => {
    const { first, again } = await readTwice("en", "claude-sonnet-5-5");

    // Not sorted yet, the first read asks, and is held to all it may cost.
    expect(first.plan.parts).toBeNull();
    expect(first.most?.amount).toBeGreaterThan(0.5);
    expect(again.plan.parts).toBe(1);
    expect(
      again.plan.estimate?.billing === "per-token" && again.plan.estimate.cost?.amount,
    ).toBeLessThan(0.5);
    expect(again.most).toEqual({ amount: 0.5, currency: "USD" });
    expect(again.marks.get(RENT)?.state).toBe("supported");
  });
});

/** A paragraph of `sentence`, its check's mark on it as `check` has it. */
const marked = (sentence: string, check: ClaimCheckAttributes): JSONContent => ({
  type: "paragraph",
  attrs: { id: crypto.randomUUID() },
  content: [{ type: "text", text: sentence, marks: [{ type: "claimCheck", attrs: check }] }],
});

describe("What is left of a read its budget stopped", () => {
  const SENTENCE =
    "The tenant may keep a cat, rent is due monthly, and the deposit is two months of rent.";
  const PARTS = [
    "The tenant may keep a cat",
    "rent is due monthly",
    "the deposit is two months of rent",
  ];
  const LEASE = Array.from(
    { length: 400 },
    (_, index) => `Clause ${index + 1} covers the upkeep of the flat and its garden.`,
  ).join("\n\n");
  const unsupported = { verdict: "unsupported" as const };
  const plans = Object.fromEntries([SENTENCE, ...PARTS].map((each) => [each, unsupported]));
  const SPENT: ReportedUsage = {
    inputTokens: { total: 20_000_000, noCache: 20_000_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: undefined },
  };

  test("costs no more than the whole, as it was planned, and less with each part judged", async () => {
    let spend = false;
    const runs: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        runs.push(call);
        const reply = checkReply(call, plans);
        if (!spend || "error" in reply) return reply;
        spend = false;
        return { ...reply, usage: SPENT };
      },
      {
        generate(call) {
          if (!call.system.startsWith("You sort the sentences")) return checkGenerate(plans)(call);
          const sentences = listedSentences(call.prompt).map(({ number, text: said }) => ({
            number,
            parts: (said === SENTENCE ? PARTS : [said]).map((words) => ({
              kind: "fact",
              text: words,
            })),
          }));
          return { text: JSON.stringify({ sentences }) };
        },
      },
    );
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Lease.md", contents: LEASE },
    ]);
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("checks", provider.service.id);
    await core.allowDataFlow("document-check", provider.service.id);
    const chosen = { providerId: provider.id, modelId: "claude-haiku-5-5" };
    const within = { folderIds: [], tagIds: [], documentIds: [documents[0]?.id ?? ""] };
    const write = async (check?: ClaimCheckAttributes) => {
      const block = check ? marked(SENTENCE, check) : note(SENTENCE);
      writeMind(client, [block]);
      await client.settled();
      const blockId = String(block.attrs?.id);
      return { from: { blockId, offset: 0 }, to: { blockId, offset: SENTENCE.length } };
    };
    const mark = () => {
      const [check] = claimSpans(readMind(client)).map((span) => span.check);
      if (!check) throw new Error("The sentence has no mark.");
      return check;
    };
    const about = async (place: Awaited<ReturnType<typeof write>>) => {
      const plan = await core.planDocumentCheck({
        mindId: mind.id,
        ...place,
        within,
        model: chosen,
      });
      if (plan.kind !== "ready" || plan.estimate?.billing !== "per-token") {
        throw new Error("The read has no per-token estimate.");
      }
      return { plan, tokens: plan.estimate.tokens, cost: plan.estimate.cost?.amount ?? 0 };
    };

    let place = await write();
    await core.checkMind({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      mode: "all",
      model: chosen,
    });
    expect(mark().parts?.map((part) => part.verdict)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    const whole = await about(place);
    expect(whole.plan.parts).toBe(3);

    // The read's first request spends past its most: nothing else is sent, and nothing judged.
    spend = true;
    await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-document",
      ...place,
      within,
      plan: whole.plan.id,
      model: chosen,
    });
    await client.settled();
    const stopped = mark();
    expect(stopped.parts?.map((part) => part.reason)).toEqual([
      "read-budget",
      "read-budget",
      "read-budget",
    ]);
    // Every line says the one figure the read had spent when it ended.
    const spent = [stopped.detail, ...(stopped.parts ?? []).map((part) => part.detail)].map(
      (detail) => JSON.parse(detail ?? "null")?.spent,
    );
    expect(new Set(spent.map((each) => JSON.stringify(each))).size).toBe(1);

    const left = await about(place);
    expect(left.plan.parts).toBe(3);
    expect(left.tokens).toBe(whole.tokens);
    expect(left.cost).toBeCloseTo(whole.cost, 12);

    // Judged by the read before it stopped, a part is not read, nor priced, again.
    const judged = (count: number): ClaimCheckAttributes => ({
      ...stopped,
      parts: (stopped.parts ?? []).map((part, index) =>
        index < count ? { ...part, verdict: "unsupported", reason: null, detail: null } : part,
      ),
    });
    place = await write(judged(1));
    const two = await about(place);
    place = await write(judged(2));
    const one = await about(place);
    expect(two.plan.parts).toBe(2);
    expect(one.plan.parts).toBe(1);
    expect(two.tokens).toBeLessThan(left.tokens);
    expect(one.tokens).toBeLessThan(two.tokens);
    // Each part is about a third of the whole: its own search and verdict in the one window.
    expect(two.tokens / whole.tokens).toBeGreaterThan(0.5);
    expect(two.tokens / whole.tokens).toBeLessThan(0.8);
    expect(one.tokens / whole.tokens).toBeGreaterThan(0.2);
    expect(one.tokens / whole.tokens).toBeLessThan(0.5);

    // Continue reads only what is left, and keeps what was judged.
    place = await write(judged(1));
    const plan = (await about(place)).plan;
    const sent = runs.length;
    await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-document",
      ...place,
      within,
      plan: plan.id,
      model: chosen,
    });
    await client.settled();
    const read = runs.slice(sent).filter(isCheckRun).map(sentenceOf);
    expect(read.length).toBeGreaterThan(0);
    expect(read).not.toContain(PARTS[0]);
    expect(mark().parts?.map((part) => part.verdict)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
  });

  test("once its budget stops it, the read sends nothing more, though a smaller request would fit", async () => {
    const FIRST = "The tenant may keep a cat.";
    const SECOND = "Rent is due on the first of each month.";
    const both = { [FIRST]: unsupported, [SECOND]: unsupported };
    // About 40,000 tokens in one window: its verdict sets aside about $0.01, a search about $0.005.
    const long = Array.from(
      { length: 2600 },
      (_, index) => `Clause ${index + 1} covers the upkeep of the flat and its garden.`,
    ).join("\n\n");
    let spending: ReportedUsage | null = null;
    const runs: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        runs.push(call);
        const reply = checkReply(call, both);
        if (!spending || "error" in reply) return reply;
        const usage = spending;
        spending = null;
        return { ...reply, usage };
      },
      { generate: checkGenerate(both) },
    );
    const { core, client, mind, documents } = await setUpWithDocuments(model, [
      { name: "Lease.md", contents: long },
    ]);
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("The test provider has no service.");
    await core.allowDataFlow("document-check", provider.service.id);
    const chosen = { providerId: provider.id, modelId: "claude-haiku-5-5" };
    const block = note(`${FIRST} ${SECOND}`);
    writeMind(client, [block]);
    await client.settled();
    const blockId = String(block.attrs?.id);
    const place = {
      from: { blockId, offset: 0 },
      to: { blockId, offset: FIRST.length + 1 + SECOND.length },
    };
    const within = { folderIds: [], tagIds: [], documentIds: [documents[0]?.id ?? ""] };
    const plan = await core.planDocumentCheck({ mindId: mind.id, ...place, within, model: chosen });
    if (plan.kind !== "ready" || plan.estimate?.billing !== "per-token") {
      throw new Error("The read has no per-token estimate.");
    }
    const most = plan.estimate.upTo?.cost?.amount ?? 0;
    // The first search settles $0.007 short of the budget, at the tier of a prompt over 100,000
    // tokens ($0.50 a million): the verdict can't fit, a search could.
    const tokens = Math.round(((most - 0.007) / 0.5) * 1_000_000);
    expect(tokens).toBeGreaterThan(100_000);
    spending = {
      inputTokens: { total: tokens, noCache: tokens, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: undefined },
    };

    await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-document",
      ...place,
      within,
      plan: plan.id,
      model: chosen,
    });
    await client.settled();

    const marks = claimSpans(readMind(client)).map((span) => span.check);
    expect(marks.map((each) => [each.text, each.reason])).toEqual([
      [FIRST, "read-budget"],
      [SECOND, "read-budget"],
    ]);
    expect(runs.filter(isCheckRun).map(sentenceOf)).toEqual([FIRST]);
    expect(
      new Set(marks.map((each) => JSON.stringify(JSON.parse(each.detail ?? "null")?.spent))).size,
    ).toBe(1);
  });
});

test("the recorded lease's read is held to $0.50 once its parts are sorted, its ceiling at the tier above", async () => {
  const recorded: Recorded = JSON.parse(
    await readFile(join(import.meta.dirname, "../fixtures/cost/recorded-whole-read.json"), "utf8"),
  );
  const unsorted = await readPlans(recorded);
  const sorted = await readPlans(recorded, true);
  for (const sentence of unsorted.keys()) {
    const asked = unsorted.get(sentence);
    const unasked = sorted.get(sentence);
    if (asked?.kind !== "ready" || unasked?.kind !== "ready") throw new Error("Not ready.");
    // Unsorted, it asks, held to its whole ceiling: the 5x tier above 100,000 tokens included.
    expect(asked.parts).toBeNull();
    const ceiling = asked.estimate?.billing === "per-token" ? asked.estimate.upTo?.cost : null;
    expect(ceiling?.amount).toBeGreaterThan(1);
    expect(ceiling?.amount).toBeLessThan(1.2);
    // Sorted, about $0.015, it starts unasked, and the "up to" its card shows is that budget.
    expect(unasked.parts).toBe(1);
    if (unasked.estimate?.billing !== "per-token") throw new Error("No per-token estimate.");
    expect(unasked.estimate.cost?.amount).toBeLessThan(0.02);
    expect(readsUnasked(unasked.estimate, true)).toBe(true);
    expect(unasked.estimate.upTo?.cost).toEqual({ amount: 0.5, currency: "USD" });
  }
});
