/**
 * One runner takes each claim through its check in every flow (#2897): a provider that says to slow
 * down is waited out and sent again, the spending cap stops the run and marks every claim it
 * leaves, a check has one time limit, and every check a model judged is in the Note's record of
 * AI use. Each flow checks the same three claims, in English and Chinese. The models are scripted,
 * and the core's waits are on a clock the test holds (../helpers/heldClock).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { ClaimCheckResult, Core, Document } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { contradictionWatchOf } from "../../src/shared/contradictionWatch";
import { translate } from "../../src/shared/i18n";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, nextTurn, startCore, tickingClock } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { checkClock } from "../helpers/heldClock";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { verifyWordFile } from "../helpers/verifiedWord";
import { wordFile, paragraph as wordParagraph } from "../helpers/word";

const LIMIT_MS = 60_000;
const NEVER = new Promise<void>(() => undefined);

interface Example {
  language: "en" | "zh-CN";
  /** Three claims, each as the tides Document states it. */
  claims: readonly [string, string, string];
  /** What the harbour office's note says against each. */
  against: readonly [string, string, string];
  /** A line the office's next version adds. */
  added: string;
  names: { tides: string; office: string; report: string };
  heading: string;
}

const EN: Example = {
  language: "en",
  claims: [
    "Spring tides come at new and full moon.",
    "Harbours publish the times of high water every year.",
    "Neap tides come at the quarter moons.",
  ],
  against: [
    "Spring tides come only at full moon.",
    "Harbours publish the times of high water every week.",
    "Neap tides come only at new moon.",
  ],
  added: "The harbour office opens at nine.",
  names: { tides: "Tides.md", office: "Harbour office.md", report: "Harbour report.docx" },
  heading: "Notes",
};

const ZH: Example = {
  language: "zh-CN",
  claims: ["大潮出现在新月和满月。", "港口每年公布高潮时间。", "小潮出现在上弦月和下弦月。"],
  against: ["大潮只在满月时出现。", "港口每周公布高潮时间。", "小潮只在新月时出现。"],
  added: "港务处九点开门。",
  names: { tides: "潮汐.md", office: "港务处.md", report: "港口报告.docx" },
  heading: "笔记",
};

/** A line as a Citation quotes it: without its full stop. */
const quoteOf = (line: string) => line.replace(/[.。]$/u, "");

/** What the test does to the claims' checks while a flow runs. */
interface Script {
  /** How often each claim's check is refused for too many requests before one is let through. */
  limited?: readonly [number, number, number];
  /** The claim whose check never replies. */
  hangs?: number;
  /** The monthly cap is reached once the first claim's check has ended, as the next ones start. */
  cap?: true;
  /** A reply of its own for a claim's check, by which of its Runs it is, from 1; null: the planned one. */
  reply?(claim: number, run: number, call: ModelCall, planned: ScriptedReply): ScriptedReply | null;
}

interface World {
  core: Core;
  example: Example;
  clock: ReturnType<typeof checkClock>;
  folderId: string;
  tides: Document;
  office: Document;
  /** The Note the flow checks, or the one it wrote. */
  note: { mindId: string; client: MindClient };
  /** The claims' results, for a flow that lands none in a Note. */
  results: (ClaimCheckResult | null)[];
  /** How the assistant's Answer ends: a cap reached after the write stops its last turn too. */
  ends: "finished" | "failed";
}

interface Flow {
  name: string;
  /** Checks one claim at a time, so a stop leaves those after it unsent. */
  inTurn: boolean;
  /** Each claim is a call of its own: a limit no pause cleared ends only that claim. */
  apart?: true;
  /** The contradiction watch: only a contradiction is marked, and a claim it can't check says so on that mark. */
  watch?: true;
  /** Done before the script applies. */
  setUp?(world: World): Promise<void>;
  run(world: World): Promise<void>;
}

const text = (value: string): JSONContent => ({ type: "text", text: value });

/** The claims in one paragraph; each followed by its Citation of the tides Document, for the watch. */
function claimsParagraph(example: Example, tides: Document, withCitations: boolean): JSONContent {
  if (!withCitations)
    return {
      type: "paragraph",
      attrs: { id: "claims" },
      content: [text(example.claims.join(" "))],
    };
  return {
    type: "paragraph",
    attrs: { id: "claims" },
    content: example.claims.flatMap((claim, index) => [
      text(index === 0 ? claim : ` ${claim}`),
      {
        type: "citation",
        attrs: {
          passageId: "passage-1",
          documentId: tides.id,
          documentName: tides.name,
          contentHash: tides.contentHash,
          pageFrom: null,
          pageTo: null,
          location: null,
          quote: quoteOf(claim),
          check: "found",
          checkReason: null,
        },
      },
    ]),
  };
}

const allClaims = (example: Example) => ({
  from: { blockId: "claims", offset: 0 },
  to: { blockId: "claims", offset: example.claims.join(" ").length },
});

/** Resolves once the Note's last background watch record is a newer one than `before`. */
async function watched(client: MindClient, before: string | null) {
  await vi.waitFor(
    () => {
      const run = contradictionWatchOf(client.doc);
      expect(run?.at).toBeDefined();
      expect(run?.at).not.toBe(before);
    },
    { timeout: 20_000 },
  );
}

const FLOWS: readonly Flow[] = [
  {
    name: "Check against Documents",
    inTurn: true,
    async run({ core, note, example }) {
      await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: note.mindId,
        action: "check-against-documents",
        ...allClaims(example),
      });
    },
  },
  {
    name: "Check against a Document…, read whole",
    inTurn: true,
    async run({ core, note, tides, example }) {
      const within = { folderIds: [], tagIds: [], documentIds: [tides.id] };
      const plan = await core.planDocumentCheck({
        mindId: note.mindId,
        ...allClaims(example),
        within,
      });
      if (plan.kind !== "ready") throw new Error(`The tides can't be read whole: ${plan.kind}.`);
      await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: note.mindId,
        action: "check-against-document",
        ...allClaims(example),
        within,
        plan: plan.id,
      });
    },
  },
  {
    name: "Verify",
    inTurn: false,
    async setUp(world) {
      const { core, example } = world;
      const path = join(await createTempDataFolder(), example.names.report);
      await writeFile(
        path,
        wordFile({ body: example.claims.map((claim) => wordParagraph(claim)).join("") }),
      );
      const made = await verifyWordFile(core, path);
      world.note = { mindId: made.mind.id, client: made.client };
      expect(
        await core.findClaims({ requestId: crypto.randomUUID(), mindId: made.mind.id }),
      ).toEqual({ kind: "found", claims: 3 });
    },
    async run({ core, note }) {
      await core.verifyClaims({ requestId: crypto.randomUUID(), mindId: note.mindId });
    },
  },
  {
    name: "Check this Note",
    inTurn: false,
    async run({ core, note }) {
      await core.checkMind({ requestId: crypto.randomUUID(), mindId: note.mindId, mode: "all" });
    },
  },
  {
    name: "Check for contradictions",
    inTurn: false,
    watch: true,
    async setUp({ core, note }) {
      await core.checkContradictions({ requestId: crypto.randomUUID(), mindId: note.mindId });
    },
    async run({ core, note }) {
      await core.checkContradictions({ requestId: crypto.randomUUID(), mindId: note.mindId });
    },
  },
  {
    name: "the background watch",
    inTurn: true,
    watch: true,
    async setUp({ core, note, folderId }) {
      // A Note that joins the Folder is watched in the background, as for a new version.
      await core.moveToFolder({ mindIds: [note.mindId], folderId });
      await watched(note.client, null);
    },
    async run({ core, note, office, example }) {
      const before = contradictionWatchOf(note.client.doc)?.at ?? null;
      await writeFile(
        office.path,
        `# ${example.names.office}\n\n${example.against.join(" ")} ${example.added}\n`,
      );
      await core.reconcileDocuments();
      await waitForProcessing(core, [office.id]);
      await watched(note.client, before);
    },
  },
  {
    name: "the assistant's writing",
    inTurn: false,
    async run(world) {
      const { core, folderId } = world;
      const answer = await askAssistant(
        core,
        {
          text: "Summarise these Documents into a new note",
          scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
        },
        world.ends,
      );
      const mindId = changesIn(answer)[0]?.mindId ?? "";
      world.note = { mindId, client: await connectToMind(core, mindId) };
    },
  },
  {
    name: "the claim-check function",
    inTurn: true,
    apart: true,
    async run(world) {
      const { core, folderId, note, example } = world;
      for (const [index, claim] of example.claims.entries()) {
        world.results[index] = await core.checkClaim({
          claim,
          scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
          mindId: note.mindId,
        });
      }
    },
  },
];

/**
 * A core with the tides Document and the harbour office's note in a Folder, on a cloud model the
 * User allowed every flow to, and a Note there holding the three claims. The scripted model checks
 * as `plans` say, and writes the claims with their Citations when the assistant is asked to; once
 * `begin` is called, it does to the checks what the script says, and counts their Runs.
 */
async function worldOf(example: Example, flow: Flow) {
  const plans: Record<string, Plan> = Object.fromEntries(
    example.claims.map((claim, index) => {
      const against = example.against[index] ?? "";
      return [
        claim,
        flow.watch
          ? { verdict: "contradicted", quote: quoteOf(against), says: against }
          : { verdict: "supported", quote: quoteOf(claim), says: claim },
      ];
    }),
  );
  let script: Script | null = null;
  const runs: [number, number, number] = [0, 0, 0];
  /** Each check Run as it started: its claim, and which of that claim's Runs it is. */
  const order: string[] = [];
  let left = [0, 0, 0];
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const check = (call: ModelCall): ScriptedReply => {
    const reply = checkReply(call, plans);
    const index = example.claims.indexOf(sentenceOf(call));
    if (!script || index < 0) return reply;
    const first = call.results.length === 0;
    if (first) {
      runs[index as 0 | 1 | 2]++;
      order.push(`${index}:${runs[index]}`);
    }
    const own = script.reply?.(index, runs[index] ?? 0, call, reply);
    if (own) return own;
    if (first && (left[index] ?? 0) > 0) {
      left[index] = (left[index] ?? 1) - 1;
      return { error: { status: 429, message: "Too many requests." } };
    }
    if (index === script.hangs) return { text: "", pause: { after: 0, until: NEVER } };
    // The later claims' checks are let through once the cap is reached (`capAfterFirst`).
    if (script.cap && index > 0 && first) return { ...reply, pause: { after: 0, until: released } };
    return reply;
  };

  const write = (call: ModelCall): ScriptedReply => {
    const search = call.results.find((result) => result.tool === "search_documents");
    if (!search)
      return { calls: [{ tool: "search_documents", input: { query: example.claims[0] } }] };
    if (!call.results.some((result) => result.tool === "cite")) {
      const passage = shownPassages(search.text).find((each) =>
        each.text.includes(quoteOf(example.claims[0])),
      );
      const citations = example.claims.map((claim, index) => ({
        marker: index + 1,
        passage: passage?.id,
        quote: quoteOf(claim),
      }));
      return { calls: [{ tool: "cite", input: { citations } }] };
    }
    if (!call.results.some((result) => result.tool === "create_mind")) {
      const body = example.claims.map((claim, index) => `${claim}[^${index + 1}]`).join(" ");
      const content = `## ${example.heading}\n\n${body}`;
      return { calls: [{ tool: "create_mind", input: { title: example.heading, content } }] };
    }
    return { text: "Wrote it from your Documents." };
  };

  const model = scriptedModel((call) => (isCheckRun(call) ? check(call) : write(call)), {
    generate: checkGenerate(plans),
  });
  const clock = checkClock(LIMIT_MS);
  const background = flow.name === "the background watch";
  const started = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    paceTimers: clock.timers,
    // Only the background watch's own flow watches in the background, as it asks.
    contradictionWatch: { delayMs: background ? 0 : 60_000, claimTimeLimitMs: LIMIT_MS },
    // A watch's record says when it ran: each run's is a later second.
    now: tickingClock(),
  });
  started.on("consent.requested", (asked) => void started.respondToConsent(asked.requestId, true));
  const provider = await started.saveChatProvider({
    kind: "anthropic",
    modelId: "claude-haiku-5-5",
    apiKey: "sk-ant-test",
  });
  const service = provider.service?.id;
  if (!service) throw new Error("Anthropic is a service.");
  for (const each of ["chat", "checks", "document-check"] as const)
    await started.allowDataFlow(each, service);
  await started.updateSettings({ user: { language: example.language } });
  const sources = await createTempDataFolder();
  const [tides, office] = (await addAndProcess(started, [
    await writeSourceFile(sources, example.names.tides, `# Tides\n\n${example.claims.join(" ")}\n`),
    await writeSourceFile(
      sources,
      example.names.office,
      `# ${example.names.office}\n\n${example.against.join(" ")}\n`,
    ),
  ])) as [Document, Document];
  const folder = await started.createLibraryGroup({ name: "Harbours", description: "" });
  await started.moveToFolder({ documentIds: [tides.id, office.id], folderId: folder.id });
  // Outside the Folder for the background watch, which joining it starts.
  const mind = await started.createMind({
    title: "Harbour",
    folderId: background ? null : folder.id,
  });
  const client = await connectToMind(started, mind.id);
  writeMind(client, [claimsParagraph(example, tides, flow.watch === true)]);
  await client.settled();

  const world: World = {
    core: started,
    example,
    clock,
    folderId: folder.id,
    tides,
    office,
    note: { mindId: mind.id, client },
    results: [null, null, null],
    ends: "finished",
  };
  let judgedBefore = 0;
  return {
    world,
    runs,
    order,
    plans,
    async begin(next: Script) {
      judgedBefore = await everyRecorded(started);
      script = next;
      left = [...(next.limited ?? [0, 0, 0])];
    },
    /**
     * Once the first claim's check has ended, judged, and the later ones have started (the one
     * after it, for a flow in turn), reaches the cap and lets them go on.
     */
    async capAfterFirst() {
      await vi.waitFor(
        async () => {
          expect((await everyRecorded(started)) - judgedBefore).toBe(1);
          expect(runs.slice(1)).toEqual(flow.inTurn ? [1, 0] : [1, 1]);
        },
        { timeout: 20_000 },
      );
      await started.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
      release();
    },
  };
}

/** Every check recorded as a use of AI, in any Note: the assistant's writes its own. */
const everyRecorded = async (core: Core) =>
  (await core.listAiUse()).filter((each) => each.kind === "sentence-checked").length;

/** What the User sees of each claim: its result, or none. */
async function shown(world: World, flow: Flow): Promise<string[]> {
  if (flow.apart)
    return world.results.map((result) =>
      result === null
        ? "none"
        : result.verdict === "not-checked"
          ? `not-checked: ${result.reason}`
          : result.verdict,
    );
  const { client } = world.note;
  await client.settled();
  const versions = new Map(
    (await world.core.listDocuments()).map((each) => [each.id, each.contentHash]),
  );
  const spans = claimSpans(readMind(client));
  return world.example.claims.map((claim) => {
    const span = spans.find((each) => each.sentence.text.replace(/￼/gu, "").trim() === claim);
    if (!span) return "none";
    const seen = claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId: world.folderId,
      scope: null,
    });
    return seen.state === "not-checked" ? `not-checked: ${seen.reason}` : seen.state;
  });
}

/** The time limit's detail on the second claim's result: the limit, in seconds. */
async function timedOutDetail(world: World, flow: Flow): Promise<string | null> {
  if (flow.apart) {
    const result = world.results[1];
    return result?.verdict === "not-checked" ? result.detail : null;
  }
  const spans = claimSpans(readMind(world.note.client));
  const claim = world.example.claims[1];
  return (
    spans.find((each) => each.sentence.text.replace(/￼/gu, "").trim() === claim)?.check.detail ??
    null
  );
}

const recorded = async (world: World) =>
  (await world.core.listAiUse()).filter(
    (each) => each.kind === "sentence-checked" && each.mindId === world.note.mindId,
  ).length;

interface Case {
  name: string;
  script: Script;
  /** What each claim shows once the flow ran: `ok` for a result that landed as planned. */
  shows(flow: Flow): readonly string[];
  /** Each claim's check Runs, the refused ones included. */
  runs(flow: Flow): readonly number[];
  /** The pauses waited, to the second. */
  pauses: readonly number[];
  /** The checks a model judged, each a use of AI in the Note's record. */
  recorded(flow: Flow): number;
}

const RL = "not-checked: rate-limit";
const CAP = "not-checked: cost-cap";
const TIMED_OUT = "not-checked: timed-out";

const CASES: readonly Case[] = [
  {
    name: "a check that lands normally",
    script: {},
    shows: () => ["ok", "ok", "ok"],
    runs: () => [1, 1, 1],
    pauses: [],
    recorded: () => 3,
  },
  {
    name: "a rate limit that clears on the second try is waited out, and the claim lands",
    script: { limited: [1, 0, 0] },
    shows: () => ["ok", "ok", "ok"],
    runs: () => [2, 1, 1],
    pauses: [1_000],
    recorded: () => 3,
  },
  {
    name: "a rate limit that never clears is tried after each pause, then Not checked for it",
    script: { limited: [99, 0, 0] },
    // A run gives up after one round: the claims it hadn't sent aren't sent.
    shows: (flow) => (flow.inTurn && !flow.apart ? [RL, RL, RL] : [RL, "ok", "ok"]),
    runs: (flow) => (flow.inTurn && !flow.apart ? [6, 0, 0] : [6, 1, 1]),
    pauses: [1_000, 2_000, 4_000, 8_000, 16_000],
    recorded: (flow) => (flow.inTurn && !flow.apart ? 0 : 2),
  },
  {
    name: "the cap reached midway stops the run, and each claim left is Not checked for it",
    script: { cap: true },
    shows: () => ["ok", CAP, CAP],
    runs: (flow) => (flow.inTurn ? [1, 1, 0] : [1, 1, 1]),
    pauses: [],
    recorded: () => 1,
  },
  {
    name: "a check with no reply within the time limit is Not checked, and the next lands",
    script: { hangs: 1 },
    shows: () => ["ok", TIMED_OUT, "ok"],
    runs: () => [1, 1, 1],
    pauses: [],
    recorded: () => 2,
  },
];

describe.each([EN, ZH])("every check flow, through one runner ($language)", (example) => {
  // protects=each flow waits out a rate limit (1, 2, 4, 8, 16 s) and sends the claim again, ends Not checked on a limit no pause cleared, stops at the cap with every claim left Not checked for it, gives up a check after the one time limit with one message, and records every check a model judged in the Note's record, in English and Chinese (#2897); fails_when=a flow marks a rate limit at once, ends a whole read's part on it, keeps sending after the cap or leaves a claim unmarked, has no time limit, or leaves a check out of the record; no_claim=the verdicts, which the claim-check tests cover.
  describe.each(FLOWS)("$name", (flow) => {
    test.each(CASES)("$name", async (each) => {
      const made = await worldOf(example, flow);
      const { world } = made;
      await flow.setUp?.(world);
      const before = await recorded(world);
      const pausedBefore = world.clock.pauses().length;
      if (each.script.cap && flow.name === "the assistant's writing") world.ends = "failed";
      await made.begin(each.script);

      const running = flow.run(world);
      if (each.script.cap) await made.capAfterFirst();
      if (each.script.hangs !== undefined) {
        // Only the hung check is still waiting on its time limit.
        await vi.waitFor(
          () => {
            expect(made.runs[1]).toBe(1);
            expect(world.clock.waiting()).toBe(1);
          },
          { timeout: 20_000 },
        );
        world.clock.timeOut();
      }
      await running;

      const ok = flow.watch ? "contradicted" : "supported";
      expect(await shown(world, flow)).toEqual(
        each.shows(flow).map((state) => (state === "ok" ? ok : state)),
      );
      expect(made.runs).toEqual(each.runs(flow));
      expect(
        world.clock
          .pauses()
          .slice(pausedBefore)
          .map((ms) => Math.ceil(ms / 1000) * 1000),
      ).toEqual(each.pauses);
      expect((await recorded(world)) - before).toBe(each.recorded(flow));
      if (each.script.hangs !== undefined) {
        const detail = await timedOutDetail(world, flow);
        expect(detail).toBe("60");
        expect(
          translate(example.language, "claim.reason.timed-out", { detail: detail ?? "" }),
        ).toBe(
          example.language === "en"
            ? "The model didn’t reply within 60 seconds."
            : "模型在 60 秒内没有回复。",
        );
      }
    });
  });
});

const BACKGROUND: Flow = (() => {
  const flow = FLOWS.find((each) => each.name === "the background watch");
  if (!flow) throw new Error("The background watch is a flow.");
  return flow;
})();

/** A new version of the harbour office's note, which watches its Folder's Notes again. */
async function newOffice(world: World, line: string) {
  const { core, office, example } = world;
  await writeFile(
    office.path,
    `# ${example.names.office}\n\n${example.against.join(" ")} ${line}\n`,
  );
  await core.reconcileDocuments();
  await waitForProcessing(core, [office.id]);
}

/** The Note's last background watch, once it is the one that checked and found these. */
async function lastWatch(client: MindClient, found: { checked: number; contradicted: number }) {
  await vi.waitFor(() => expect(contradictionWatchOf(client.doc)).toMatchObject(found), {
    timeout: 20_000,
  });
}

describe.each([EN, ZH])("two background watches of one Note ($language)", (example) => {
  // protects=the background queue runs one check at a time, in the order queued, so a newer watch's check of a claim starts only once the older one's has ended and its result is the one the Note shows; and a check given up at its time limit never lands, even when its reply comes after a newer watch's (#2897); fails_when=a newer watch's check starts while the older one's is out, or the older reply lands last; no_claim=a check on demand beside a background one, which no queue orders.
  test("a newer watch's check starts once the older one's has ended, and its result stands", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    await BACKGROUND.setUp?.(world);
    // The first claim: contradicted by the first watch, after the second is waiting; then not.
    await made.begin({
      reply: (claim, run, call, planned) => {
        if (claim !== 0) return null;
        if (run > 1) return checkReply(call, { [example.claims[0]]: { verdict: "unsupported" } });
        return call.results.length === 0
          ? { ...planned, pause: { after: 0, until: firstHeld } }
          : null;
      },
    });

    await newOffice(world, example.added);
    await vi.waitFor(() => expect(made.runs).toEqual([1, 0, 0]), { timeout: 20_000 });
    await newOffice(world, `${example.added} ${example.added}`);
    // The newer watch has had every turn it needs to start, but for the queue.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTurn();
    expect(made.runs).toEqual([1, 0, 0]);
    releaseFirst();
    await lastWatch(world.note.client, { checked: 3, contradicted: 2 });

    expect(made.order).toEqual(["0:1", "1:1", "2:1", "0:2", "1:2", "2:2"]);
    expect(await shown(world, BACKGROUND)).toEqual(["none", "contradicted", "contradicted"]);
  });

  test("a check given up at its time limit never lands, even after a newer watch's", async () => {
    let replyLate: () => void = () => undefined;
    const late = new Promise<void>((resolve) => {
      replyLate = resolve;
    });
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    await BACKGROUND.setUp?.(world);
    await made.begin({
      reply: (claim, run, call, planned) => {
        if (claim !== 0) return null;
        if (run > 1) return checkReply(call, { [example.claims[0]]: { verdict: "unsupported" } });
        return { ...planned, pause: { after: 0, until: late } };
      },
    });

    await newOffice(world, example.added);
    await vi.waitFor(
      () => {
        expect(made.runs).toEqual([1, 0, 0]);
        expect(world.clock.waiting()).toBe(1);
      },
      { timeout: 20_000 },
    );
    world.clock.timeOut();
    await lastWatch(world.note.client, { checked: 2, contradicted: 2 });
    expect(await shown(world, BACKGROUND)).toEqual([TIMED_OUT, "contradicted", "contradicted"]);

    await newOffice(world, `${example.added} ${example.added}`);
    await vi.waitFor(() => expect(made.runs).toEqual([2, 2, 2]), { timeout: 20_000 });
    await vi.waitFor(async () =>
      expect(await shown(world, BACKGROUND)).toEqual(["none", "contradicted", "contradicted"]),
    );
    replyLate();
    await nextTurn();
    await nextTurn();

    expect(await shown(world, BACKGROUND)).toEqual(["none", "contradicted", "contradicted"]);
  });
});
