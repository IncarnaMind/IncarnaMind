/**
 * Check this note (#737): every sentence of a Mind that makes a claim,
 * checked in one run; then only what changed. Headings, questions and the
 * User's own opinions are left out, as the model names the claims.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import type { CheckMindInput, Core } from "../../src/core";
import { documentFigureContext } from "../../src/core/answers/calculations";
import { updateCheck } from "../../src/core/answers/checks/sentences";
import {
  CLAIM_CHECK_MARK,
  type ClaimCheckAttributes,
  MIND_SETTINGS_FIELD,
} from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { readFigures } from "../../src/shared/figures";
import { mindCheckOf, writeMindCheck } from "../../src/shared/mindCheck";
import { setMindModel } from "../../src/shared/mindModel";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
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
  type ReportedUsage,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { wordFile, paragraph as wordParagraph } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

const TIDES = {
  name: "Tides.md",
  contents: "# Tides\n\nSpring tides come at new and full moon.\n",
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

const PLANS: Record<string, Plan> = {
  [MOON]: { verdict: "supported", quote: MOON },
  [YEARLY]: {
    verdict: "contradicted",
    quote: "The harbour office publishes the times of high water every week.",
    says: "The harbour office says every week, not every year.",
  },
  [PENGUINS]: { verdict: "unsupported" },
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

/** The check Runs made: each starts with a call that has no Tool results yet. */
const runsIn = (calls: readonly ModelCall[]) =>
  calls.filter((call) => isCheckRun(call) && call.results.length === 0);

/**
 * A core with the two Documents in a Folder, a model on this computer (or,
 * `billed`, one billed per token, each request reporting its tokens), and
 * every call to it kept.
 */
async function setUp(billed?: { usage: ReportedUsage; judged?: ReportedUsage }) {
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
        if (call.system.startsWith("You sort the sentences")) finds.push(call);
        const reply = checkGenerate(PLANS)(call);
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
  const model = scriptedModel(
    (call) => {
      if (!isCheckRun(call)) return { text: "" };
      const sentence = sentenceOf(call);
      if (call.results.length === 0) {
        running.add(sentence);
        most = Math.max(most, running.size);
      }
      const reply = checkReply(call, plans);
      if ("text" in reply && reply.text?.startsWith("Verdict")) running.delete(sentence);
      return reply;
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

describe("Check this note", () => {
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

  test("Check again after two claims are edited checks those two only, without naming the claims again", async () => {
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
      findsClaims: false,
      inFolder: true,
      model: (await core.getSettings()).user.chatModel,
    });
    expect(await core.checkMind(request(mindId, "changed"))).toMatchObject({
      kind: "checked",
      sentences: 2,
    });
    // Two check Runs, and the model wasn't asked again which sentences claim something.
    expect(runsIn(checks).length - runsBefore).toBe(2);
    expect(finds).toHaveLength(1);
    expect(
      (await shownChecks(core, client, mindId, folderId)).map(({ shown }) => shown.state),
    ).toEqual(["unsupported", "contradicted", "unsupported"]);
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
    expect(finds[1]?.prompt).toBe(`[1] ${added}`);
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
    expect(mindCheckOf(client.doc)?.skipped).toHaveLength(3);
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

  // protects=a check holds only while the Documents it rests on are in its scope, and while no Document has joined it (#1669); fails_when=a Document moved out of the Folder, a Mind moved to another Folder, or a Document filed in since still reads as nothing changed; no_claim=the card's words.
  test("a source Document moved out of the Folder, or the Mind moved to another, changes the checks; a Document filed in since is the added ones' to check, not nothing changed", async () => {
    const { core, mindId, folderId, clock } = await setUp();
    await core.checkMind(request(mindId, "all"));
    const unchanged = { kind: "unchanged", since: "2026-10-02T14:20:00.000Z" };
    expect(await core.planMindCheck(mindId, "changed")).toEqual(unchanged);

    const [tides] = (await core.listDocuments()).filter((each) => each.name === "Tides");
    if (!tides) throw new Error("The Tides Document isn't there.");
    await core.moveToFolder({ documentIds: [tides.id], folderId: null });
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      kind: "ready",
      sentences: 1,
      findsClaims: false,
    });
    await core.moveToFolder({ documentIds: [tides.id], folderId });
    expect(await core.planMindCheck(mindId, "changed")).toEqual(unchanged);

    const elsewhere = await core.createLibraryGroup({ name: "Elsewhere", description: "" });
    await core.moveToFolder({ mindIds: [mindId], folderId: elsewhere.id });
    expect(await core.planMindCheck(mindId, "changed")).toMatchObject({
      kind: "ready",
      sentences: 3,
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
    expect(finds[1]?.prompt).toBe(`[1] ${added}`);
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
          text: `Figures: ${JSON.stringify({
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
          id === undefined
            ? { ...current, kept: true }
            : {
                ...current,
                figures: current.figures?.map((figure) =>
                  figure.id === id ? { ...figure, kept: true } : figure,
                ),
              },
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
        .map((call) => requestedFigures(call).map(({ id }) => id)),
    ).toEqual([[cash.id]]);
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
