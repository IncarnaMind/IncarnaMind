/**
 * Check this note (#737): every sentence of a Mind that makes a claim,
 * checked in one run; then only what changed. Headings, questions and the
 * User's own opinions are left out, as the model names the claims.
 */
import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { JSONContent } from "@tiptap/core";
import { wrapLanguageModel } from "ai";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { CheckMindInput, Core, Reranker } from "../../src/core";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { claimPartsReader } from "../../src/core/answers/checks/claims";
import { updateCheck } from "../../src/core/answers/checks/sentences";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_SETTINGS_FIELD,
} from "../../src/core/api";
import { createFakeCrossEncoder } from "../../src/core/reranking/fake";
import { createRerankQueue } from "../../src/core/reranking/order";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { keepCheckAsView } from "../../src/shared/claimParts";
import { readFigures } from "../../src/shared/figures";
import { mindCheckOf, sentenceKey, writeMindCheck } from "../../src/shared/mindCheck";
import { setMindModel } from "../../src/shared/mindModel";
import { readOpinionSentences } from "../../src/shared/opinions";
import { recordCiteSettingsOf, writeRecordCiteChoice } from "../../src/shared/recordCiteChoices";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  requestedFigures,
  sentenceOf,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, waitForDocuments, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { editMind, readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  promptText,
  type ReportedUsage,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { wordFile, paragraph as wordParagraph } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const TIDES = {
  name: "Tides.md",
  contents:
    "# Tides\n\nSpring tides come at new and full moon. Spring tides come at the full moon.\n",
};
const OFFICE = {
  name: "Harbour office.md",
  contents:
    "# Harbour office\n\nThe harbour office publishes the times of high water every week.\n",
};

const MOON = "Spring tides come at new and full moon.";
const YEARLY = "Harbours publish the times of high water every year.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const QUESTION = "Does high water come at noon on Sundays?";
const OPINION = "We think the harbour office is very helpful.";

const FULL = "Spring tides come at the full moon.";
const STOPLESS = FULL.slice(0, -1);

const PLANS: Record<string, Plan> = {
  [MOON]: { verdict: "supported", quote: MOON },
  [STOPLESS]: {
    verdict: "contradicted",
    quote: FULL,
    says: "Roles: Spring tides come at the full moon / Spring tides come at the full moon, same. The quote gives it another way.",
    judgement: "same",
  },
  [YEARLY]: {
    verdict: "contradicted",
    quote: "The harbour office publishes the times of high water every week.",
    says: "The harbour office says every week, not every year.",
  },
  [PENGUINS]: { verdict: "unsupported" },
  [`Big ${MOON}`]: { verdict: "unsupported" },
  [`Some ${PENGUINS}`]: { verdict: "unsupported" },
};

const text = (value: string): JSONContent => ({ type: "text", text: value });

const unbackedFigures = (call: ModelCall) =>
  `Figures: ${JSON.stringify({
    items: requestedFigures(call).map(({ id }) => ({
      id,
      verdict: "unsupported",
      scope: "same",
      topic: "not found",
      roles: "same",
      says: null,
      reading: null,
      relation: "equals",
      source: null,
      calculation: null,
    })),
    remainder: null,
  })}`;

interface SortDecisions {
  sentences: { number: number; parts: { kind: "fact" | "opinion"; text: string }[] }[];
}

/** The numbers a request listed `sentence` under. */
const numbersOf = (call: GenerateCall, sentence: string): number[] =>
  listedSentences(call.prompt).flatMap((listed) =>
    listed.text === sentence ? [listed.number] : [],
  );

/** A reply's decisions without those of `sentences`. */
const withoutDecisions =
  (sentences: readonly string[]) =>
  (call: GenerateCall, decisions: SortDecisions): SortDecisions => {
    const missing = new Set(sentences.flatMap((sentence) => numbersOf(call, sentence)));
    return { sentences: decisions.sentences.filter((sentence) => !missing.has(sentence.number)) };
  };

/** The check Runs made: each starts with a call that has no Tool results yet. */
const runsIn = (calls: readonly ModelCall[]) =>
  calls.filter((call) => isCheckRun(call) && call.results.length === 0);

/**
 * A core with the two Documents in a Folder, a model on this computer (or,
 * `billed`, one billed per token, each request reporting its tokens), and
 * every call to it kept.
 */
async function setUp(
  billed?: { usage: ReportedUsage; judged?: ReportedUsage },
  /** How a reply naming the claims differs from the plans' decisions, by how many were asked. */
  decide?: (asked: number, call: GenerateCall, decisions: SortDecisions) => SortDecisions,
) {
  const checks: ModelCall[] = [];
  const finds: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      checks.push(call);
      const reply = checkReply(call, PLANS);
      return requestedFigures(call).length > 0 &&
        call.results.some((result) => result.tool === "search_documents") &&
        "text" in reply &&
        reply.text?.startsWith("Verdict: unsupported")
        ? { text: unbackedFigures(call) }
        : reply;
    },
    {
      generate: (call) => {
        const sorting = call.system.startsWith("You sort the sentences");
        if (sorting) finds.push(call);
        const reply = checkGenerate(PLANS)(call);
        if (sorting && "text" in reply) {
          const decisions = JSON.parse(reply.text) as SortDecisions;
          const views = new Set(numbersOf(call, OPINION));
          const explicit = {
            sentences: decisions.sentences.map((sentence) =>
              views.has(sentence.number)
                ? { ...sentence, parts: [{ kind: "opinion" as const, text: OPINION }] }
                : sentence,
            ),
          };
          return { text: JSON.stringify(decide ? decide(finds.length, call, explicit) : explicit) };
        }
        return billed?.judged && "text" in reply && call.system.startsWith("Compare a sentence")
          ? { ...reply, usage: billed.judged }
          : reply;
      },
      ...(billed && { usage: billed.usage }),
    },
  );
  const dataDir = await createTempDataFolder();
  const clock = manualClock("2026-10-02T14:20:00.000Z");
  const adapters = { createChatModel: scriptedModels(model).createChatModel, now: clock.now };
  const core = startCore(dataDir, adapters);
  if (billed) {
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  } else await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, TIDES.name, TIDES.contents),
    await writeSourceFile(sources, OFFICE.name, OFFICE.contents),
  ]);
  const folder = await core.createLibraryGroup({ name: "Harbours", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const mind = await core.createMind({ title: "Harbour notes", folderId: folder.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "heading", attrs: { level: 2 }, content: [text("High water in the harbour")] },
    { type: "paragraph", attrs: { id: "one" }, content: [text(`${MOON} ${YEARLY} ${QUESTION}`)] },
    { type: "paragraph", attrs: { id: "two" }, content: [text(`${OPINION} ${PENGUINS}`)] },
  ]);
  await client.settled();
  /** Quits the app and starts it again on the same data: what the model named is forgotten. */
  const restart = async () => {
    core.close();
    const restarted = startCore(dataDir, adapters);
    return { core: restarted, client: await connectToMind(restarted, mind.id) };
  };
  return {
    core,
    client,
    dataDir,
    mindId: mind.id,
    folderId: folder.id,
    checks,
    finds,
    clock,
    restart,
  };
}

const request = (mindId: string, mode: CheckMindInput["mode"], id = "run"): CheckMindInput => ({
  requestId: `${id}-${mode}`,
  mindId,
  mode,
});

/** Each check's mark in the Mind, as the editor shows it now. */
async function shownChecks(
  core: Core,
  client: MindClient,
  mindId: string,
  folderId: string | null,
) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  const figureContexts = new Map(
    (await core.getFigureSchedule(mindId)).rows.map((figure) => {
      if (typeof figure.context !== "string") throw new Error("A figure has no current context.");
      return [figure.id, figure.context];
    }),
  );
  return claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text.trim(),
    shown: claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId,
      scope: null,
      figureContexts,
    }),
  }));
}

// protects=a check sends six claims at once to a model on a service and one at a time to a model on this computer (#1618); fails_when=the number changes, or a model on this computer is sent several at once; no_claim=a real provider's rate limits, which the run's backoff answers.
test.each([
  [6, "a model on a service", true],
  [1, "a model on this computer", false],
] as const)("Check this note sends %i claims at once to %s", async (atOnce, _, onService) => {
  const sentences = Array.from(
    { length: 9 },
    (_, index) => `Spring tide ${index + 1} comes at new moon.`,
  );
  const plans: Record<string, Plan> = Object.fromEntries(
    sentences.map((sentence) => [sentence, { verdict: "supported", quote: MOON }]),
  );
  const running = new Set<string>();
  let most = 0;
  const full = Promise.withResolvers<void>();
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      const sentence = sentenceOf(call);
      const first = call.results.length === 0;
      if (first) {
        running.add(sentence);
        most = Math.max(most, running.size);
        if (running.size === atOnce) full.resolve();
      }
      const reply = checkReply(call, plans);
      if ("text" in reply && reply.text?.startsWith("Verdict")) running.delete(sentence);
      // Each check waits at its first request until as many run as may: a check that ends at once
      // would otherwise leave its place before the next starts.
      return first ? { ...reply, pause: { after: 0, until: full.promise } } : reply;
    },
    { generate: checkGenerate(plans) },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  if (onService) {
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  } else await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
  const mind = await core.createMind({ title: "Tide notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(
    client,
    sentences.map((sentence, index) => ({
      type: "paragraph",
      attrs: { id: `tide-${index + 1}` },
      content: [text(sentence)],
    })),
  );
  await client.settled();

  const result = await core.checkMind(request(mind.id, "all"));

  expect(result).toMatchObject({ kind: "checked", sentences: 9 });
  expect(most).toBe(atOnce);
});

// protects=Check this Note loads the built-in reranker before it asks for the claims, so the first sentence's search finds the load under way or done instead of starting it (#2532), and loads nothing with reranking off; fails_when=the reranker loads only when a check's first search asks it to rerank, or loads with reranking off; no_claim=that a search during the load shares it, which tests/core/reranking.test.ts covers.
test.each([
  ["loads the reranker before it asks for the claims", true],
  ["loads no reranker with reranking off", false],
] as const)("Check this note %s", async (_, reranking) => {
  const sentence = "Spring tides come at new moon.";
  const plans: Record<string, Plan> = { [sentence]: { verdict: "supported", quote: MOON } };
  const events: string[] = [];
  const loaded = Promise.withResolvers<void>();
  const fake = createFakeCrossEncoder();
  const model = scriptedModel(
    (call) => {
      if (isCheckRun(call) && call.results.length === 0) events.push("check asks");
      return checkReply(call, plans);
    },
    {
      generate: (call) => {
        if (call.system.startsWith("You sort the sentences")) {
          events.push("claims asked");
          // The load ends while the claims are named, as a real one would.
          loaded.resolve();
        }
        return checkGenerate(plans)(call);
      },
    },
  );
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    crossEncoder: {
      ...fake,
      load: async (files) => {
        events.push("reranker loads");
        await loaded.promise;
        return fake.load(files);
      },
    },
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const provider = await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "sk-ant-test",
    modelId: "claude-haiku-5-5",
  });
  if (provider.service) await core.allowDataFlow("checks", provider.service.id);
  if (!reranking) await core.removeRerankSettings();
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
  const mind = await core.createMind({ title: "Tide notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [{ type: "paragraph", attrs: { id: "tide" }, content: [text(sentence)] }]);
  await client.settled();
  events.length = 0;

  const result = await core.checkMind(request(mind.id, "all"));

  expect(result).toMatchObject({ kind: "checked", sentences: 1 });
  if (!reranking) {
    expect(events).not.toContain("reranker loads");
    return;
  }
  expect(events.slice(0, 2)).toEqual(["reranker loads", "claims asked"]);
});

// protects=the Note's claims step on its own (the estimate before a run) loads the reranker before it asks for the claims too (#2532); fails_when=only the run loads it; no_claim=how long a real model takes to load.
test("Check this note's claims step loads the reranker before it asks for the claims", async () => {
  const sentence = "Spring tides come at new moon.";
  const plans: Record<string, Plan> = { [sentence]: { verdict: "supported", quote: MOON } };
  const events: string[] = [];
  const fake = createFakeCrossEncoder();
  const model = scriptedModel((call) => checkReply(call, plans), {
    generate: (call) => {
      if (call.system.startsWith("You sort the sentences")) events.push("claims asked");
      return checkGenerate(plans)(call);
    },
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    crossEncoder: {
      ...fake,
      load: async (files) => {
        events.push("reranker loads");
        return fake.load(files);
      },
    },
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
  const mind = await core.createMind({ title: "Tide notes" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [{ type: "paragraph", attrs: { id: "tide" }, content: [text(sentence)] }]);
  await client.settled();
  events.length = 0;

  expect(await core.findMindClaims(request(mind.id, "all"))).toMatchObject({ kind: "found" });
  expect(events.slice(0, 2)).toEqual(["reranker loads", "claims asked"]);
});

describe("Check this note", () => {
  // protects=a second Check of a Note while one runs starts none, whichever window or request asks, and says one is running; the first goes on to its end; fails_when=two runs check the same Note at once; no_claim=a Check of another Note, which runs beside it.
  test("one Check of a Note at a time: a second, from anywhere, starts none", async () => {
    const { core, mindId, finds } = await setUp();

    const first = core.checkMind(request(mindId, "all", "first-window"));
    const second = core.checkMind(request(mindId, "all", "second-window"));

    expect(await second).toEqual({ kind: "running" });
    expect(await first).toMatchObject({ kind: "checked", sentences: 3 });
    expect(finds).toHaveLength(1);
    expect(await core.checkMind(request(mindId, "all", "after"))).toMatchObject({
      kind: "checked",
    });
  });

  // protects=two Check requests that begin planning at once: the second is refused before it names any claim, so no second question is asked and one run starts; fails_when=both plan and both may ask; no_claim=which request the model names claims for.
  test("two Checks in the planning window: the second is refused, and one runs", async () => {
    const { core, mindId, finds } = await setUp();

    const first = core.findMindClaims(request(mindId, "all", "first-window"));
    const second = core.findMindClaims(request(mindId, "all", "second-window"));

    expect(await second).toEqual({ kind: "running" });
    expect(await first).toMatchObject({ kind: "found" });
    expect(finds).toHaveLength(1);
    expect(await core.checkMind(request(mindId, "all", "first-window"))).toMatchObject({
      kind: "checked",
      sentences: 3,
    });
  });

  // protects=a stopped Check keeps its Note until it has unwound: a Check asked the moment it is stopped starts none, and the Note is free after; fails_when=the next Check starts over the stopped one's work; no_claim=what the stopped Check writes.
  test("a stopped Check keeps its Note until it unwinds", async () => {
    const { core, mindId } = await setUp();

    const first = core.checkMind(request(mindId, "all", "stopped"));
    await core.cancelCheck("stopped-all");
    expect(await core.checkMind(request(mindId, "all", "over"))).toEqual({ kind: "running" });
    expect(await first).toEqual({ kind: "cancelled" });
    expect(await core.checkMind(request(mindId, "all", "after"))).toMatchObject({
      kind: "checked",
    });
  });

  // protects=a window's Check keeps its Note from planning until it runs: a second window's Check is refused before it plans, and the Note is free once the Check runs, is dropped, or its window goes; fails_when=another window plans or runs meanwhile, or the Note stays kept; no_claim=what the Check finds.
  test("a planned Check keeps its Note until it runs, is dropped, or its window goes", async () => {
    const { core, mindId, finds } = await setUp();
    const planned = request(mindId, "all", "planned");

    expect(
      await core.holdMindCheck({
        requestId: planned.requestId,
        mindId,
        clientId: "first-window",
      }),
    ).toBe(true);
    expect(
      await core.holdMindCheck({ requestId: "second", mindId, clientId: "second-window" }),
    ).toBe(false);

    // A window gone frees a Check still being planned, never one that is running.
    const running = core.checkMind(planned);
    await core.forgetCheckWindow({ clientId: "first-window" });
    expect(await core.checkMind(request(mindId, "all", "while-running"))).toEqual({
      kind: "running",
    });
    expect(await running).toMatchObject({ kind: "checked", sentences: 3 });
    expect(
      await core.holdMindCheck({ requestId: "after", mindId, clientId: "second-window" }),
    ).toBe(true);
    await core.cancelCheck("after");
    expect(await core.holdMindCheck({ requestId: "third", mindId, clientId: "first-window" })).toBe(
      true,
    );
    await core.forgetCheckWindow({ clientId: "first-window" });
    expect(
      await core.holdMindCheck({ requestId: "later", mindId, clientId: "second-window" }),
    ).toBe(true);
    expect(finds).toHaveLength(1);
  });

  // protects=a planning run stopped while a window held its Note frees it; fails_when=the Note stays held until the window goes; no_claim=what the model would name.
  test("a planning run stopped while a window held its Note frees it", async () => {
    const { core, mindId } = await setUp();
    const planned = request(mindId, "all", "planning");
    expect(
      await core.holdMindCheck({
        requestId: planned.requestId,
        mindId,
        clientId: "first-window",
      }),
    ).toBe(true);

    const planning = core.findMindClaims(planned);
    await core.cancelCheck(planned.requestId);

    expect(await planning).toEqual({ kind: "cancelled" });
    expect(await core.holdMindCheck({ requestId: "next", mindId, clientId: "second-window" })).toBe(
      true,
    );
  });

  // protects=one Check is two parts: the claims run hands the window its Note back for the watch that follows, so a second window's Check is refused until the renderer frees it at the end; fails_when=the Note is free between the two parts; no_claim=what the watch checks.
  test("a window's Check keeps its Note through the watch, and the next Check starts after it", async () => {
    const { core, mindId } = await setUp();
    const first = request(mindId, "all", "first");
    expect(
      await core.holdMindCheck({
        requestId: first.requestId,
        mindId,
        clientId: "first-window",
      }),
    ).toBe(true);

    expect(await core.checkMind(first)).toMatchObject({ kind: "checked", sentences: 3 });
    // The claims ended, the watch has not: the Note is still the window's.
    expect(
      await core.holdMindCheck({ requestId: "second", mindId, clientId: "second-window" }),
    ).toBe(false);
    expect(await core.checkMind(request(mindId, "all", "second"))).toEqual({ kind: "running" });

    // `runCheck`'s finally, after the watch: the Note is free, and the next Check starts.
    await core.cancelCheck(first.requestId);
    expect(
      await core.holdMindCheck({ requestId: "second", mindId, clientId: "second-window" }),
    ).toBe(true);
  });

  test("the model it names is the one in use: an older Mind follows a new last pick, its own pick wins, and a removed provider falls back", async () => {
    const { core, client, mindId } = await setUp();
    const named = async () => {
      const plan = await core.planMindCheck(mindId, "all");
      return plan.kind === "ready" ? plan.model : undefined;
    };
    const defaultModel = (await core.getSettings()).user.chatModel;
    expect(await named()).toEqual(defaultModel);

    const claude = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
      keepDefault: true,
    });
    const openai = await core.saveChatProvider({
      kind: "openai",
      apiKey: "sk-test",
      modelId: "gpt-6-luna",
      keepDefault: true,
    });
    const last = { providerId: claude.id, modelId: "claude-haiku-5-5" };
    const own = { providerId: openai.id, modelId: "gpt-6-luna" };

    await core.updateSettings({ device: { lastChatModel: last } });
    expect(await named()).toEqual(last);

    setMindModel(client.doc, own);
    await client.settled();
    expect(await named()).toEqual(own);
    await core.updateSettings({
      device: { lastChatModel: { providerId: claude.id, modelId: "claude-sonnet-5-5" } },
    });
    expect(await named()).toEqual(own);

    await core.deleteChatProvider(openai.id);
    expect(await named()).toEqual({ providerId: claude.id, modelId: "claude-sonnet-5-5" });
    await core.deleteChatProvider(claude.id);
    expect(await named()).toEqual(defaultModel);
  });

  test("checks every claim, each marked; the heading, the question and the User's opinion aren't; the run is recorded", async () => {
    const { core, client, mindId, folderId, checks, finds } = await setUp();
    expect(await core.planMindCheck(mindId, "all")).toEqual({
      kind: "ready",
      sentences: 5,
      findsClaims: true,
      inFolder: true,
      model: (await core.getSettings()).user.chatModel,
    });

    expect(await core.checkMind(request(mindId, "all"))).toEqual({
      kind: "checked",
      sentences: 3,
      checked: 3,
      smallModel: false,
      stop: null,
    });
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ sentence, shown }) => [
        sentence,
        shown,
      ]),
    ).toEqual([
      [MOON, { state: "supported" }],
      [YEARLY, { state: "contradicted" }],
      [PENGUINS, { state: "unsupported" }],
    ]);
    // One request names the claims among the five sentences; one check Run each.
    expect(finds).toHaveLength(1);
    expect(finds[0]?.system).toMatch(/^You sort the sentences of the User's own draft/);
    expect(runsIn(checks)).toHaveLength(3);
    expect(mindCheckOf(client.doc)).toMatchObject({
      at: "2026-10-02T14:20:00.000Z",
      sentences: 3,
      stop: null,
    });
    expect(mindCheckOf(client.doc)?.skipped).toHaveLength(2);

    // Nothing has changed since: nothing to send, and the plan says since when.
    expect(await core.planMindCheck(mindId, "changed")).toEqual({
      kind: "unchanged",
      since: "2026-10-02T14:20:00.000Z",
    });
  });

  test("a sentence the reply leaves undecided is asked about once more, with its own number, and checked once decided (#1682)", async () => {
    const { core, client, mindId, folderId, finds } = await setUp(
      undefined,
      (asked, call, decisions) =>
        asked === 1 ? withoutDecisions([PENGUINS])(call, decisions) : decisions,
    );

    expect(await core.checkMind(request(mindId, "all"))).toMatchObject({
      kind: "checked",
      sentences: 3,
    });
    expect(finds).toHaveLength(2);
    expect(finds[1]?.prompt).toBe(JSON.stringify({ sentences: [{ number: 5, text: PENGUINS }] }));
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ sentence }) => sentence),
    ).toEqual([MOON, YEARLY, PENGUINS]);
    expect(mindCheckOf(client.doc)).toMatchObject({ unexamined: [] });
    expect(mindCheckOf(client.doc)?.skipped).toHaveLength(2);
  });

  test.each([
    ["Spring tides come at new and full moon.", "Penguins nest on the cliffs above the harbour."],
    ["大潮发生在新月和满月时。", "企鹅在港口上方的悬崖筑巢。"],
  ])(
    "a readable reply missing every sentence leaves them unexamined: %s",
    async (first, second) => {
      const { core, client, mindId, folderId, finds } = await setUp(undefined, () => ({
        sentences: [],
      }));
      writeMind(client, [
        { type: "paragraph", attrs: { id: "all-missing" }, content: [text(`${first} ${second}`)] },
      ]);
      await client.settled();
      expect(await core.checkMind(request(mindId, "all"))).toMatchObject({
        kind: "checked",
        sentences: 0,
        checked: 0,
        stop: null,
      });
      expect(finds).toHaveLength(2);
      expect(finds[1]?.prompt).toBe(finds[0]?.prompt);
      expect(mindCheckOf(client.doc)).toMatchObject({
        skipped: [],
        unexamined: [sentenceKey(first), sentenceKey(second)],
      });
      expect(await shownChecks(core, client, mindId, folderId)).toEqual([]);
      expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
        kind: "ready",
        sentences: 2,
        findsClaims: true,
      });
    },
  );

  test("a sentence no reply decides isn't examined: no mark, not left out as no claim, and the next Check asks about it again (#1682)", async () => {
    let silent = true;
    const { core, client, mindId, folderId, finds } = await setUp(
      undefined,
      (_, call, decisions) => (silent ? withoutDecisions([PENGUINS])(call, decisions) : decisions),
    );

    expect(await core.checkMind(request(mindId, "all"))).toMatchObject({
      kind: "checked",
      sentences: 2,
    });
    expect(finds).toHaveLength(2);
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ sentence }) => sentence),
    ).toEqual([MOON, YEARLY]);
    const run = mindCheckOf(client.doc);
    expect(run?.unexamined).toHaveLength(1);
    expect(run?.skipped).toHaveLength(2);
    expect(run?.skipped).not.toContain(run?.unexamined[0]);
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      kind: "ready",
      sentences: 1,
      findsClaims: true,
    });

    silent = false;
    expect(await core.checkMind(request(mindId, "changed", "again"))).toMatchObject({
      kind: "checked",
      sentences: 1,
    });
    expect(finds).toHaveLength(3);
    expect(finds[2]?.prompt).toBe(JSON.stringify({ sentences: [{ number: 1, text: PENGUINS }] }));
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ sentence }) => sentence),
    ).toEqual([MOON, YEARLY, PENGUINS]);
    expect(mindCheckOf(client.doc)?.unexamined).toEqual([]);
  });

  test("a Note checked before every sentence got a decision has its sentences that made no claim sorted once more (#1682)", async () => {
    const { core, client, mindId, folderId, finds } = await setUp();
    // A run before #1682 took a sentence its reply didn't list for one that makes no claim.
    client.doc.getMap(MIND_SETTINGS_FIELD).set("mindCheck", {
      at: "2026-10-01T09:00:00.000Z",
      sentences: 0,
      stop: null,
      skipped: [sentenceKey(PENGUINS), sentenceKey(QUESTION)],
    });
    await client.settled();
    expect(mindCheckOf(client.doc)).toMatchObject({
      skipped: [],
      unexamined: [sentenceKey(PENGUINS), sentenceKey(QUESTION)],
    });

    await core.checkMind(request(mindId, "changed"));
    expect(finds[0]?.prompt).toContain(PENGUINS);
    expect(finds[0]?.prompt).toContain(QUESTION);
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ sentence }) => sentence),
    ).toEqual([MOON, YEARLY, PENGUINS]);
    const run = mindCheckOf(client.doc);
    expect(run?.unexamined).toEqual([]);
    expect(run?.skipped).toContain(sentenceKey(QUESTION));
    expect(run?.skipped).not.toContain(sentenceKey(PENGUINS));
  });

  test("the same words twice, named a claim once and left out once, are checked and not left out (#1682)", async () => {
    const { core, client, mindId, folderId } = await setUp(undefined, (_, call, decisions) => {
      const [, second] = numbersOf(call, MOON);
      return second === undefined
        ? decisions
        : {
            sentences: decisions.sentences.map((sentence) =>
              sentence.number === second ? { ...sentence, parts: [] } : sentence,
            ),
          };
    });
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", attrs: { id: "again" }, content: [text(MOON)] },
    ]);
    await client.settled();

    await core.checkMind(request(mindId, "all"));
    const marked = (await shownChecks(core, client, mindId, folderId)).map(
      ({ sentence }) => sentence,
    );
    expect(marked.filter((sentence) => sentence === MOON)).toHaveLength(2);
    expect(mindCheckOf(client.doc)?.skipped).not.toContain(sentenceKey(MOON));
  });

  test("a short sentence with a shown check counts and is checked, though it makes no claim (#1909)", async () => {
    const { core, client, mindId, folderId, checks } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const runsBefore = runsIn(checks).length;

    const mark = (id: string, state: ClaimCheckAttributes["state"], text: string) => {
      const check: ClaimCheckAttributes = {
        id,
        request: "old",
        action: "check-against-documents",
        state,
        reason: null,
        detail: null,
        providerId: null,
        modelId: null,
        text,
        evidence: null,
        says: null,
        unsupported: null,
        calculation: null,
        citedCaseUnchecked: false,
        citedCaseFound: false,
        scope: { folderId, widened: false },
        versions: [],
        excluded: [],
        checkedAt: "2026-10-02T13:00:00.000Z",
      };
      return { type: "text" as const, text, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] };
    };
    // "100" failed its check; "200" was checked as "100" and no longer holds. Neither makes a claim.
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        attrs: { id: "failed" },
        content: [mark("failed", "not-checked", "100")],
      },
      {
        type: "paragraph",
        attrs: { id: "stale" },
        content: [{ ...mark("stale", "supported", "100"), text: "200" }],
      },
    ]);
    await client.settled();

    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      kind: "ready",
      sentences: 2,
      findsClaims: false,
    });
    expect(await core.checkMind(request(mindId, "changed", "short"))).toMatchObject({
      kind: "checked",
      sentences: 2,
    });
    expect(runsIn(checks).length).toBe(runsBefore + 2);
    expect(
      (await shownChecks(core, client, mindId, folderId))
        .map(({ sentence, shown }) => [sentence, shown.state])
        .filter(([sentence]) => sentence === "100" || sentence === "200"),
    ).toEqual([
      ["100", "unsupported"],
      ["200", "unsupported"],
    ]);
    // Nothing is left: the count reaches 0.
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ kind: "unchanged" });
  });

  test("Check again renews only the edited sentences' parts, then checks them", async () => {
    const { core, client, mindId, folderId, checks, finds } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const runsBefore = runsIn(checks).length;

    typeInto(client, 1, 0, "Big ");
    typeInto(client, 2, OPINION.length + 1, "Some ");
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ shown }) => shown.state),
    ).toEqual(["needs-recheck", "contradicted", "needs-recheck"]);

    expect(await core.planMindCheck(mindId, "changed")).toEqual({
      kind: "ready",
      sentences: 2,
      findsClaims: true,
      inFolder: true,
      model: (await core.getSettings()).user.chatModel,
    });
    expect(await core.checkMind(request(mindId, "changed"))).toMatchObject({
      kind: "checked",
      sentences: 2,
    });
    expect(runsIn(checks).length - runsBefore).toBe(2);
    expect(finds).toHaveLength(2);
    expect(finds[1]?.prompt).toBe(
      JSON.stringify({
        sentences: [
          { number: 1, text: `Big ${MOON}` },
          { number: 2, text: `Some ${PENGUINS}` },
        ],
      }),
    );
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ shown }) => shown.state),
    ).toEqual(["unsupported", "contradicted", "unsupported"]);
  });

  test("a whole sentence whose stored part drops its closing stop is no part (#2313)", async () => {
    const { core, client, mindId, folderId } = await setUp();
    const quote = {
      passageId: "passage-tides",
      documentId: "tides",
      documentName: "Tides",
      contentHash: "hash-tides",
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: FULL,
      check: "found" as const,
      checkReason: null,
    };
    const part = {
      span: { start: 0, end: STOPLESS.length },
      kind: "fact" as const,
      verdict: "contradicted" as const,
      evidence: [quote],
      decidingEvidence: 0,
      says: "The quote gives it another way.",
      unsupported: null,
      calculation: null,
      reason: null,
      detail: null,
      versions: [],
      excluded: [],
      citedCaseUnchecked: false,
      citedCaseFound: false,
    };
    const check: ClaimCheckAttributes = {
      id: "stopless",
      request: "before",
      action: "check-against-documents",
      state: "contradicted",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      text: FULL,
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-02T13:00:00.000Z",
      parts: [part],
    };
    editMind(client, (blocks) => [
      ...blocks,
      {
        type: "paragraph",
        attrs: { id: "stopless" },
        content: [{ type: "text", text: FULL, marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }],
      },
    ]);
    await client.settled();
    expect(
      claimSpans(readMind(client))
        .filter((span) => span.sentence.text === FULL)
        .map((span) => [span.check.state, span.check.parts?.length, span.check.text]),
      "stored",
    ).toContainEqual(["contradicted", 1, FULL]);

    await core.checkMind(request(mindId, "all"));

    const [shown] = (await shownChecks(core, client, mindId, folderId)).filter(
      ({ sentence }) => sentence === FULL,
    );
    expect(shown?.shown.state).not.toBe("supported");
    expect(shown?.shown.state).toBe("unsupported");
  });

  // protects=a sentence the User keeps as their own view (#1111) isn't checked again, in any mode, until its words change; fails_when=a run sends it, or an edit of it doesn't bring it back; no_claim=how the card sets it.
  test("a sentence kept as the User's own view isn't checked again until its words change", async () => {
    const { core, client, mindId, folderId } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const penguins = claimSpans(readMind(client)).find((span) =>
      span.sentence.text.startsWith(PENGUINS),
    );
    client.doc.transact(() => {
      updateCheck(client.blocks, penguins?.check.id ?? "", (check) => ({ ...check, kept: true }));
    }, "editor");
    await client.settled();
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ shown }) => shown.state),
    ).toEqual(["supported", "contradicted", "kept"]);

    expect(await core.planMindCheck(mindId, "all")).toMatchObject({
      kind: "ready",
      sentences: 2,
      findsClaims: false,
    });
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ kind: "unchanged" });

    typeInto(client, 2, OPINION.length + 1, "Some ");
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ sentences: 1 });
  });

  test("a sentence written since is found among the new ones only, and the opinion isn't sent again", async () => {
    const { core, client, mindId, finds } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const added = "The harbour master retired in 2025.";
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", attrs: { id: "three" }, content: [text(added)] },
    ]);
    await client.settled();

    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      sentences: 1,
      findsClaims: true,
    });
    await core.checkMind(request(mindId, "changed"));
    expect(finds).toHaveLength(2);
    expect(finds[1]?.prompt).toBe(JSON.stringify({ sentences: [{ number: 1, text: added }] }));
  });

  test("the monthly cap stops the run: the claims left say “not checked: cost cap”", async () => {
    const checks: ModelCall[] = [];
    let core: Core | null = null;
    const model = scriptedModel(
      (call) => {
        checks.push(call);
        return checkReply(call, PLANS);
      },
      {
        generate: (call) => {
          // The claims are named, then the cap is reached before any is checked.
          if (call.system.startsWith("You sort the sentences")) {
            void core?.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
          }
          return checkGenerate(PLANS)(call);
        },
      },
    );
    core = startCore(await createTempDataFolder(), { createChatModel: () => model });
    core.on("consent.requested", (asked) => void core?.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
    const mind = await core.createMind({ title: "Harbour notes", folderId: null });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "all" }, content: [text(`${MOON} ${YEARLY} ${PENGUINS}`)] },
    ]);
    await client.settled();

    expect(await core.checkMind(request(mind.id, "all"))).toEqual({
      kind: "checked",
      sentences: 3,
      checked: 0,
      smallModel: false,
      stop: { reason: "cost-cap" },
    });
    expect((await shownChecks(core, client, mind.id, null)).map(({ shown }) => shown)).toEqual(
      [MOON, YEARLY, PENGUINS].map(() => ({ state: "not-checked", reason: "cost-cap" })),
    );
    expect(runsIn(checks)).toEqual([]);
    expect(mindCheckOf(client.doc)?.stop).toEqual({ reason: "cost-cap" });
    // The claims not checked are what is left to check, so nothing counts as unchanged.
    expect(await core.planMindCheck(mind.id, "changed")).toMatchObject({
      kind: "ready",
      sentences: 3,
      findsClaims: false,
    });
  });

  // protects=the ask counts exactly the claims a run checks, and the model sorts each sentence once (#973); fails_when=the ask counts sentences the model leaves out, Check sorts again, or declining spends more; no_claim=what a real model names.
  test("the claims named before the ask are exactly those checked, and neither Check nor a second run sorts them again; declining spends nothing more", async () => {
    const { core, client, mindId, checks, finds } = await setUp();
    const memo = "This memo sums up what the harbour office told us.";
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", attrs: { id: "three" }, content: [text(memo)] },
    ]);
    await client.settled();
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      sentences: 6,
      findsClaims: true,
    });

    expect(await core.findMindClaims(request(mindId, "changed", "sort"))).toEqual({
      kind: "found",
      claims: 3,
    });
    expect(finds).toHaveLength(1);
    expect(checks).toHaveLength(0);
    // Declined: asked again, nothing is sent again.
    expect(await core.findMindClaims(request(mindId, "changed", "again"))).toEqual({
      kind: "found",
      claims: 3,
    });
    expect(finds).toHaveLength(1);
    expect(checks).toHaveLength(0);

    expect(await core.checkMind(request(mindId, "changed"))).toMatchObject({
      kind: "checked",
      sentences: 3,
    });
    expect(finds).toHaveLength(1);
    expect(mindCheckOf(client.doc)?.skipped).toEqual([sentenceKey(QUESTION), sentenceKey(memo)]);
    expect(readOpinionSentences(client.doc).map((sentence) => sentence.text)).toEqual([OPINION]);
    expect(mindCheckOf(client.doc)?.unexamined).toEqual([]);
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ kind: "unchanged" });
  });

  // protects=on a model billed per token, the estimate for the claims named comes within 1.5 times the run's tokens; fails_when=it prices a check as an Answer, or counts sentences the model leaves out; no_claim=a real model's tokens (tests/core/cost.test.ts has those).
  test("on a model billed per token, the estimate for the claims named comes within 1.5 times the tokens the run then reports", async () => {
    // Each request as an average check of Claude Haiku 5.5 reported it (tests/fixtures/cost/recorded-checks.json).
    const usage: ReportedUsage = {
      inputTokens: { total: 8_260, noCache: 995, cacheRead: 2_903, cacheWrite: 4_362 },
      outputTokens: { total: 129, text: 129, reasoning: undefined },
    };
    // A judgement of a sentence beside its quote is a short request of its own, as the recorded run's was.
    const judged: ReportedUsage = {
      inputTokens: { total: 867, noCache: 867, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    };
    const { core, mindId, dataDir } = await setUp({ usage, judged });
    const found = await core.findMindClaims(request(mindId, "changed", "sort"));
    if (found.kind !== "found") throw new Error(`No claims: ${found.kind}.`);

    const estimate = await core.estimateRun({ items: found.claims, each: "check" });
    await core.checkMind(request(mindId, "changed"));

    if (estimate.billing !== "per-token") throw new Error("Not billed per token.");
    const [run] = queryDatabase<{ tokens: number }>(
      dataDir,
      `SELECT sum(input_tokens + output_tokens) AS tokens FROM model_requests
       WHERE deleted_at IS NULL AND status = 'settled' AND flow = 'checks'`,
    );
    expect(estimate.tokens / (run?.tokens ?? 0)).toBeGreaterThan(1 / 1.5);
    expect(estimate.tokens / (run?.tokens ?? 0)).toBeLessThan(1.5);
  });

  // protects=Check this note with nothing changed sends nothing and says since when (#1669); fails_when=it plans a check of every sentence again, dates itself by the newest check, or an edit taken back still counts as a change; no_claim=the card's words.
  test("when nothing changed the plan says since the oldest check that holds; an edit taken back holds the checks again", async () => {
    const { core, client, mindId, checks, finds, clock } = await setUp();
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      kind: "ready",
      sentences: 5,
      findsClaims: true,
    });
    await core.checkMind(request(mindId, "all"));

    // A later check of one sentence doesn't make the others newer.
    clock.advance(60 * 60 * 1000);
    typeInto(client, 2, OPINION.length + 1, "Some ");
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ sentences: 1 });
    await core.checkMind(request(mindId, "changed"));
    expect(await core.planMindCheck(mindId, "changed")).toEqual({
      kind: "unchanged",
      since: "2026-10-02T14:20:00.000Z",
    });

    // The same words again: the check holds, and nothing changed.
    const sent = { finds: finds.length, runs: runsIn(checks).length };
    typeInto(client, 1, 0, "Big ");
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ kind: "ready" });
    const moon = client.blocks.get(1);
    const words = moon instanceof Y.XmlElement ? moon.get(0) : undefined;
    if (!(words instanceof Y.XmlText)) throw new Error("Block 1 isn't a paragraph.");
    words.delete(0, "Big ".length);
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ kind: "unchanged" });
    expect({ finds: finds.length, runs: runsIn(checks).length }).toEqual(sent);
  });

  // protects=#2313: a Folder move changes what a new check searches; a result its Citations back holds (a quoted Document leaving the Folder changes nothing), while a result the whole Folder backed — an Unsupported with no quote — needs a check in the new Folder; a Document that joined the Folder since is the added ones' to check; fails_when=moving a cited Document out makes a quoted check look changed, a whole-Folder result is kept in a Folder never read, or a Document filed in since reads as nothing changed; no_claim=the Search scope a new Check looks in (checkScope.test.ts).
  test("moving a cited Document out keeps a quoted result; a whole-Folder result needs a check in the Mind's new Folder", async () => {
    const { core, mindId, folderId, clock } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const unchanged = { kind: "unchanged", since: "2026-10-02T14:20:00.000Z" };
    expect(await core.planMindCheck(mindId, "changed")).toEqual(unchanged);

    // The Document a quoted result rests on leaves the Folder: the quote is still where it was.
    const [tides] = (await core.listDocuments()).filter((each) => each.name === "Tides");
    if (!tides) throw new Error("The Tides Document isn't there.");
    await core.moveToFolder({ documentIds: [tides.id], folderId: null });
    expect(await core.planMindCheck(mindId, "changed")).toEqual(unchanged);
    await core.moveToFolder({ documentIds: [tides.id], folderId });
    expect(await core.planMindCheck(mindId, "changed")).toEqual(unchanged);

    // The Mind goes to another Folder: its quoted results hold, the Unsupported with no quote
    // rested on the Folder it was read in and is checked in the new one.
    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    await core.moveToFolder({ mindIds: [mindId], folderId: elsewhere.id });
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      kind: "ready",
      sentences: 1,
      findsClaims: false,
    });
    await core.moveToFolder({ mindIds: [mindId], folderId });
    expect(await core.planMindCheck(mindId, "changed")).toEqual(unchanged);

    clock.advance(60_000);
    const sources = await createTempDataFolder();
    const [seabirds] = await addAndProcess(core, [
      await writeSourceFile(sources, "Seabirds.md", `# Seabirds\n\n${PENGUINS}\n`),
    ]);
    await core.moveToFolder({ documentIds: [seabirds?.id ?? ""], folderId });
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({ kind: "unchanged" });
    expect(await core.planMindCheck(mindId, "added")).toMatchObject({
      kind: "ready",
      sentences: 1,
    });
  });

  test("with no check dated, the last whole-Mind check stands in for the date; a Mind with no check says nothing to check", async () => {
    const { core, client, mindId } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const run = mindCheckOf(client.doc);
    if (!run) throw new Error("The run wasn't recorded.");
    client.doc.transact(() => {
      for (const span of claimSpans(readMind(client))) {
        updateCheck(client.blocks, span.check.id, (check) => ({ ...check, checkedAt: "" }));
      }
      writeMindCheck(client.doc.getMap(MIND_SETTINGS_FIELD), {
        ...run,
        at: "2026-10-03T08:00:00.000Z",
      });
    }, "editor");
    await client.settled();
    expect(await core.planMindCheck(mindId, "changed")).toEqual({
      kind: "unchanged",
      since: "2026-10-03T08:00:00.000Z",
    });

    const empty = await core.createMind({ title: "Empty", folderId: null });
    expect(await core.planMindCheck(empty.id, "changed")).toEqual({ kind: "nothing" });
  });

  // protects=Check every sentence again doesn't ask the model to name the claims it already named, even after a restart (#1669); fails_when=a marked or skipped sentence is sent to be sorted again; no_claim=what a real model names.
  test("after a restart, Check every sentence again checks the marked sentences without naming the claims again, and the skipped stay skipped", async () => {
    const { core, mindId, checks, finds, restart } = await setUp();
    await core.checkMind(request(mindId, "all"));
    expect(finds).toHaveLength(1);
    const runsBefore = runsIn(checks).length;

    const restarted = await restart();
    expect(await restarted.core.planMindCheck(mindId, "all")).toMatchObject({
      kind: "ready",
      sentences: 3,
      findsClaims: false,
    });
    expect(await restarted.core.findMindClaims(request(mindId, "all", "again"))).toEqual({
      kind: "found",
      claims: 3,
    });
    expect(await restarted.core.checkMind(request(mindId, "all", "again"))).toMatchObject({
      kind: "checked",
      sentences: 3,
    });
    expect(finds).toHaveLength(1);
    expect(runsIn(checks).length - runsBefore).toBe(3);
    expect(mindCheckOf(restarted.client.doc)?.skipped).toHaveLength(2);

    // A sentence written since is the one the model is asked about.
    const added = "The harbour master retired in 2025.";
    editMind(restarted.client, (blocks) => [
      ...blocks,
      { type: "paragraph", attrs: { id: "three" }, content: [text(added)] },
    ]);
    await restarted.client.settled();
    expect(await restarted.core.planMindCheck(mindId, "all")).toMatchObject({
      sentences: 4,
      findsClaims: true,
    });
    await restarted.core.checkMind(request(mindId, "all", "third"));
    expect(finds).toHaveLength(2);
    expect(finds[1]?.prompt).toBe(JSON.stringify({ sentences: [{ number: 1, text: added }] }));
  });

  test("says why there is nothing to check: no sentences; a Mind in a Folder with no Documents checks every Document (#1359)", async () => {
    const { core } = await setUp();
    const empty = await core.createMind({ title: "Empty", folderId: null });
    expect(await core.planMindCheck(empty.id, "all")).toEqual({ kind: "nothing" });
    const emptyFolder = await core.createLibraryGroup({ name: "Nothing yet", description: "" });
    const lonely = await core.createMind({ title: "Lonely", folderId: emptyFolder.id });
    const client = await connectToMind(core, lonely.id);
    writeMind(client, [{ type: "paragraph", attrs: { id: "moon" }, content: [text(MOON)] }]);
    await client.settled();
    expect(await core.planMindCheck(lonely.id, "all")).toMatchObject({
      kind: "ready",
      sentences: 1,
    });
  });
});

describe("A sentence gets the same verdict in Check this note as checked alone", () => {
  // The engine's MAX_STEPS: the model calls one check's Run may make.
  const STEPS = 10;
  const LOAN = "The Northgate Bank term loan stood at £214,480.00 at 31 March 2026.";
  const BANK = "Balance outstanding at 31 March 2026: GBP 212,480.00.";
  const MEMO = `Revenue for the year was £1,284,300. ${LOAN}`;

  // The draft's own sentence would support it; the bank's figure contradicts it.
  function readingModel(runs: ModelCall[], unread = 0) {
    const plans: Record<string, Plan> = { [LOAN]: { judgement: "conflict" } };
    let skipped = 0;
    return scriptedModel(
      (call) => {
        runs.push(call);
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          if (sentenceOf(call) === LOAN && skipped < unread) {
            skipped++;
            return { text: "Verdict: unsupported" };
          }
          return { calls: [{ tool: "search_documents", input: { query: sentenceOf(call) } }] };
        }
        const shown = shownPassages(searches.at(-1)?.text ?? "");
        const itself = shown.find((each) => each.text.includes(sentenceOf(call)));
        const bank = shown.find((each) => each.text.includes(BANK));
        const decided = itself ?? bank;
        if (!decided) return { text: unbackedFigures(call) };
        const quote = itself ? sentenceOf(call) : BANK;
        if (!call.results.some((result) => result.tool === "cite")) {
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: decided.id, quote }] } },
            ],
          };
        }
        const sourceNumbers = readFigures(quote, documentFigureContext([{ text: quote }]));
        return {
          text: `Figures: ${JSON.stringify({
            items: requestedFigures(call).map(({ id, shown }) => {
              const amount = shown === "£214,480.00";
              const at = quote.indexOf(!itself && amount ? "GBP" : shown);
              const position = sourceNumbers.findIndex((figure) => figure.start === at) + 1;
              if (position < 1) throw new Error(`Missing source occurrence for ${shown}.`);
              return {
                id,
                verdict: !itself && amount ? "contradicted" : "supported",
                scope: "same",
                topic: "found",
                roles: "same",
                says: !itself && amount ? "The bank says £212,480.00." : null,
                reading: null,
                relation: "equals",
                source: { citation: 1, position, reading: null, unitQuote: null },
                calculation: null,
              };
            }),
            remainder: null,
          })}`,
        };
      },
      { generate: checkGenerate(plans) },
    );
  }

  async function yearEnd(
    unread = 0,
    model: (runs: ModelCall[]) => ReturnType<typeof scriptedModel> = (runs) =>
      readingModel(runs, unread),
  ) {
    const runs: ModelCall[] = [];
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model(runs)).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    const [bank] = await addAndProcess(core, [
      await writeSourceFile(
        sources,
        "Northgate Bank confirmation.md",
        `# Audit confirmation\n\n${BANK}\n`,
      ),
    ]);
    const folder = await core.createLibraryGroup({ name: "Year end", description: "" });
    await core.moveToFolder({ documentIds: [bank?.id ?? ""], folderId: folder.id });
    const { mindId, client } = await importWordBytes(
      core,
      sources,
      wordFile({ body: wordParagraph(MEMO) }),
      {
        name: "Draft memo.docx",
        origin: "own",
        folderId: folder.id,
        addOriginal: true,
      },
    );
    await waitForDocuments(core, (listed) =>
      expect(listed.filter((each) => each.status === "ready")).toHaveLength(2),
    );
    const loanCheck = () =>
      claimSpans(readMind(client)).find((span) => span.sentence.text.trim() === LOAN)?.check;
    return { core, client, mindId, runs, loanCheck };
  }

  test("an imported draft never counts as its own evidence: the bank's figure contradicts it either way", async () => {
    const { core, client, mindId, runs, loanCheck } = await yearEnd();
    await core.checkMind(request(mindId, "all"));
    expect(loanCheck()).toMatchObject({ state: "contradicted", evidence: { quote: BANK } });

    let blockId = "";
    readMind(client).forEach((node) => {
      if (node.textContent.includes(LOAN)) blockId = String(node.attrs.id);
    });
    const from = MEMO.indexOf(LOAN);
    await core.checkSentences({
      requestId: "alone",
      mindId,
      action: "check-against-documents",
      from: { blockId, offset: from },
      to: { blockId, offset: from + LOAN.length },
    });
    await client.settled();
    expect(loanCheck()).toMatchObject({ state: "contradicted", evidence: { quote: BANK } });

    const shownToChecks = runs.flatMap((call) =>
      call.results
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text)),
    );
    expect(shownToChecks.some((each) => each.document.startsWith("Draft memo"))).toBe(false);
  });

  test("a verdict given before searching isn't kept: the sentence is checked again, and contradicted", async () => {
    const { core, mindId, loanCheck } = await yearEnd(1);
    await core.checkMind(request(mindId, "all"));
    expect(loanCheck()).toMatchObject({ state: "contradicted", evidence: { quote: BANK } });
  });

  test("a model that never searches gets no verdict: the sentence isn't checked, and says why", async () => {
    const { core, mindId, loanCheck } = await yearEnd(2);
    await core.checkMind(request(mindId, "all"));
    expect(loanCheck()).toMatchObject({ state: "not-checked", reason: "unread" });
  });

  test("asking once more comes out of the check's own steps, not a new Run's", async () => {
    const { core, mindId, loanCheck, runs } = await yearEnd(0, (runs) =>
      scriptedModel(
        (call) => {
          const sentence = sentenceOf(call);
          if (sentence !== LOAN) {
            return call.results.length === 0
              ? { calls: [{ tool: "search_documents", input: { query: sentence } }] }
              : { text: "Verdict: unsupported" };
          }
          runs.push(call);
          // Busy with everything but a search until two steps are left, then a verdict each time.
          return call.results.length < STEPS - 2
            ? { calls: [{ tool: "cite", input: { citations: [] } }] }
            : { text: "Verdict: unsupported" };
        },
        { generate: checkGenerate({ [LOAN]: { verdict: "unsupported" } }) },
      ),
    );
    await core.checkMind(request(mindId, "all"));
    expect(loanCheck()).toMatchObject({ state: "not-checked", reason: "unread" });
    expect(runs).toHaveLength(STEPS);
  });
});

describe("Checking selected figures in one sentence", () => {
  const sentence = "Revenue was £20, costs were £5 and cash was £7, and the audit was complete.";
  const source = "Revenue was £20, costs were £9 and cash was £7.";

  async function fixture() {
    let barrier: { entered(): void; until: Promise<void> } | null = null;
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call) => {
        calls.push(call);
        if (!call.results.some((result) => result.tool === "search_documents"))
          return { calls: [{ tool: "search_documents", input: { query: "revenue costs cash" } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const shown = call.results
            .filter((result) => result.tool === "search_documents")
            .flatMap((result) => shownPassages(result.text));
          const passage = shown.find((passage) => passage.text.includes(source));
          if (!passage) throw new Error("Missing fixture source.");
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: source }] },
              },
            ],
          };
        }
        const requested = requestedFigures(call);
        const positions: Record<string, number> = { "£20": 1, "£5": 2, "£7": 3 };
        const reply = {
          text: `Verdict: supported\nAbsence: no\nFigures: ${JSON.stringify({
            items: requested.map(({ id, shown }) => {
              const position = positions[shown];
              if (!position) throw new Error(`Unknown fixture figure ${shown}.`);
              return {
                id,
                verdict: shown === "£5" ? "contradicted" : "supported",
                scope: "same",
                topic: "found",
                roles: "same",
                says: shown === "£5" ? "The source gives costs of £9." : null,
                reading: null,
                relation: "equals",
                source: { citation: 1, position, reading: null, unitQuote: null },
                calculation: null,
              };
            }),
            remainder:
              requested.length === 3
                ? {
                    text: "the audit was complete",
                    verdict: "unsupported",
                    scope: "same",
                    topic: "not found",
                    roles: "same",
                    says: "The source gives no audit conclusion.",
                    citation: null,
                  }
                : null,
          })}`,
        };
        const held = barrier;
        if (!held) return reply;
        barrier = null;
        held.entered();
        return { ...reply, pause: { after: 0, until: held.until } };
      },
      { generate: checkGenerate({ [sentence]: { verdict: "unsupported" } }) },
    );
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(model).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const folder = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(folder, "Accounts.md", source)]);
    const mind = await core.createMind({ title: "Figures", folderId: null });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [{ type: "paragraph", attrs: { id: "amounts" }, content: [text(sentence)] }]);
    await client.settled();
    const rows = async () => {
      await client.settled();
      return (await core.getFigureSchedule(mind.id)).rows;
    };
    const owner = () => {
      const check = claimSpans(readMind(client))[0]?.check;
      if (!check) throw new Error("No owner check was written.");
      return check;
    };
    const keep = async (id?: string) => {
      const check = owner();
      client.doc.transact(() => {
        updateCheck(client.blocks, check.id, (current) =>
          keepCheckAsView(current, id === undefined ? undefined : new Set([id])),
        );
      }, "editor");
      await client.settled();
    };
    const holdNext = () => {
      let entered = () => {};
      let release = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const until = new Promise<void>((resolve) => {
        release = resolve;
      });
      barrier = { entered, until };
      return { started, release };
    };
    return { core, client, mindId: mind.id, model, calls, rows, owner, keep, holdNext };
  }

  test("a selected recheck preserves a kept sibling, a bad sibling and the independent remainder", async () => {
    const { core, mindId, rows, owner, keep, calls } = await fixture();
    await core.checkMind(request(mindId, "all", "initial"));
    const [revenue, costs, cash] = await rows();
    if (!revenue || !costs || !cash) throw new Error("Missing fixture figures.");
    expect([revenue, costs, cash].map((row) => row.shown.state)).toEqual([
      "supported",
      "contradicted",
      "supported",
    ]);
    await keep(revenue.id);
    const before = structuredClone(owner());
    const count = runsIn(calls).length;

    await core.checkMind({ ...request(mindId, "all", "cash"), figureIds: [cash.id] });

    expect((await rows()).map((row) => row.shown.state)).toEqual([
      "kept",
      "contradicted",
      "supported",
    ]);
    const after = owner();
    expect(after.figures?.find((figure) => figure.id === revenue.id)).toEqual(
      before.figures?.find((figure) => figure.id === revenue.id),
    );
    expect(after.figures?.find((figure) => figure.id === costs.id)).toEqual(
      before.figures?.find((figure) => figure.id === costs.id),
    );
    expect(after.remainder).toEqual(before.remainder);
    expect(after.remainder).toMatchObject({ state: "unsupported" });
    expect(
      runsIn(calls)
        .slice(count)
        .map((call) => requestedFigures(call).map(({ shown }) => shown)),
    ).toEqual([["£7"]]);
  });

  test("checking one figure after whole-sentence Keep leaves its siblings and remainder kept", async () => {
    const { core, mindId, rows, owner, keep } = await fixture();
    await core.checkMind(request(mindId, "all", "initial"));
    const cash = (await rows())[2];
    if (!cash) throw new Error("Missing cash figure.");
    await keep();
    expect((await rows()).map((row) => row.shown.state)).toEqual(["kept", "kept", "kept"]);

    await core.checkMind({ ...request(mindId, "all", "cash"), figureIds: [cash.id] });

    expect((await rows()).map((row) => row.shown.state)).toEqual(["kept", "kept", "supported"]);
    expect(owner().remainder).toMatchObject({ kept: true });
    expect(owner().figures?.find((figure) => figure.id === cash.id)?.kept).not.toBe(true);
  });

  test("empty, unknown and duplicate figure ids are rejected before a model call", async () => {
    const { core, mindId, rows, model } = await fixture();
    const first = (await rows())[0];
    if (!first) throw new Error("Missing figure.");
    for (const ids of [[], ["unknown-figure"], [first.id, first.id]])
      await expect(
        core.checkMind({ ...request(mindId, "all", "invalid"), figureIds: ids }),
      ).rejects.toThrow();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  test("a plan of chosen figures counts only the sentences that hold them", async () => {
    const { core, client, mindId, rows } = await fixture();
    const [, , cash] = await rows();
    if (!cash) throw new Error("Missing cash figure.");
    editMind(client, (blocks) => [
      ...blocks,
      { type: "paragraph", attrs: { id: "extra" }, content: [text("The audit was complete.")] },
    ]);
    await client.settled();

    expect(await core.planMindCheck(mindId, "all", false)).toMatchObject({
      kind: "ready",
      sentences: 2,
    });
    expect(await core.planMindCheck(mindId, "all", false, [cash.id])).toMatchObject({
      kind: "ready",
      sentences: 1,
      findsClaims: false,
    });
    await expect(core.planMindCheck(mindId, "all", false, ["unknown-figure"])).rejects.toThrow();
  });

  test("stopping a selected recheck settles only its pending child", async () => {
    const { core, client, mindId, rows, owner, keep, holdNext } = await fixture();
    await core.checkMind(request(mindId, "all", "initial"));
    const [revenue, , cash] = await rows();
    if (!revenue || !cash) throw new Error("Missing fixture figures.");
    await keep(revenue.id);
    const before = structuredClone(owner());
    const held = holdNext();
    const input = { ...request(mindId, "all", "stop"), figureIds: [cash.id] };
    const running = core.checkMind(input);
    try {
      await held.started;
      await client.settled();
      expect((await rows()).map((row) => row.shown.state)).toEqual([
        "kept",
        "contradicted",
        "checking",
      ]);
    } finally {
      await core.cancelCheck(input.requestId);
      held.release();
    }
    expect(await running).toEqual({ kind: "cancelled" });
    expect((await rows()).map((row) => row.shown.state)).toEqual([
      "kept",
      "contradicted",
      "not-checked",
    ]);
    const after = owner();
    expect(after.figures?.find((figure) => figure.id === cash.id)).toMatchObject({
      state: "not-checked",
      reason: "stopped",
    });
    expect(after.figures?.filter((figure) => figure.id !== cash.id)).toEqual(
      before.figures?.filter((figure) => figure.id !== cash.id),
    );
    expect(after.remainder).toEqual(before.remainder);
  });
});

/**
 * A model whose reply naming the claims stops once its first sentence's record has closed: held
 * until `release`, or failing there as a provider that drops the reply does.
 */
function sortStopsAfterFirst(model: LanguageModelV4, then: "held" | "fails") {
  const held = Promise.withResolvers<void>();
  const state = { ended: false, release: () => held.resolve() };
  const wrapped = wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: async ({ doStream, params }) => {
        const result = await doStream();
        const system = params.prompt.find((message) => message.role === "system")?.content;
        if (typeof system !== "string" || !system.startsWith("You sort the sentences"))
          return result;
        const listed = listedSentences(promptText(params.prompt));
        const read = claimPartsReader(listed);
        let named = false;
        const stream = result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            async transform(part, controller) {
              if (named && then === "fails") return;
              if (named) {
                // A provider's reply stops when its request is stopped.
                const stopped = new Promise<void>((resolve) =>
                  params.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
                );
                await Promise.race([held.promise, stopped]);
                if (params.abortSignal?.aborted) {
                  controller.error(new DOMException("The request was aborted.", "AbortError"));
                  return;
                }
              }
              controller.enqueue(part);
              if (part.type === "text-delta" && read(part.delta).length > 0) {
                named = true;
                if (then === "fails")
                  controller.enqueue({ type: "error", error: new Error("Overloaded") });
              }
            },
            flush() {
              state.ended = true;
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
  return { model: wrapped, state };
}

describe("Check this note starts each sentence's check once its claims are named", () => {
  const SECOND = "Spring tide 2 comes at new moon.";

  /** `held`: the first sentence's checks, by their order, wait at their first request until each is resolved. */
  /** A call checks `sentence`: by its words, or, for a record cite's sentence, by its paragraph's. */
  const checking = (sentence: string) => (call: ModelCall) =>
    sentenceOf(call) === sentence || call.prompt.includes(sentence);

  async function noteOfTwo(
    then: "held" | "fails",
    held: readonly Promise<void>[] = [],
    onService = true,
    first = MOON,
  ) {
    const checks: ModelCall[] = [];
    const plans: Record<string, Plan> = {
      [first]: { verdict: "unsupported" },
      ...PLANS,
      [SECOND]: { verdict: "unsupported" },
    };
    const scripted = scriptedModel(
      (call) => {
        checks.push(call);
        const reply = checkReply(call, plans);
        if (call.results.length > 0 || !isCheckRun(call) || !checking(first)(call)) return reply;
        const until = held[runsIn(checks).filter(checking(first)).length - 1];
        return until ? { ...reply, pause: { after: 0, until } } : reply;
      },
      { generate: checkGenerate(plans) },
    );
    const sort = sortStopsAfterFirst(scripted, then);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => sort.model,
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    if (onService) {
      const provider = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
      if (provider.service) await core.allowDataFlow("checks", provider.service.id);
    } else await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
    const mind = await core.createMind({ title: "Tide notes" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      { type: "paragraph", attrs: { id: "first" }, content: [text(first)] },
      { type: "paragraph", attrs: { id: "second" }, content: [text(SECOND)] },
    ]);
    await client.settled();
    const runsOf = (sentence: string) => runsIn(checks).filter(checking(sentence));
    return { core, client, mindId: mind.id, sort: sort.state, runsOf };
  }

  // protects=a sentence's check starts as soon as the reply naming the claims has named its parts, before that reply ends, and that check is the run's: sent once, its verdict landing (#2532); fails_when=the checks wait for the whole reply, or a check started early is sent again; no_claim=how long the model takes.
  test("the first sentence is checked while the rest are still being named, and only once", async () => {
    const { core, client, mindId, sort, runsOf } = await noteOfTwo("held");

    const checking = core.checkMind(request(mindId, "all"));
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
    expect(sort.ended).toBe(false);
    expect(runsOf(SECOND)).toHaveLength(0);
    sort.release();

    expect(await checking).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
    expect(runsOf(MOON)).toHaveLength(1);
    expect(runsOf(SECOND)).toHaveLength(1);
    const shown = await shownChecks(core, client, mindId, null);
    expect(shown.map((each) => [each.sentence, each.shown.state])).toEqual([
      [MOON, "supported"],
      [SECOND, "unsupported"],
    ]);
  });

  /** Each "mindCheck.early" the run sends: its sentences' words, read from the Note as they are then. */
  function earlyShown(core: Core, client: MindClient) {
    const sent: string[][] = [];
    core.on("mindCheck.early", (event) => {
      sent.push(
        event.sentences.map(({ from, to }) => {
          let words = "";
          readMind(client).descendants((node) => {
            if (node.isTextblock && node.attrs.id === from.blockId) {
              words = node.textContent.slice(from.offset, to.offset);
            }
            return words === "";
          });
          return words;
        }),
      );
    });
    return sent;
  }

  // protects=a sentence whose check starts while the rest are still being named is shown to the window as checking at once, never written into the Note, and the list empties as soon as the run marks its claims, while its checks still run (#1624); fails_when=nothing is sent before the reply ends, the Note is marked early, or the list stays until the run ends; no_claim=how the window draws it.
  test("the first sentence is shown as checking while the rest are still being named, and the Note isn't marked until then", async () => {
    const firstRun = Promise.withResolvers<void>();
    const { core, client, mindId, sort, runsOf } = await noteOfTwo("held", [firstRun.promise]);
    const shown = earlyShown(core, client);

    const checking = core.checkMind(request(mindId, "all"));
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
    await client.settled();
    expect(shown).toEqual([[MOON]]);
    expect(claimSpans(readMind(client))).toEqual([]);
    sort.release();
    // Once the run has marked its claims, the list is empty while its checks still run: a
    // sentence edited away meanwhile, which the run doesn't mark, shows as checking no longer.
    await vi.waitFor(() => expect(shown.at(-1)).toEqual([]));
    expect(sort.ended).toBe(true);
    firstRun.resolve();

    expect(await checking).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
    expect(shown).toEqual([[MOON], [MOON, SECOND], []]);
    expect(runsOf(MOON)).toHaveLength(1);
    const marks = await shownChecks(core, client, mindId, null);
    expect(marks.map((each) => [each.sentence, each.shown.state])).toEqual([
      [MOON, "supported"],
      [SECOND, "unsupported"],
    ]);
  });

  // protects=a sentence that has a mark (an earlier check of its older words) isn't shown as checking early, so the window never draws a second mark beside its own (#1624); fails_when=it is listed while the claims are named; no_claim=what the earlier check's parts change in the new one.
  test("a sentence with a mark isn't shown as checking early", async () => {
    const { core, client, mindId, sort, runsOf } = await noteOfTwo("held");
    const check: ClaimCheckAttributes = {
      id: "earlier",
      request: "old",
      action: "check-against-documents",
      state: "unsupported",
      reason: null,
      detail: null,
      providerId: null,
      modelId: null,
      text: "Spring tides come at new moon only.",
      evidence: null,
      says: null,
      unsupported: null,
      calculation: null,
      citedCaseUnchecked: false,
      citedCaseFound: false,
      scope: { folderId: null, widened: false },
      versions: [],
      excluded: [],
      checkedAt: "2026-10-02T13:00:00.000Z",
    };
    editMind(client, ([, ...rest]) => [
      {
        type: "paragraph",
        attrs: { id: "first" },
        content: [{ ...text(MOON), marks: [{ type: CLAIM_CHECK_MARK, attrs: check }] }],
      },
      ...rest,
    ]);
    await client.settled();
    const shown = earlyShown(core, client);

    const checking = core.checkMind(request(mindId, "all"));
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
    expect(sort.ended).toBe(false);
    expect(shown).toEqual([]);
    sort.release();

    expect(await checking).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
    expect(shown).toEqual([[SECOND], []]);
  });

  // protects=a check started early whose sentence the User changed around it while the claims were named is stopped as soon as the run's queue is made, its result dropped, and the sentence checked again as the Note has it then (#2532); fails_when=the early check goes on, its verdict lands, or it isn't sent again with the paragraph's new words; no_claim=what the model says of the new words.
  test("a check started early is stopped and sent again when the paragraph changed before the claims were named", async () => {
    const firstRun = Promise.withResolvers<void>();
    const secondRun = Promise.withResolvers<void>();
    const { core, client, mindId, sort, runsOf } = await noteOfTwo("held", [
      firstRun.promise,
      secondRun.promise,
    ]);

    const checking = core.checkMind(request(mindId, "all"));
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
    typeInto(client, 0, MOON.length, " Neap tides come at the quarter moons.");
    await client.settled();
    sort.release();
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(2));
    const [early, again] = runsOf(MOON);
    // Stopped while the run still checks the sentence again.
    expect(early?.options.abortSignal?.aborted).toBe(true);
    secondRun.resolve();

    expect(await checking).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
    firstRun.resolve();
    expect(early?.prompt).not.toContain("Neap tides");
    expect(again?.prompt).toContain("Neap tides come at the quarter moons.");
    expect(again?.options.abortSignal?.aborted).toBe(false);
    const shown = await shownChecks(core, client, mindId, null);
    expect(shown.find((each) => each.sentence === MOON)?.shown.state).toBe("supported");
  });

  // protects=a check started early is stopped and sent again when the Library changed while the claims were named (a Document renamed, so a record cite's source or a search's names may differ), though its request is the same (#2532); fails_when=only the request decides what is taken; no_claim=which Library changes count beyond a rename.
  test("a check started early is sent again when a Document is renamed before the claims are named", async () => {
    const firstRun = Promise.withResolvers<void>();
    const { core, client, mindId, sort, runsOf } = await noteOfTwo("held", [firstRun.promise]);

    const checking = core.checkMind(request(mindId, "all"));
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
    const [tides] = await core.listDocuments();
    if (!tides) throw new Error("The Document is missing.");
    await core.renameDocument(tides.id, "Tide tables.md");
    sort.release();
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(2));
    expect(runsOf(MOON)[0]?.options.abortSignal?.aborted).toBe(true);
    firstRun.resolve();

    expect(await checking).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
    expect(runsOf(MOON)[1]?.options.abortSignal?.aborted).toBe(false);
    const shown = await shownChecks(core, client, mindId, null);
    expect(shown.find((each) => each.sentence === MOON)?.shown.state).toBe("supported");
  });

  // protects=a check started early is kept when only a model's own status (the reranking model loading, as at a session's first search) or a Document's Tags (as background tagging sets them) change meanwhile, neither of which a check's search reads (#2532); fails_when=either counts as a change and the early check is sent again; no_claim=a sentence about the Library's Tags, whose early check reads them as they were when it started.
  test("a check started early is kept when the reranking model's status or a Document's Tags change before the claims are named", async () => {
    const { core, mindId, sort, runsOf } = await noteOfTwo("held");
    const changes: string[] = [];
    core.on("rerank.changed", () => changes.push("rerank"));
    core.on("documents.tagged", () => changes.push("tagged"));

    const checking = core.checkMind(request(mindId, "all"));
    await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
    await core.downloadRerankingModel();
    const [tides] = await core.listDocuments();
    if (!tides) throw new Error("The Document is missing.");
    const tag = await core.createTag({ name: "Tides" });
    await core.addDocumentTag(tides.id, tag.id);
    expect(changes).toEqual(expect.arrayContaining(["rerank", "tagged"]));
    sort.release();

    expect(await checking).toMatchObject({ kind: "checked", sentences: 2, checked: 2 });
    expect(runsOf(MOON)).toHaveLength(1);
  });

  const elsewhere = {
    "an edit in another paragraph": (client: MindClient) =>
      typeInto(client, 1, SECOND.length, " Neap tides come at the quarter moons."),
    "a source chosen for a record cite": (client: MindClient) =>
      writeRecordCiteChoice(recordCiteSettingsOf(client.doc), "tide dep", {
        documentId: "a-chosen-document",
        contentHash: "a-chosen-version",
      }),
  };
  const CITED = "Spring tides come at new moon (Tide Dep. 4:1–2).";

  // protects=a record cite's check started early is stopped and sent again when the Note changed elsewhere while the claims were named, since its `Id.`, `supra` and source choices read the Note's other paragraphs and settings; a sentence with no record cite is kept (#2532); fails_when=an edit elsewhere or a source chosen leaves a record cite's early check taken, or stops one with no record cite; no_claim=what the record cite resolves to.
  test.each([
    ["an edit in another paragraph", "a sentence with a record cite", CITED, 2],
    ["an edit in another paragraph", "a sentence with none", MOON, 1],
    ["a source chosen for a record cite", "a sentence with a record cite", CITED, 2],
    ["a source chosen for a record cite", "a sentence with none", MOON, 1],
  ] as const)(
    "after %s, %s is checked again only if it cites the record",
    async (change, _, first, runs) => {
      const firstRun = Promise.withResolvers<void>();
      const { core, client, mindId, sort, runsOf } = await noteOfTwo(
        "held",
        [firstRun.promise],
        true,
        first,
      );

      const checking = core.checkMind(request(mindId, "all"));
      await vi.waitFor(() => expect(runsOf(first)).toHaveLength(1));
      elsewhere[change](client);
      await client.settled();
      sort.release();
      if (runs === 2) await vi.waitFor(() => expect(runsOf(first)).toHaveLength(2));
      firstRun.resolve();

      expect(await checking).toMatchObject({ kind: "checked" });
      expect(runsOf(first)).toHaveLength(runs);
      expect(runsOf(first)[0]?.options.abortSignal?.aborted).toBe(runs === 2);
    },
  );

  // protects=when the reply naming the claims fails after naming one, the check started early is stopped and nothing lands, as when no check had started (#2532); fails_when=the early check's verdict lands, or it goes on; no_claim=the Problem the window shows, which the run's failure gives as before.
  test.each(["fails", "stopped"] as const)(
    "when naming the claims %s after the first, the check started early is stopped and nothing is marked",
    async (end) => {
      const firstRun = Promise.withResolvers<void>();
      const { core, client, mindId, runsOf } = await noteOfTwo(end === "fails" ? "fails" : "held", [
        firstRun.promise,
      ]);
      const shown = earlyShown(core, client);

      const checking = core.checkMind(request(mindId, "all"));
      await vi.waitFor(() => expect(runsOf(MOON)).toHaveLength(1));
      if (end === "stopped") await core.cancelCheck(request(mindId, "all").requestId);

      expect(await checking).toMatchObject({ kind: end === "fails" ? "failed" : "cancelled" });
      expect(shown).toEqual([[MOON], []]);
      firstRun.resolve();
      expect(runsOf(MOON)[0]?.options.abortSignal?.aborted).toBe(true);
      expect(runsOf(SECOND)).toHaveLength(0);
      await client.settled();
      expect(claimSpans(readMind(client))).toEqual([]);
    },
  );
});

// protects=a check's searches wait behind a search the User asked for, from whichever flow the check comes (here the public checkClaim), while the searches outside any check go by when they are asked (#2532); fails_when=a check from some flow isn't counted as a check, so its search goes before a Cite… search asked after it; no_claim=how long a search takes.
test("a check's search, from any flow, waits behind a Cite… search asked after it", async () => {
  const inTurn = createRerankQueue();
  const asked: string[] = [];
  const scored: string[] = [];
  const held = Promise.withResolvers<void>();
  const reranker: Reranker = (query, candidates) => {
    asked.push(query);
    return inTurn(async () => {
      scored.push(query);
      if (scored.length === 1) await held.promise;
      return [...candidates];
    });
  };
  const model = scriptedModel((call) => checkReply(call, PLANS), {
    generate: checkGenerate(PLANS),
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
    reranker,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);

  const first = core.findPassages({ text: "spring tides", mindId: null, scope: null });
  await vi.waitFor(() => expect(scored).toEqual(["spring tides"]));
  const checked = core.checkClaim({ claim: MOON });
  await vi.waitFor(() => expect(asked).toHaveLength(2));
  const second = core.findPassages({ text: "full moon", mindId: null, scope: null });
  await vi.waitFor(() => expect(asked).toHaveLength(3));
  held.resolve();
  await Promise.all([first, second, checked]);

  expect(scored.slice(0, 3)).toEqual(["spring tides", "full moon", asked[1]]);
  core.close();
});
