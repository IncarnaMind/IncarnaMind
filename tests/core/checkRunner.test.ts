/**
 * One runner takes each claim through its check in every flow (#2897): a provider that says to slow
 * down is waited out and sent again, the spending cap stops the run and marks every claim it
 * leaves, a check has one time limit, and every check a model replied to is in the Note's record
 * of AI use: checked when it gave a verdict, asked when it didn't. Each flow checks the same three claims, in English and Chinese. The models are scripted,
 * and the core's waits are on a clock the test holds (../helpers/heldClock).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { ClaimCheckResult, Core, Document } from "../../src/core";
import { OLLAMA_CLOUD } from "../../src/core/providers/ollamaCloud";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { contradictionWatchOf } from "../../src/shared/contradictionWatch";
import { translate } from "../../src/shared/i18n";
import { askAssistant, changesIn } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder, nextTurn, startCore, tickingClock } from "../helpers/core";
import { addAndProcess, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { checkClock } from "../helpers/heldClock";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { question, readMind, writeMind } from "../helpers/minds";
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
  /** The same, refused on the request after its model's first reply, so a model read it. */
  limitedAfterReply?: readonly [number, number, number];
  /**
   * The plan's limit is reached on the first claim's request after its model's first reply: that
   * request and every one after it are refused, as Ollama Cloud refuses them. In a flow that sends
   * the claims at once, the first claim's reply waits until the others are out.
   */
  planLimit?: true;
  /** The claim whose check never replies. */
  hangs?: number;
  /** The claim whose check's model begins to reply and never ends it. */
  hangsAfterReply?: number;
  /** The monthly cap is reached once the first claim's check has ended, as the next ones start. */
  cap?: true;
  /** The monthly cap is reached before the flow sends any check. */
  capFirst?: true;
  /** The claim whose check's model replies in words no check can read. */
  unreadable?: number;
  /** A reply of its own for a claim's check, by which of its Runs it is, from 1; null: the planned one. */
  reply?(claim: number, run: number, call: ModelCall, planned: ScriptedReply): ScriptedReply | null;
  /** An Answer's model call waits for `until`, and says when it has paused: the background queue waits meanwhile. */
  answer?: { until: Promise<void>; reached(): void };
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
  /** What the flow asks a model before its checks, held until the cap is reached when it comes first. */
  asksFirst?: "sort" | "write";
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
    asksFirst: "sort",
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
    asksFirst: "write",
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
/** What Ollama Cloud answers a request past the plan's weekly limit. */
const PLAN_USED_UP = {
  error: { status: 402, message: "You have reached your weekly usage limit" },
} as const;

/** The model the checks run on: Claude on Anthropic, a cloud model on an Ollama plan, or one on this computer. */
type Model = "cloud" | "plan" | "local";

async function worldOf(example: Example, flow: Flow, kind: Model = "cloud") {
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
  let leftAfterReply = [0, 0, 0];
  let planUsed = false;
  let othersOut: () => void = () => undefined;
  const othersSent = new Promise<void>((resolve) => {
    othersOut = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let replyBegun: () => void = () => undefined;
  const began = new Promise<void>((resolve) => {
    replyBegun = resolve;
  });
  let reachCap: () => Promise<void> = async () => undefined;
  let capReached: Promise<void> | null = null;
  /** Holds a reply until the cap is reached, for a script that reaches it before any check. */
  const beforeTheCap = <T extends object>(reply: T): T | (T & { until: Promise<void> }) => {
    if (!script?.capFirst) return reply;
    capReached ??= reachCap();
    return { ...reply, until: capReached };
  };

  const check = (call: ModelCall): ScriptedReply => {
    const reply = checkReply(call, plans);
    const index = example.claims.indexOf(sentenceOf(call));
    if (!script || index < 0) return reply;
    const first = call.results.length === 0;
    if (first) {
      runs[index as 0 | 1 | 2]++;
      order.push(`${index}:${runs[index]}`);
      if (runs[1] > 0 && runs[2] > 0) othersOut();
    }
    if (planUsed) return PLAN_USED_UP;
    const own = script.reply?.(index, runs[index] ?? 0, call, reply);
    if (own) return own;
    if (first && (left[index] ?? 0) > 0) {
      left[index] = (left[index] ?? 1) - 1;
      return { error: { status: 429, message: "Too many requests." } };
    }
    if (!first && (leftAfterReply[index] ?? 0) > 0) {
      leftAfterReply[index] = (leftAfterReply[index] ?? 1) - 1;
      return { error: { status: 429, message: "Too many requests." } };
    }
    if (script.planLimit && index === 0) {
      if (!first) {
        planUsed = true;
        return PLAN_USED_UP;
      }
      if (!flow.inTurn) return { ...reply, pause: { after: 0, until: othersSent } };
    }
    if (index === script.hangs) return { text: "", pause: { after: 0, until: NEVER } };
    if (index === script.hangsAfterReply)
      return { ...reply, text: "Looking.", pause: { after: 1, until: NEVER, reached: replyBegun } };
    if (
      index === script.unreadable &&
      call.results.some((each) => each.tool === "search_documents")
    )
      return { text: "It reads well to me." };
    // The later claims' checks are let through once the cap is reached (`capAfterFirst`).
    if (script.cap && index > 0 && first) return { ...reply, pause: { after: 0, until: released } };
    return reply;
  };

  const write = (call: ModelCall): ScriptedReply => {
    if (script?.answer)
      return {
        text: "High water comes twice a day.",
        pause: { after: 0, until: script.answer.until, reached: script.answer.reached },
      };
    if (planUsed) return PLAN_USED_UP;
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
      const create = {
        calls: [{ tool: "create_mind", input: { title: example.heading, content } }],
      };
      if (!script?.capFirst) return create;
      capReached ??= reachCap();
      return { ...create, pause: { after: 0, until: capReached } };
    }
    return { text: "Wrote it from your Documents." };
  };

  const model = scriptedModel((call) => (isCheckRun(call) ? check(call) : write(call)), {
    generate: (call) => {
      if (planUsed) return PLAN_USED_UP;
      const reply = checkGenerate(plans)(call);
      return call.question === "find-claims" ? beforeTheCap(reply) : reply;
    },
  });
  const clock = checkClock(LIMIT_MS);
  const background = flow.name === "the background watch";
  const factory = scriptedModels(model);
  const started = startCore(await createTempDataFolder(), {
    createChatModel: factory.createChatModel,
    paceTimers: clock.timers,
    // Only the background watch's own flow watches in the background, as it asks.
    contradictionWatch: { delayMs: background ? 0 : 60_000, claimTimeLimitMs: LIMIT_MS },
    // A watch's record says when it ran: each run's is a later second.
    now: tickingClock(),
  });
  reachCap = async () => {
    await started.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
  };
  started.on("consent.requested", (asked) => void started.respondToConsent(asked.requestId, true));
  // A plan with a weekly limit: a cloud model in Ollama, which sends to ollama.com.
  const provider = await started.saveChatProvider(
    kind === "local"
      ? { kind: "ollama", modelId: "local-model" }
      : kind === "plan"
        ? { kind: "ollama", modelId: "glm-5.3:cloud" }
        : { kind: "anthropic", modelId: "claude-haiku-5-5", apiKey: "sk-ant-test" },
  );
  if (kind !== "local") {
    const service = kind === "plan" ? OLLAMA_CLOUD.id : provider.service?.id;
    if (!service) throw new Error("Anthropic is a service.");
    for (const each of ["chat", "checks", "document-check"] as const)
      await started.allowDataFlow(each, service);
  }
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
  let judgedBefore = { checked: 0, asked: 0 };
  return {
    world,
    runs,
    order,
    plans,
    /** Resolves once a check's model has begun the reply that `hangsAfterReply` holds. */
    began,
    /** How many models the core has been asked to build: one for each run that prepares one. */
    modelsBuilt: () => factory.specs.length,
    async begin(next: Script) {
      judgedBefore = await everyRecorded(started);
      script = next;
      left = [...(next.limited ?? [0, 0, 0])];
      leftAfterReply = [...(next.limitedAfterReply ?? [0, 0, 0])];
      if (next.capFirst && !flow.asksFirst) await reachCap();
    },
    /**
     * Once the first claim's check has ended, judged, and the later ones have started (the one
     * after it, for a flow in turn), reaches the cap and lets them go on.
     */
    async capAfterFirst() {
      await vi.waitFor(
        async () => {
          expect((await everyRecorded(started)).checked - judgedBefore.checked).toBe(1);
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
const everyRecorded = async (core: Core) => {
  const entries = await core.listAiUse();
  return {
    checked: entries.filter((each) => each.kind === "sentence-checked").length,
    asked: entries.filter((each) => each.kind === "sentence-asked").length,
  };
};

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

/** The Note's record of checks: those a model gave a verdict, and those it was sent and left Not checked. */
async function recorded(world: World) {
  const entries = (await world.core.listAiUse()).filter(
    (each) => each.mindId === world.note.mindId,
  );
  return {
    checked: entries.filter((each) => each.kind === "sentence-checked").length,
    asked: entries.filter((each) => each.kind === "sentence-asked").length,
  };
}

interface Case {
  name: string;
  script: Script;
  /** What each claim shows once the flow ran: `ok` for a result that landed as planned. */
  shows(flow: Flow): readonly string[];
  /** Each claim's check Runs, the refused ones included. */
  runs(flow: Flow): readonly number[];
  /** The pauses waited, to the second. */
  pauses: readonly number[];
  /** The checks a model replied to, each a use of AI in the Note's record: checked, or asked. */
  recorded(flow: Flow): { checked: number; asked: number };
}

const RL = "not-checked: rate-limit";
const PLAN = "not-checked: plan-limit";
const CAP = "not-checked: cost-cap";
const TIMED_OUT = "not-checked: timed-out";

const CASES: readonly Case[] = [
  {
    name: "a check that lands normally",
    script: {},
    shows: () => ["ok", "ok", "ok"],
    runs: () => [1, 1, 1],
    pauses: [],
    recorded: () => ({ checked: 3, asked: 0 }),
  },
  {
    name: "a rate limit that clears on the second try is waited out, and the claim lands",
    script: { limited: [1, 0, 0] },
    shows: () => ["ok", "ok", "ok"],
    runs: () => [2, 1, 1],
    pauses: [1_000],
    // A request the provider turned away had no reply: no model ran it.
    recorded: () => ({ checked: 3, asked: 0 }),
  },
  {
    name: "a rate limit that never clears is tried after each pause, then Not checked for it",
    script: { limited: [99, 0, 0] },
    // A run gives up after one round: the claims it hadn't sent aren't sent.
    shows: (flow) => (flow.inTurn && !flow.apart ? [RL, RL, RL] : [RL, "ok", "ok"]),
    runs: (flow) => (flow.inTurn && !flow.apart ? [6, 0, 0] : [6, 1, 1]),
    pauses: [1_000, 2_000, 4_000, 8_000, 16_000],
    recorded: (flow) => ({ checked: flow.inTurn && !flow.apart ? 0 : 2, asked: 0 }),
  },
  {
    name: "a rate limit after the model read the claim, cleared on the second try, is one check",
    script: { limitedAfterReply: [1, 0, 0] },
    shows: () => ["ok", "ok", "ok"],
    runs: () => [2, 1, 1],
    pauses: [1_000],
    recorded: () => ({ checked: 3, asked: 0 }),
  },
  {
    name: "a rate limit after the model read the claim, never cleared, is one check left Not checked",
    script: { limitedAfterReply: [99, 0, 0] },
    shows: (flow) => (flow.inTurn && !flow.apart ? [RL, RL, RL] : [RL, "ok", "ok"]),
    runs: (flow) => (flow.inTurn && !flow.apart ? [6, 0, 0] : [6, 1, 1]),
    pauses: [1_000, 2_000, 4_000, 8_000, 16_000],
    recorded: (flow) => ({ checked: flow.inTurn && !flow.apart ? 0 : 2, asked: 1 }),
  },
  {
    name: "a plan's limit on the first claim stops the run: nothing more is sent, and every claim is Not checked for it",
    script: { planLimit: true },
    shows: () => [PLAN, PLAN, PLAN],
    // In turn, nothing after the limit is sent; at once, the others were out already; each call of
    // the claim-check function is a run of its own, refused by the plan.
    runs: (flow) => (flow.inTurn && !flow.apart ? [1, 0, 0] : [1, 1, 1]),
    pauses: [],
    // A model read each claim it sent before the limit, so each is asked.
    recorded: (flow) => ({ checked: 0, asked: flow.inTurn ? 1 : 3 }),
  },
  {
    name: "the cap reached midway stops the run, and each claim left is Not checked for it",
    script: { cap: true },
    shows: () => ["ok", CAP, CAP],
    runs: (flow) => (flow.inTurn ? [1, 1, 0] : [1, 1, 1]),
    pauses: [],
    // A check whose model replied before the cap stopped its next request was sent: it was asked.
    recorded: (flow) => ({ checked: 1, asked: flow.inTurn ? 1 : 2 }),
  },
  {
    name: "a check with no reply within the time limit is Not checked, and the next lands",
    script: { hangs: 1 },
    shows: () => ["ok", TIMED_OUT, "ok"],
    runs: () => [1, 1, 1],
    pauses: [],
    recorded: () => ({ checked: 2, asked: 0 }),
  },
  {
    name: "a check whose model began to reply and never ended is Not checked at the time limit, and recorded as asked",
    script: { hangsAfterReply: 1 },
    shows: () => ["ok", TIMED_OUT, "ok"],
    runs: () => [1, 1, 1],
    pauses: [],
    recorded: () => ({ checked: 2, asked: 1 }),
  },
  {
    name: "a check its model replied to in words no check can read is Not checked, and recorded as asked",
    script: { unreadable: 1 },
    shows: () => ["ok", "not-checked: malformed", "ok"],
    runs: () => [1, 1, 1],
    pauses: [],
    recorded: () => ({ checked: 2, asked: 1 }),
  },
  {
    name: "a check the cap stops before its first request is Not checked, and isn't recorded",
    script: { capFirst: true },
    shows: () => [CAP, CAP, CAP],
    runs: () => [0, 0, 0],
    pauses: [],
    recorded: () => ({ checked: 0, asked: 0 }),
  },
];

describe.each([EN, ZH])("every check flow, through one runner ($language)", (example) => {
  // protects=each flow waits out a rate limit (1, 2, 4, 8, 16 s) and sends the claim again, ends Not checked on a limit no pause cleared, stops at the cap with every claim left Not checked for it, gives up a check after the one time limit with one message, and records every check a model replied to in the Note's record, checked with a verdict or asked with none, and none a model never got, in English and Chinese (#2897); fails_when=a flow marks a rate limit at once, ends a whole read's part on it, keeps sending after the cap or leaves a claim unmarked, has no time limit, leaves a check a model ran out of the record, or records one no model ran; no_claim=the verdicts, which the claim-check tests cover.
  describe.each(FLOWS)("$name", (flow) => {
    test.each(CASES)("$name", async (each) => {
      const made = await worldOf(example, flow, each.script.planLimit === true ? "plan" : "cloud");
      const { world } = made;
      await flow.setUp?.(world);
      const before = await recorded(world);
      const pausedBefore = world.clock.pauses().length;
      const stopped = each.script.cap || each.script.capFirst || each.script.planLimit;
      if (stopped && flow.asksFirst === "write") world.ends = "failed";
      await made.begin(each.script);

      const running = flow.run(world);
      if (each.script.cap) await made.capAfterFirst();
      const hung = each.script.hangs ?? each.script.hangsAfterReply;
      if (hung !== undefined) {
        if (each.script.hangsAfterReply !== undefined) {
          await made.began;
          await nextTurn();
        }
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
      const after = await recorded(world);
      expect({
        checked: after.checked - before.checked,
        asked: after.asked - before.asked,
      }).toEqual(each.recorded(flow));
      if (hung !== undefined) {
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

describe.each([EN, ZH])(
  "Check this Note stopped while a check its model began to answer is out ($language)",
  (example) => {
    // protects=a check started while the claims were named, which a model replied to and the User then stops, is recorded in the Note's AI use as read by a model and left Not checked, as the checks the run sent itself are (#2909); fails_when=the claim's one record is lost because the early check had not ended when the run did; no_claim=how the card words a Check that was stopped.
    test("is recorded as asked", async () => {
      const flow = FLOWS.find((each) => each.name === "Check this Note");
      if (!flow) throw new Error("Check this Note is a flow.");
      const made = await worldOf(example, flow);
      const { world } = made;
      const before = await recorded(world);
      await made.begin({ hangsAfterReply: 1 });

      const requestId = crypto.randomUUID();
      const running = world.core.checkMind({ requestId, mindId: world.note.mindId, mode: "all" });
      await made.began;
      // The other two have been checked: only the claim whose model began to reply is still out.
      await vi.waitFor(
        async () => {
          expect((await recorded(world)).checked - before.checked).toBe(2);
          expect(world.clock.waiting()).toBe(1);
        },
        { timeout: 20_000 },
      );
      await world.core.cancelCheck(requestId);
      await running;

      const after = await recorded(world);
      expect({
        checked: after.checked - before.checked,
        asked: after.asked - before.asked,
      }).toEqual({
        checked: 2,
        asked: 1,
      });
    });
  },
);

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
  // protects=the background queue runs one check at a time, in the order queued, so a newer watch's check of a claim starts only once the older one's has ended and its result is the one the Note shows; and a check given up at its time limit never lands, even when its reply comes after a newer watch's (#2897); fails_when=a newer watch's check starts while the older one's is out, or the older reply lands last; no_claim=a check on demand beside a background one, which the next describe covers.
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

describe.each([EN, ZH])("a Check for contradictions beside a watch ($language)", (example) => {
  const first = example.claims[0];

  /**
   * Two checks of the first claim at once. The first Run's first request waits for `release`;
   * every request made meanwhile finds the claim contradicted when `meanwhile` says so, as planned,
   * and every one after it when `after` does, and otherwise nothing against it.
   */
  function overlapping(meanwhile: boolean, after: boolean) {
    const gate = Promise.withResolvers<void>();
    let released = false;
    return {
      release() {
        released = true;
        gate.resolve();
      },
      script: {
        reply: (index: number, run: number, call: ModelCall, planned: ScriptedReply) => {
          if (index !== 0) return null;
          const reply = (released ? after : meanwhile)
            ? planned
            : checkReply(call, { [first]: { verdict: "unsupported" } });
          return run === 1 && call.results.length === 0
            ? { ...reply, pause: { after: 0, until: gate.promise } }
            : reply;
        },
      },
    };
  }

  /** Resolves once the Note's last watch is a background one: it names the Document that started it. */
  const backgroundEnded = (client: MindClient) =>
    vi.waitFor(() => expect(contradictionWatchOf(client.doc)?.documentName).toBeTruthy(), {
      timeout: 20_000,
    });

  // protects=a Check for contradictions on demand that began after a background watch's check of the same sentence and ended before it keeps its result: the older check's, coming last, doesn't replace it (#2909); fails_when=the last result to end is the one the Note shows; no_claim=a result that is Supported, which neither can give.
  test("the on-demand check that began last keeps its result when the older background check ends after it", async () => {
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    await BACKGROUND.setUp?.(world);
    // The background watch finds the first claim contradicted but ends after the check on demand,
    // which began later and finds nothing against it.
    const held = overlapping(false, true);
    await made.begin(held.script);

    await newOffice(world, example.added);
    await vi.waitFor(() => expect(made.runs).toEqual([1, 0, 0]), { timeout: 20_000 });
    const onDemand = await world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    expect(onDemand).toMatchObject({ kind: "checked", claims: 3 });
    expect(await shown(world, BACKGROUND)).toEqual(["none", "contradicted", "contradicted"]);

    held.release();
    await vi.waitFor(() => expect(made.runs).toEqual([2, 2, 2]), { timeout: 20_000 });
    await backgroundEnded(world.note.client);

    expect(await shown(world, BACKGROUND)).toEqual(["none", "contradicted", "contradicted"]);
  });

  // protects=a background watch's check that began after a Check for contradictions on demand's of the same sentence keeps its result when the on-demand check ends last (#2909); fails_when=the last result to end is the one the Note shows; no_claim=a result that is Supported, which neither can give.
  test("the background check that began last keeps its result when the older on-demand check ends after it", async () => {
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    await BACKGROUND.setUp?.(world);
    // The check on demand finds nothing against the first claim but ends after the background
    // watch, which began later and finds it contradicted.
    const held = overlapping(true, false);
    await made.begin(held.script);

    const onDemand = world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    await vi.waitFor(() => expect(made.runs).toEqual([1, 1, 1]), { timeout: 20_000 });
    await newOffice(world, example.added);
    await vi.waitFor(() => expect(made.runs).toEqual([2, 2, 2]), { timeout: 20_000 });
    await backgroundEnded(world.note.client);
    expect(await shown(world, BACKGROUND)).toEqual([
      "contradicted",
      "contradicted",
      "contradicted",
    ]);

    held.release();
    expect(await onDemand).toMatchObject({ kind: "checked", claims: 3 });

    expect(await shown(world, BACKGROUND)).toEqual([
      "contradicted",
      "contradicted",
      "contradicted",
    ]);
  });

  // protects=a result that asked no model, as the Not checked a background watch writes on the claims it never sent once a limit has ended its run, never refuses the verdict a model gives a Check for contradictions on demand that began before it (#2909); fails_when=the claims a run left unsent count as the newest check of their sentences, so the on-demand verdict of one is refused when it comes and the Note keeps the Not checked; no_claim=a result that is Supported, which neither can give.
  test("a background watch's Not checked on a sentence it never sent doesn't replace the verdict of the on-demand check still out", async () => {
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    await BACKGROUND.setUp?.(world);
    const before = await recorded(world);
    const second = example.claims[1];
    const gate = Promise.withResolvers<void>();
    await made.begin({
      reply: (claim, run, call) => {
        // The background watch's first claim is refused for too many requests until its run gives
        // up, so the claims after it are left Not checked without being sent.
        if (claim === 0 && run > 1)
          return { error: { status: 429, message: "Too many requests." } };
        if (claim !== 1) return null;
        // The check on demand finds nothing against the second claim, but its reply waits.
        const reply = checkReply(call, { [second]: { verdict: "unsupported" } });
        return call.results.length === 0
          ? { ...reply, pause: { after: 0, until: gate.promise } }
          : reply;
      },
    });

    const onDemand = world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    await vi.waitFor(() => expect(made.runs).toEqual([1, 1, 1]), { timeout: 20_000 });
    // The other two claims have their results: only the second is still out.
    await vi.waitFor(async () => expect((await recorded(world)).checked - before.checked).toBe(2), {
      timeout: 20_000,
    });
    await newOffice(world, example.added);
    await lastWatch(world.note.client, { checked: 0, contradicted: 0 });
    expect(made.runs.slice(1)).toEqual([1, 1]);
    expect(await shown(world, BACKGROUND)).toEqual([RL, RL, RL]);

    gate.resolve();
    expect(await onDemand).toMatchObject({ kind: "checked", claims: 3 });

    expect(await shown(world, BACKGROUND)).toEqual([RL, "none", RL]);
  });

  // protects=a Not checked that a run writes on the claims it never sent, once a limit has ended it, doesn't replace the verdict a model gave a Check for contradictions on demand that began after that run began and has landed (#2909); fails_when=the claims a run left unsent are written as if they were the newest check of their sentences, so the Note keeps the Not checked and the verdict is lost; no_claim=a result that is Supported, which neither can give.
  test("a background run's Not checked on sentences it never sent doesn't replace the verdicts of the on-demand check that began after it and has landed", async () => {
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    const gate = Promise.withResolvers<void>();
    await made.begin({
      reply: (claim, run, call, planned) =>
        // The background watch's first request for the first claim waits: the cap is reached while it does.
        claim === 0 && run === 1 && call.results.length === 0
          ? { ...planned, pause: { after: 0, until: gate.promise } }
          : null,
    });

    // The Note joins the Folder: the background watch begins, with nothing marked in the Note.
    await world.core.moveToFolder({ mindIds: [world.note.mindId], folderId: world.folderId });
    await vi.waitFor(() => expect(made.runs).toEqual([1, 0, 0]), { timeout: 20_000 });
    const onDemand = await world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    expect(onDemand).toMatchObject({ kind: "checked", claims: 3 });
    const found = ["contradicted", "contradicted", "contradicted"];
    expect(await shown(world, BACKGROUND)).toEqual(found);

    // The cap ends the background run at its first claim: the other two are left Not checked.
    await world.core.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
    gate.resolve();
    await lastWatch(world.note.client, { checked: 0, contradicted: 0 });

    expect(made.runs).toEqual([2, 1, 1]);
    expect(await shown(world, BACKGROUND)).toEqual(found);
  });

  // protects=a Not checked that a limit gives the claim at which it ends a background run, before any request of the claim went, is an unsent claim's: it doesn't replace the verdict of a Check for contradictions on demand that began after the run and finished while the claim waited its turn (#2909); fails_when=the claim's check function being called gives its Not checked a place of its own, newer than the Check on demand, so the Note shows the limit where the User just got a verdict; no_claim=a result that is Supported, which neither can give.
  test.each([{ limit: "the monthly cap" }, { limit: "a rate limit" }])(
    "a background run held behind an Answer, then refused by $limit at its first claim, doesn't replace the verdicts of the on-demand check that finished meanwhile",
    async ({ limit }) => {
      const made = await worldOf(example, BACKGROUND);
      const { world } = made;
      const answer = Promise.withResolvers<void>();
      const answerHeld = Promise.withResolvers<void>();
      await made.begin({
        answer: { until: answer.promise, reached: answerHeld.resolve },
        // The background watch's first claim is refused for too many requests until its run gives up.
        reply: (claim, run) =>
          limit === "a rate limit" && claim === 0 && run > 1
            ? { error: { status: 429, message: "Too many requests." } }
            : null,
      });
      const asking = await world.core.createMind({ title: "Questions", folderId: null });
      const questions = await connectToMind(world.core, asking.id);
      const asked = question("When is high water?");
      writeMind(questions, [asked]);
      await questions.settled();
      const answering = await world.core.askQuestion({
        mindId: asking.id,
        questionId: asked.attrs.id,
      });
      if (!answering.asked) throw new Error("The Question wasn't asked.");
      await answerHeld.promise;

      // The Note joins the Folder while the Answer is written: the watch plans its run, and the
      // run's claims wait their turn.
      const built = made.modelsBuilt();
      await world.core.moveToFolder({ mindIds: [world.note.mindId], folderId: world.folderId });
      await vi.waitFor(() => expect(made.modelsBuilt()).toBeGreaterThan(built), {
        timeout: 20_000,
      });
      await nextTurn();
      await nextTurn();
      const onDemand = await world.core.checkContradictions({
        requestId: crypto.randomUUID(),
        mindId: world.note.mindId,
      });
      expect(onDemand).toMatchObject({ kind: "checked", claims: 3 });
      const found = ["contradicted", "contradicted", "contradicted"];
      expect(await shown(world, BACKGROUND)).toEqual(found);
      expect(made.runs).toEqual([1, 1, 1]);

      if (limit === "the monthly cap")
        await world.core.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
      answer.resolve();
      await answerEnded(world.core, answering.answerId);
      await lastWatch(world.note.client, { checked: 0, contradicted: 0 });

      expect(made.runs.slice(1)).toEqual([1, 1]);
      expect(await shown(world, BACKGROUND)).toEqual(found);
    },
  );

  const TOO_MANY = { error: { status: 429, message: "Too many requests." } } as const;

  // protects=a claim that is tried more than once has a place of its own only when a model replied to its last try: a background check that replied once, gave way to an Answer, and is refused for too many requests on every try after, leaves the verdicts of a Check for contradictions on demand that finished meanwhile (#2909); fails_when=a reply to an earlier try gives the last try, which asked no model, a place newer than the Check on demand, so the Note shows the limit where the User just got a verdict; no_claim=the monthly cap, which never refuses a model on this computer, the only kind that gives way to an Answer.
  test("a background check that replied once, gave way to an Answer and is refused on every try after it doesn't replace the verdicts of the on-demand check that finished meanwhile", async () => {
    const made = await worldOf(example, BACKGROUND, "local");
    const { world } = made;
    const answer = Promise.withResolvers<void>();
    const answerHeld = Promise.withResolvers<void>();
    const replied = Promise.withResolvers<void>();
    const holdReply = Promise.withResolvers<void>();
    let limited = false;
    await made.begin({
      answer: { until: answer.promise, reached: answerHeld.resolve },
      reply: (claim, run, call, planned) => {
        if (claim !== 0) return null;
        if (limited) return TOO_MANY;
        // The background watch's first request for the first claim: its model replies, then waits.
        return run === 1 && call.results.length === 0
          ? {
              ...planned,
              text: "Looking.",
              pause: { after: 1, until: holdReply.promise, reached: replied.resolve },
            }
          : null;
      },
    });
    const asking = await world.core.createMind({ title: "Questions", folderId: null });
    const questions = await connectToMind(world.core, asking.id);
    const asked = question("When is high water?");
    writeMind(questions, [asked]);
    await questions.settled();

    await world.core.moveToFolder({ mindIds: [world.note.mindId], folderId: world.folderId });
    await replied.promise;
    // The Question starts an Answer: the check, on a model on this computer, gives way to it.
    const answering = await world.core.askQuestion({
      mindId: asking.id,
      questionId: asked.attrs.id,
    });
    if (!answering.asked) throw new Error("The Question wasn't asked.");
    await answerHeld.promise;
    const onDemand = await world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    expect(onDemand).toMatchObject({ kind: "checked", claims: 3 });
    const found = ["contradicted", "contradicted", "contradicted"];
    expect(await shown(world, BACKGROUND)).toEqual(found);

    // The Answer ends and the check runs again, and every request it makes is refused.
    limited = true;
    answer.resolve();
    await answerEnded(world.core, answering.answerId);
    await lastWatch(world.note.client, { checked: 0, contradicted: 0 });
    holdReply.resolve();

    expect(made.runs.slice(1)).toEqual([1, 1]);
    expect(await shown(world, BACKGROUND)).toEqual(found);
  });

  // protects=the same, for a check that replied to its first try and was refused for too many requests at its next request, then on every try after, while a Check for contradictions on demand finished (#2909); fails_when=a reply to the first try gives the last try, which asked no model, a place newer than the Check on demand; no_claim=a result that is Supported, which neither can give.
  test("a check that replied to its first try and is refused on every try after it doesn't replace the verdicts of the on-demand check that finished meanwhile", async () => {
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    const replied = Promise.withResolvers<void>();
    const holdReply = Promise.withResolvers<void>();
    let limited = false;
    await made.begin({
      reply: (claim, run, call, planned) => {
        if (claim !== 0) return null;
        if (limited) return TOO_MANY;
        return run === 1 && call.results.length === 0
          ? {
              ...planned,
              text: "Looking.",
              pause: { after: 1, until: holdReply.promise, reached: replied.resolve },
            }
          : null;
      },
    });

    await world.core.moveToFolder({ mindIds: [world.note.mindId], folderId: world.folderId });
    await replied.promise;
    const onDemand = await world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    expect(onDemand).toMatchObject({ kind: "checked", claims: 3 });
    const found = ["contradicted", "contradicted", "contradicted"];
    expect(await shown(world, BACKGROUND)).toEqual(found);

    // The first try goes on, is refused at its next request, and so is every try after it.
    limited = true;
    holdReply.resolve();
    await lastWatch(world.note.client, { checked: 0, contradicted: 0 });

    expect(made.runs.slice(1)).toEqual([1, 1]);
    expect(await shown(world, BACKGROUND)).toEqual(found);
  });

  // protects=a Not checked from a claim's last try, which a model replied to before it was refused, has a place of its own and refuses the verdict of a Check for contradictions on demand that began before it and lands after it (#2909); fails_when=such a Not checked is treated as an unsent claim's, so the older verdict replaces it; no_claim=a result that is Supported, which neither can give.
  test("a background check refused after its model replied keeps its Not checked when the older on-demand check ends after it", async () => {
    const made = await worldOf(example, BACKGROUND);
    const { world } = made;
    await BACKGROUND.setUp?.(world);
    const gate = Promise.withResolvers<void>();
    await made.begin({
      reply: (claim, run, call, planned) => {
        if (claim !== 0) return null;
        // The check on demand finds nothing against the first claim, but its reply waits.
        if (run === 1) {
          const reply = checkReply(call, { [first]: { verdict: "unsupported" } });
          return call.results.length === 0
            ? { ...reply, pause: { after: 0, until: gate.promise } }
            : reply;
        }
        // The background watch's tries: its model replies to each, and its next request is refused.
        return call.results.length === 0 ? planned : TOO_MANY;
      },
    });

    const onDemand = world.core.checkContradictions({
      requestId: crypto.randomUUID(),
      mindId: world.note.mindId,
    });
    await vi.waitFor(() => expect(made.runs).toEqual([1, 1, 1]), { timeout: 20_000 });
    await newOffice(world, example.added);
    await lastWatch(world.note.client, { checked: 0, contradicted: 0 });
    expect(await shown(world, BACKGROUND)).toEqual([RL, RL, RL]);

    gate.resolve();
    expect(await onDemand).toMatchObject({ kind: "checked", claims: 3 });

    expect(await shown(world, BACKGROUND)).toEqual([RL, RL, RL]);
  });
});
