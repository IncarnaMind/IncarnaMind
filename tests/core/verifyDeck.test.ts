/**
 * Verify a deck (#3275): a .pptx someone else wrote is checked like a PDF, slide by slide, each
 * slide its page, with its tables as tables and its speaker notes checked too.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { VerifyClaimsInput } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { textOriginOf } from "../../src/shared/textOrigins";
import { verificationOf } from "../../src/shared/verification";
import { checkingModel, isCheckRun, type Plan, sentenceOf } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModels } from "../helpers/models";
import { encryptedOfficeFile } from "../helpers/office";
import { plainDeck } from "../helpers/pptx";

const HARBOUR = [
  "# Harbour survey",
  "",
  "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
  "",
  "The north quay holds 42 boats and the south quay holds 19 boats.",
  "",
  "The harbour office is open every day of the year.",
].join("\n");

const SPRING = "Spring tides come at new and full moon.";
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const OFFICE = "The harbour office closes on Sundays.";
const NORTH = "North quay — Boats: 42; Fee (£): 1,260";
const SOUTH = "South quay — Boats: 17; Fee (£): 830";

const PLANS: Record<string, Plan> = {
  [SPRING]: {
    verdict: "supported",
    quote: "Spring tides happen at new moon and at full moon",
    says: "Harbour survey says spring tides happen at new and full moon.",
  },
  [PENGUINS]: { verdict: "unsupported" },
  [OFFICE]: {
    verdict: "contradicted",
    quote: "The harbour office is open every day of the year.",
    says: "Harbour survey says the office is open every day.",
  },
  [NORTH]: {
    verdict: "supported",
    quote: "The north quay holds 42 boats",
    says: "Harbour survey says the north quay holds 42 boats.",
  },
  [SOUTH]: {
    verdict: "contradicted",
    quote: "the south quay holds 19 boats",
    says: "Harbour survey says the south quay holds 19 boats, not 17.",
  },
};

/** The deck someone sent: a title slide, claims as bullets, a slide of nothing, a table, speaker notes. */
const DECK = plainDeck([
  { title: "Harbour review" },
  { title: "Tides", lines: [SPRING, PENGUINS], notes: [OFFICE] },
  {},
  {
    title: "Moorings",
    table: [
      ["Berth", "Boats", "Fee (£)"],
      ["North quay", "42", "1,260"],
      ["South quay", "17", "830"],
    ],
  },
]);

async function setUp(calls: ModelCall[] = []) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(checkingModel(PLANS, calls)).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [await writeSourceFile(sources, "Harbour survey.md", HARBOUR)]);
  return { core, sources };
}

const request = (mindId: string): VerifyClaimsInput => ({
  requestId: crypto.randomUUID(),
  mindId,
});

describe("Verify a deck", () => {
  // protects=a deck someone sends is checked like a PDF, each slide its page, its table a table with a claim a row, its notes checked, a slide of nothing skipped (#3275); fails_when=a slide's title, table or notes run together into one paragraph, a row isn't a claim, or a claim loses its slide
  test("its slides become a Mind, a title a heading, a table a table, the notes after; each claim is checked and keeps its slide", async () => {
    const calls: ModelCall[] = [];
    const { core, sources } = await setUp(calls);
    const path = await writeSourceFile(sources, "Harbour review.pptx", DECK);

    const result = await core.verifyDocument({ path });
    if (!result.ok) throw new Error(`The deck wasn't verified: ${result.reason}`);
    expect(result.mind.title).toBe("Checking: Harbour review");
    const client = await connectToMind(core, result.mind.id);
    await client.settled();

    const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
    expect(blocks.map((block) => [block.type, block.content?.[0]?.text])).toEqual([
      ["heading", "Harbour review"],
      ["heading", "Tides"],
      ["paragraph", SPRING],
      ["paragraph", PENGUINS],
      ["paragraph", OFFICE],
      ["heading", "Moorings"],
      ["table", undefined],
    ]);
    const cells = (blocks[6]?.content ?? []).map((row) =>
      (row.content ?? []).map((cell) => [cell.type, cell.content?.[0]?.content?.[0]?.text ?? ""]),
    );
    expect(cells).toEqual([
      [
        ["tableHeader", "Berth"],
        ["tableHeader", "Boats"],
        ["tableHeader", "Fee (£)"],
      ],
      [
        ["tableCell", "North quay"],
        ["tableCell", "42"],
        ["tableCell", "1,260"],
      ],
      [
        ["tableCell", "South quay"],
        ["tableCell", "17"],
        ["tableCell", "830"],
      ],
    ]);
    // Each Block's page is its slide's number, so the deck beside it turns to that slide.
    const pages = verificationOf(client.doc)?.pages ?? {};
    expect(blocks.map((block) => pages[String(block.attrs?.id)])).toEqual([1, 2, 2, 2, 2, 4, 4]);
    // Someone else wrote it: a Run that reads it is third-party (#78).
    expect(textOriginOf(client.doc, String(blocks[2]?.attrs?.id))).toBe("checked-document");

    expect(await core.findClaims(request(result.mind.id))).toEqual({ kind: "found", claims: 5 });
    await client.settled();
    expect(
      verificationOf(client.doc)?.claims?.map((claim) => [claim.text, pages[claim.blockId]]),
    ).toEqual([
      [SPRING, 2],
      [PENGUINS, 2],
      [OFFICE, 2],
      ["North quay", 4],
      ["South quay", 4],
    ]);

    expect(await core.verifyClaims(request(result.mind.id))).toMatchObject({
      kind: "checked",
      claims: 5,
      checked: 5,
    });
    await client.settled();
    const versions = new Map(
      (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
    );
    expect(
      claimSpans(readMind(client)).map((span) => [
        span.sentence.text,
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions,
          folderId: null,
          scope: null,
        }).state,
      ]),
    ).toEqual([
      [SPRING, "supported"],
      [PENGUINS, "unsupported"],
      [OFFICE, "contradicted"],
      ["North quay", "supported"],
      ["South quay", "contradicted"],
    ]);
    // A row is asked as one claim, said with its columns' headings.
    expect(new Set(calls.filter(isCheckRun).map(sentenceOf))).toEqual(
      new Set([SPRING, PENGUINS, OFFICE, NORTH, SOUTH]),
    );
  });

  // protects=a deck that can't be checked says why in plain words and leaves no Mind (#3275); fails_when=a deck of nothing but pictures, a broken one or one saved with a password makes an empty Mind or a wrong reason
  test("a deck with no text, a broken one and one that needs a password make no Mind and say why", async () => {
    const { core, sources } = await setUp();
    const empty = await writeSourceFile(sources, "Empty.pptx", plainDeck([{}, {}]));
    const broken = await writeSourceFile(sources, "Broken.pptx", "This is no deck.");
    const locked = await writeSourceFile(sources, "Locked.pptx", encryptedOfficeFile());

    expect(await core.verifyDocument({ path: empty })).toEqual({ ok: false, reason: "no-text" });
    expect(await core.verifyDocument({ path: broken })).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(await core.verifyDocument({ path: locked })).toEqual({
      ok: false,
      reason: "password-protected",
    });
    expect((await core.listMinds()).map((mind) => mind.title)).toEqual([]);
  });
});
