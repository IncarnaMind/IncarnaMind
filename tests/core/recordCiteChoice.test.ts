import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Document, RecordCiteResult } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  readRecordCiteChoices,
  recordCiteSettingsOf,
  writeRecordCiteChoice,
} from "../../src/shared/recordCiteChoices";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import type { MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { buildPdf } from "../helpers/pdf";

const CLAIM = "Ex. 7 at 1 proves the record fact.";
const REPEATED = "Ex. 7 at 1 and Ex. 7 at 1 together prove the record fact.";

async function setUp(claim = CLAIM) {
  const plans: Record<string, Plan> = {
    [claim]: {
      verdict: "supported",
      quote: "record fact",
      says: "The exhibit proves the record fact.",
      judgement: "same",
    },
  };
  const model = checkingModel(plans);
  const setup = await setUpWithDocuments(model, [
    { name: "Ex. 7 first.pdf", contents: buildPdf([{ lines: ["record fact", "First copy"] }]) },
    { name: "Ex. 7 second.pdf", contents: buildPdf([{ lines: ["record fact", "Second copy"] }]) },
  ]);
  const block: JSONContent & { attrs: { id: string } } = {
    type: "paragraph",
    attrs: { id: "record-cite-choice" },
    content: [{ type: "text", text: claim }],
  };
  writeMind(setup.client, [block]);
  await setup.client.settled();
  const check = () =>
    setup.core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-documents",
      from: { blockId: block.attrs.id, offset: 0 },
      to: { blockId: block.attrs.id, offset: claim.length },
    });
  const first = setup.documents[0];
  const second = setup.documents[1];
  if (!first || !second) throw new Error("The two exhibit Documents were not added.");
  return { ...setup, model, check, first, second };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function storedCheck(client: MindClient): Promise<ClaimCheckAttributes> {
  await client.settled();
  const spans = claimSpans(readMind(client));
  const check = spans.length === 1 ? spans[0]?.check : undefined;
  if (!check) throw new Error("The Note does not hold exactly one check.");
  return check;
}

function oneCite(check: ClaimCheckAttributes, index = 0): RecordCiteResult {
  const cites = check.recordCites ?? [];
  const cite = cites[index];
  if (!cite || cites.length <= index) throw new Error(`Record cite ${index + 1} is missing.`);
  return cite;
}

async function choose(
  setup: Setup,
  cite: RecordCiteResult,
  document: Document,
  check = storedCheck(setup.client),
) {
  const stored = await check;
  return setup.core.chooseRecordCiteSource({
    mindId: setup.mind.id,
    checkId: stored.id,
    raw: cite.raw,
    from: cite.from,
    to: cite.to,
    documentId: document.id,
  });
}

async function chooseSecond(setup: Setup) {
  const stored = await storedCheck(setup.client);
  return choose(setup, oneCite(stored), setup.second, Promise.resolve(stored));
}

describe("record-cite choices through the core", () => {
  test("lists both candidates, remembers the stable Document id, and keeps the sentence verdict", async () => {
    const setup = await setUp();
    await setup.check();

    const ambiguous = await storedCheck(setup.client);
    expect(ambiguous.state).toBe("supported");
    const candidates = oneCite(ambiguous).candidates;
    expect(oneCite(ambiguous).outcome).toBe("choose");
    expect(candidates).toHaveLength(2);
    expect(candidates).toEqual(
      expect.arrayContaining([
        { id: setup.first.id, name: "Ex. 7 first" },
        { id: setup.second.id, name: "Ex. 7 second" },
      ]),
    );

    const chosen = await chooseSecond(setup);
    expect(chosen.cite).toMatchObject({
      outcome: "supported",
      documentId: setup.second.id,
      contentHash: setup.second.contentHash,
      passage: expect.stringContaining("Second copy"),
    });
    expect(readRecordCiteChoices(recordCiteSettingsOf(setup.client.doc))).toMatchObject({
      previous: { documentId: setup.second.id },
      choices: { "ex 7": { documentId: setup.second.id } },
    });

    await setup.check();
    const remembered = await storedCheck(setup.client);
    expect(remembered.state).toBe("supported");
    expect(oneCite(remembered)).toMatchObject({
      outcome: "supported",
      documentId: setup.second.id,
      contentHash: setup.second.contentHash,
    });
  });

  test("choosing one of two identical raws re-checks only that occurrence", async () => {
    const setup = await setUp(REPEATED);
    await setup.check();
    const ambiguous = await storedCheck(setup.client);
    const first = oneCite(ambiguous, 0);
    const second = oneCite(ambiguous, 1);
    expect(first.from).not.toBe(second.from);
    expect(ambiguous.recordCites?.map((cite) => cite.outcome)).toEqual(["choose", "choose"]);
    const generateCalls = setup.model.doGenerateCalls.length;

    await choose(setup, first, setup.second, Promise.resolve(ambiguous));

    const updated = await storedCheck(setup.client);
    expect(updated.recordCites?.map((cite) => cite.outcome)).toEqual(["supported", "choose"]);
    expect(oneCite(updated, 0)).toMatchObject({ documentId: setup.second.id, from: first.from });
    expect(oneCite(updated, 1)).toMatchObject({ from: second.from, candidates: second.candidates });
    expect(setup.model.doGenerateCalls.length - generateCalls).toBe(1);
    expect(updated.state).toBe("supported");
  });

  test("a deleted chosen Document asks again instead of silently using the survivor", async () => {
    const setup = await setUp();
    await setup.check();
    await chooseSecond(setup);
    await setup.core.deleteDocument(setup.second.id);

    await setup.check();

    const invalidated = oneCite(await storedCheck(setup.client));
    expect(invalidated).toMatchObject({
      outcome: "choose",
      candidates: [{ id: setup.first.id, name: "Ex. 7 first" }],
    });
    expect(
      readRecordCiteChoices(recordCiteSettingsOf(setup.client.doc)).choices["ex 7"],
    ).toMatchObject({ documentId: setup.second.id });
  });

  test("a saved Location that no longer matches its Document asks again", async () => {
    const setup = await setUp();
    await setup.check();
    await chooseSecond(setup);
    writeRecordCiteChoice(recordCiteSettingsOf(setup.client.doc), "ex 7", {
      documentId: setup.second.id,
      location: {
        kind: "page",
        from: 1,
        to: 1,
        printed: { from: "changed", to: "changed" },
      },
    });
    await setup.client.settled();

    await setup.check();

    const invalidated = oneCite(await storedCheck(setup.client));
    expect(invalidated.outcome).toBe("choose");
    expect(invalidated.candidates).toHaveLength(2);
    expect(invalidated.candidates?.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([setup.first.id, setup.second.id]),
    );
  });

  test("a direct check without a Note returns candidates without persisting a choice", async () => {
    const setup = await setUp();

    const result = await setup.core.checkClaim({ claim: CLAIM });

    expect(result.verdict).toBe("supported");
    expect(result.recordCites).toHaveLength(1);
    expect(result.recordCites?.[0]?.outcome).toBe("choose");
    expect(result.recordCites?.[0]?.candidates).toHaveLength(2);
    expect(result.recordCites?.[0]?.candidates?.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([setup.first.id, setup.second.id]),
    );
    expect(readRecordCiteChoices(recordCiteSettingsOf(setup.client.doc))).toEqual({
      previous: null,
      choices: {},
    });
  });
});
