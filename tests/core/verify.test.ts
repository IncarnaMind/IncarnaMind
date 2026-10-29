/**
 * Verify (#97): a PDF someone else wrote becomes a Mind of its text, its
 * claims are found, and each is checked against the User's Documents, the
 * PDF and its copies never evidence, with marks that go "needs re-check" as
 * Check against Documents' do (#96).
 */
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import type { Core, VerifyClaimsInput } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { textOriginOf } from "../../src/shared/textOrigins";
import { verificationOf } from "../../src/shared/verification";
import {
  checkGenerate,
  checkingModel,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  requestedFigures,
  sentenceOf,
  unsupportedReply,
} from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient, typeInto } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Harbours publish the times of high water every year.",
  ].join("\n"),
};

const SUPPORTED = "Spring tides come at new and full moon.";
const CONTRADICTED = "Harbours publish the times of high water every week.";
const UNSUPPORTED = "Penguins nest on the cliffs above the harbour.";
const THANKS = "Thank you for reading this report.";

/** The report someone else wrote: a title, three claims under two headings, and thanks. */
const REPORT = buildPdf([
  { lines: ["Harbour report", "1 Tides", SUPPORTED, CONTRADICTED] },
  { lines: ["2 Wildlife", UNSUPPORTED, THANKS] },
]);

const PLANS: Record<string, Plan> = {
  [SUPPORTED]: {
    verdict: "supported",
    quote: "Spring tides happen at new moon and at full moon",
    says: "Tides says spring tides happen at new and full moon.",
  },
  [CONTRADICTED]: {
    verdict: "contradicted",
    quote: "Harbours publish the times of high water every year.",
    says: "Tides says harbours publish them every year, not every week.",
  },
  [UNSUPPORTED]: { verdict: "unsupported" },
};

/** A core with the Tides Document, the report on disk, and a model on this computer. */
async function setUp(model = checkingModel(PLANS)) {
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const [tides] = await addAndProcess(core, [
    await writeSourceFile(sources, TIDES.name, TIDES.contents),
  ]);
  const report = await writeSourceFile(sources, "Harbour report.pdf", REPORT);
  return { core, sources, report, tides };
}

/** Verifies the report: its Mind, with a client. */
async function verified(core: Core, path: string) {
  const result = await core.verifyDocument({ path });
  if (!result.ok) throw new Error(`The report wasn't verified: ${result.reason}`);
  const client = await connectToMind(core, result.mind.id);
  await client.settled();
  return { ...result, client };
}

const request = (mindId: string, more: Partial<VerifyClaimsInput> = {}): VerifyClaimsInput => ({
  requestId: crypto.randomUUID(),
  mindId,
  ...more,
});

/** Each claim's mark, as the editor shows it now. */
async function shownChecks(core: Core, client: MindClient) {
  await client.settled();
  const versions = new Map((await core.listDocuments()).map((each) => [each.id, each.contentHash]));
  return claimSpans(readMind(client)).map((span) => ({
    sentence: span.sentence.text,
    check: span.check,
    shown: claimCheckShown(span.check, {
      text: span.sentence.text,
      versions,
      folderId: null,
      scope: null,
    }),
  }));
}

describe("Verify a document", () => {
  test("its text becomes a Mind, a paragraph or numbered heading to a Block with its page; its claims are found, then checked", async () => {
    const { core, report, tides } = await setUp();
    const { mind, documentId, client } = await verified(core, report);

    expect(mind.title).toBe("Checking: Harbour report");
    const paragraphs: JSONContent[] = readMind(client).toJSON().content ?? [];
    expect(paragraphs.map((block) => [block.type, block.content?.[0]?.text])).toEqual([
      ["paragraph", "Harbour report"],
      ["heading", "1 Tides"],
      ["paragraph", SUPPORTED],
      ["paragraph", CONTRADICTED],
      ["heading", "2 Wildlife"],
      ["paragraph", UNSUPPORTED],
      ["paragraph", THANKS],
    ]);
    const ids = paragraphs.map((block) => String(block.attrs?.id));
    expect(verificationOf(client.doc)).toEqual({
      documentId,
      documentName: "Harbour report",
      pages: Object.fromEntries(ids.map((id, index) => [id, index < 4 ? 1 : 2])),
      claims: null,
    });
    // Someone else wrote it: a Run that reads it is third-party (#78).
    expect(ids.map((id) => textOriginOf(client.doc, id))).toEqual(
      ids.map(() => "checked-document"),
    );

    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 3 });
    await client.settled();
    expect(verificationOf(client.doc)?.claims?.map((claim) => claim.text)).toEqual([
      SUPPORTED,
      CONTRADICTED,
      UNSUPPORTED,
    ]);

    expect(await core.verifyClaims(request(mind.id))).toEqual({
      kind: "checked",
      claims: 3,
      checked: 3,
      stop: null,
    });
    const checks = await shownChecks(core, client);
    expect(checks.map((each) => [each.sentence, each.shown])).toEqual([
      [SUPPORTED, { state: "supported" }],
      [CONTRADICTED, { state: "contradicted" }],
      [UNSUPPORTED, { state: "unsupported" }],
    ]);
    expect(checks[1]?.check).toMatchObject({
      action: "check-against-documents",
      says: "Tides says harbours publish them every year, not every week.",
      evidence: { documentId: tides?.id, quote: PLANS[CONTRADICTED]?.quote, check: "found" },
    });
  });

  test("a sentence no reply decides, even asked again, is checked as a claim (#1682)", async () => {
    const sorts: string[] = [];
    const model = scriptedModel((call) => checkReply(call, PLANS), {
      generate: (call) => {
        const reply = checkGenerate(PLANS)(call);
        if (!call.system.startsWith("You sort the sentences") || !("text" in reply)) return reply;
        sorts.push(call.prompt);
        const decisions = JSON.parse(reply.text) as { sentences: { number: number }[] };
        const missing = new Set(
          listedSentences(call.prompt)
            .filter(({ text }) => text === UNSUPPORTED)
            .map(({ number }) => number),
        );
        return { text: JSON.stringify({
          ...decisions,
          sentences: decisions.sentences.filter(({ number }) => !missing.has(number)),
        }) };
      },
    });
    const { core, report } = await setUp(model);
    const { mind, client } = await verified(core, report);

    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 3 });
    expect(sorts).toHaveLength(2);
    await client.settled();
    expect(verificationOf(client.doc)?.claims?.map((claim) => claim.text)).toEqual([
      SUPPORTED,
      CONTRADICTED,
      UNSUPPORTED,
    ]);
  });

  test("the PDF, and a copy of it at another path, never appear as evidence", async () => {
    const calls: ModelCall[] = [];
    const { core, sources, report } = await setUp(checkingModel(PLANS, calls));
    const copy = join(sources, "Copies", "Harbour report (received).pdf");
    await writeSourceFile(sources, "Copies/.keep", "");
    await copyFile(report, copy);
    await addAndProcess(core, [copy]);
    const { mind } = await verified(core, report);

    await core.findClaims(request(mind.id));
    await core.verifyClaims(request(mind.id));

    const searched = calls.flatMap((call) =>
      call.results
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => shownPassages(result.text).map((passage) => passage.document)),
    );
    expect(searched.length).toBeGreaterThan(0);
    expect(new Set(searched)).toEqual(new Set(["Tides"]));
  });

  test("a memo opened through Verify is marked Don't cite: its claims stay Unsupported, and turning the mark off lets it support them in a check of its own", async () => {
    const DREDGING = "The harbour dredging finished in March 2024.";
    const COST = "The channel dredging cost 4.2 million.";
    const calls: ModelCall[] = [];
    const supportsWhatItSees = scriptedModel(
      (call) => {
        calls.push(call);
        const sentence = sentenceOf(call);
        const searches = call.results.filter((result) => result.tool === "search_documents");
        if (searches.length === 0) {
          return { calls: [{ tool: "search_documents", input: { query: sentence } }] };
        }
        const quote = sentence.replace(/\.$/, "");
        const seen = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
          each.text.includes(quote),
        );
        if (!seen) return { text: unsupportedReply(call) };
        if (!call.results.some((result) => result.tool === "cite")) {
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: seen.id, quote }] },
              },
            ],
          };
        }
        return { text: "Verdict: supported\nThe memo says so [^1]" };
      },
      {
        generate: checkGenerate({
          [DREDGING]: { verdict: "unsupported" },
          [COST]: { verdict: "unsupported" },
        }),
      },
    );
    const { core, sources } = await setUp(supportsWhatItSees);
    const memo = await writeSourceFile(
      sources,
      "Dredging memo.pdf",
      buildPdf([{ lines: ["Dredging memo", DREDGING, COST] }]),
    );
    const { mind, documentId, client } = await verified(core, memo);
    const kept = () =>
      core.listDocuments().then((all) => all.find((each) => each.id === documentId));
    expect(await kept()).toMatchObject({ name: "Dredging memo", notCited: true });

    await core.findClaims(request(mind.id));
    await core.verifyClaims(request(mind.id));
    const first = await shownChecks(core, client);
    expect(first.map((each) => each.shown)).toEqual([
      { state: "unsupported" },
      { state: "unsupported" },
    ]);
    // A figure keeps its own result, as the one Check gives it.
    expect(first[1]?.check.figures?.map((figure) => figure.reading.chars)).toEqual(["4.2 million"]);

    expect(await core.checkClaim({ claim: DREDGING })).toMatchObject({
      verdict: "unsupported",
      excluded: [{ documentId, reason: "own-workings" }],
    });

    await core.setNotCited(documentId, false);
    expect(await core.checkClaim({ claim: DREDGING })).toMatchObject({
      verdict: "supported",
      evidence: { documentId, documentName: "Dredging memo" },
    });
    await core.verifyClaims(request(mind.id));
    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "unsupported" },
      { state: "unsupported" },
    ]);
  });

  test("a file the Library already had keeps the User's choice when Verify opens it", async () => {
    const { core, report } = await setUp();
    await addAndProcess(core, [report]);
    const { documentId } = await verified(core, report);
    expect((await core.listDocuments()).find((each) => each.id === documentId)?.notCited).toBe(
      false,
    );
  });

  test("a claim the model fails on says “not checked”, and the others are checked", async () => {
    const plans: Record<string, Plan> = {
      ...PLANS,
      [UNSUPPORTED]: { reply: { error: { status: 500, message: "The model fell over." } } },
    };
    const { core, report } = await setUp(checkingModel(plans));
    const { mind, client } = await verified(core, report);
    await core.findClaims(request(mind.id));

    expect(await core.verifyClaims(request(mind.id))).toMatchObject({ claims: 3, checked: 2 });
    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "supported" },
      { state: "contradicted" },
      { state: "not-checked", reason: "failed" },
    ]);
  });

  test("the monthly cap stops the run: the claims left say “not checked: cost cap”, and nothing is sent", async () => {
    const calls: ModelCall[] = [];
    const model = checkingModel(PLANS, calls);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => model,
      now: manualClock("2026-10-13T09:00:00.000Z").now,
    });
    core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
    await core.saveChatProvider({
      kind: "anthropic",
      modelId: "claude-haiku-5-5",
      apiKey: "sk-test",
    });
    const sources = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(sources, TIDES.name, TIDES.contents)]);
    const { mind, client } = await verified(
      core,
      await writeSourceFile(sources, "Harbour report.pdf", REPORT),
    );
    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 3 });

    await core.updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } });
    expect(await core.verifyClaims(request(mind.id))).toEqual({
      kind: "checked",
      claims: 3,
      checked: 0,
      stop: { reason: "cost-cap" },
    });
    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual(
      [SUPPORTED, CONTRADICTED, UNSUPPORTED].map(() => ({
        state: "not-checked",
        reason: "cost-cap",
      })),
    );
    expect(calls).toEqual([]);
  });

  test("results go “needs re-check” as Check against Documents' do: an edited claim", async () => {
    const { core, report } = await setUp();
    const { mind, client } = await verified(core, report);
    await core.findClaims(request(mind.id));
    await core.verifyClaims(request(mind.id));

    typeInto(client, 2, 0, "Not all ");

    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual([
      { state: "needs-recheck", why: "edited" },
      { state: "contradicted" },
      { state: "unsupported" },
    ]);
  });

  test("empty states: no claims found, and nothing to check against", async () => {
    const { core, report } = await setUp(checkingModel({}));
    const { mind } = await verified(core, report);
    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 0 });
    expect(await core.verifyClaims(request(mind.id))).toEqual({ kind: "nothing" });

    const alone = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(checkingModel(PLANS)).createChatModel,
    });
    await alone.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const lonely = await verified(alone, report);
    // The PDF is the only Document, and it is never its own evidence.
    expect(await alone.findClaims(request(lonely.mind.id))).toEqual({
      kind: "no-documents",
      folderId: null,
    });
  });

  test("read from the PDF, a sentence runs on past a line that starts with a year, and a numbered heading stays a heading", async () => {
    const { core, sources } = await setUp();
    const progress = await writeSourceFile(
      sources,
      "Progress report.pdf",
      buildPdf([
        {
          lines: [
            "Riverside Library roof and insulation works: progress report 3",
            "1 Summary",
            "This report covers the roof and insulation package from 1 to 31 March 2027. Roof works were",
            "programmed to start on 4 January 2027. Under our contract, the package is due to be completed in April",
            "2027. Our contract for the roof and insulation package is valued at £1,240,000.",
            "2 Progress",
            "Forty-two operatives worked on site during March.",
          ],
        },
      ]),
    );
    const { client } = await verified(core, progress);

    const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
    expect(blocks.map((block) => [block.type, block.content?.[0]?.text])).toEqual([
      ["paragraph", "Riverside Library roof and insulation works: progress report 3"],
      ["heading", "1 Summary"],
      [
        "paragraph",
        "This report covers the roof and insulation package from 1 to 31 March 2027. Roof works were programmed to start on 4 January 2027. Under our contract, the package is due to be completed in April 2027. Our contract for the roof and insulation package is valued at £1,240,000.",
      ],
      ["heading", "2 Progress"],
      ["paragraph", "Forty-two operatives worked on site during March."],
    ]);
  });

  // protects=a verified PDF's tables keep their rows and columns, and each row is checked as one claim with its label and headings (#1368); fails_when=a table is flattened into a paragraph, a figure runs into the next label, or a row's claim reaches the model without its label and headings; no_claim=tables in scanned pages.
  test("a PDF's tables are tables in its Mind, and each row is a claim said with its columns' headings", async () => {
    const FIXED_ASSETS = "固定资产 — 期末余额: 9,470; 期初余额: 8,860";
    const NET_PROFIT = "净利润 — 本年金额: 1,620; 上年金额: 1,215";
    const LEDGER = "Fleet ledger.md";
    const fixedQuote = "固定资产期末余额 9,470 万元，期初余额 8,860 万元";
    const profitQuote = "净利润本年金额 1,580 万元，上年金额 1,215 万元";
    const rowPlan = (
      claim: string,
      quote: string,
      verdict: "supported" | "contradicted",
      bindings: Record<string, { number: string; verdict: "supported" | "contradicted" }>,
    ): Plan => {
      const base: Plan = { verdict, quote };
      return {
        ...base,
        reply(call) {
          const reply = checkReply(call, { [claim]: base });
          if ("calls" in reply) return reply;
          return {
            text: `Verdict: ${verdict}\nFigures: ${JSON.stringify({
              items: requestedFigures(call).map(({ id, shown, reading }) => {
                const binding = bindings[shown];
                if (!binding) throw new Error(`No checked row fixture for ${shown}`);
                return {
                  id,
                  verdict: binding.verdict,
                  scope: "same",
                  topic: "found",
                  roles: "same",
                  says: null,
                  reading,
                  relation: "equals",
                  source: { citation: 1, number: binding.number },
                  calculation: null,
                };
              }),
              remainder: null,
            })}`,
          };
        },
      };
    };
    const calls: ModelCall[] = [];
    const { core, sources } = await setUp(
      checkingModel(
        {
          [FIXED_ASSETS]: rowPlan(FIXED_ASSETS, fixedQuote, "supported", {
            "9,470": { number: "9,470", verdict: "supported" },
            "8,860": { number: "8,860", verdict: "supported" },
          }),
          [NET_PROFIT]: rowPlan(NET_PROFIT, profitQuote, "contradicted", {
            "1,620": { number: "1,580", verdict: "contradicted" },
            "1,215": { number: "1,215", verdict: "supported" },
          }),
        },
        calls,
      ),
    );
    await addAndProcess(core, [
      await writeSourceFile(
        sources,
        LEDGER,
        `# 车队台账\n\n2025 年${fixedQuote}。${profitQuote}。\n`,
      ),
    ]);
    const statement = join(sources, "2025年度财务报表.pdf");
    await copyFile(join(__dirname, "../fixtures/organize/files/2025年度财务报表.pdf"), statement);
    const { mind, client } = await verified(core, statement);

    const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
      "table",
      "paragraph",
      "table",
      "paragraph",
      "table",
      "heading",
      "paragraph",
    ]);
    const cells = (table: JSONContent | undefined) =>
      (table?.content ?? []).map((row) =>
        (row.content ?? []).map((cell) => [cell.type, cell.content?.[0]?.content?.[0]?.text ?? ""]),
      );
    const balance = cells(blocks[2]);
    expect(balance[0]).toEqual([
      ["tableHeader", "项目"],
      ["tableHeader", "期末余额"],
      ["tableHeader", "期初余额"],
    ]);
    expect(balance[3]).toEqual([
      ["tableCell", "固定资产"],
      ["tableCell", "9,470"],
      ["tableCell", "8,860"],
    ]);
    expect(balance).toHaveLength(9);
    expect(blocks[3]?.content?.[0]?.text).toBe("二、利润表（2025 年度）");

    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 2 });
    await client.settled();
    expect(verificationOf(client.doc)?.claims?.map((claim) => claim.text)).toEqual([
      "固定资产",
      "净利润",
    ]);
    // Each row's page is the PDF's, so the PDF beside it turns there.
    const pages = verificationOf(client.doc)?.pages ?? {};
    for (const claim of verificationOf(client.doc)?.claims ?? []) {
      expect(pages[claim.blockId]).toBe(1);
    }

    expect(await core.verifyClaims(request(mind.id))).toMatchObject({ kind: "checked", claims: 2 });
    const checks = await shownChecks(core, client);
    expect(checks.map((each) => [each.sentence, each.shown])).toEqual([
      ["固定资产", { state: "supported" }],
      ["净利润", { state: "contradicted" }],
    ]);
    const asked = calls.filter(isCheckRun).map(sentenceOf);
    expect(new Set(asked)).toEqual(new Set([FIXED_ASSETS, NET_PROFIT]));
  });

  // protects=a table that goes on over the page is one table with its headings, each row with its page, and a section's name and the caption are what a row's claim refers to (#1368); fails_when=the second page's rows lose their headings, carry the first page's, or a table is taken for a caption; no_claim=tables with a running head between them.
  test("a table that goes on over the page is one table, each row with its page; a row's claim refers to its section and caption", async () => {
    const CASH = "Cash — 2025: 3,820; 2024: 3,145";
    const FIXED = "Fixed assets — 2025: 9,470; 2024: 8,860";
    const calls: ModelCall[] = [];
    const { core, sources } = await setUp(
      checkingModel(
        { [CASH]: { verdict: "unsupported" }, [FIXED]: { verdict: "unsupported" } },
        calls,
      ),
    );
    const row = (y: number, cells: readonly string[]) =>
      cells.map((text, column) => ({ text, x: [72, 260, 340][column] ?? 72, y }));
    const balance = await writeSourceFile(
      sources,
      "Balance sheet.pdf",
      buildPdf([
        {
          lines: ["Balance sheet at 31 December (in thousands)"],
          placed: [
            ...row(720, ["Item", "2025", "2024"]),
            ...row(706, ["Current assets:"]),
            ...row(692, ["Cash", "3,820", "3,145"]),
            ...row(678, ["Receivables", "2,610", "2,290"]),
            ...row(664, ["Inventory", "1,100", "950"]),
          ],
        },
        {
          placed: [
            ...row(760, ["Fixed assets", "9,470", "8,860"]),
            ...row(746, ["Total assets", "17,350", "15,920"]),
            ...row(732, ["Loans", "1,500", "2,000"]),
          ],
        },
      ]),
    );
    const { mind, client } = await verified(core, balance);

    const blocks: JSONContent[] = readMind(client).toJSON().content ?? [];
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "table"]);
    const rows = (blocks[1]?.content ?? []).map((each) =>
      (each.content ?? []).map((cell) => cell.content?.[0]?.content?.[0]?.text ?? ""),
    );
    expect(rows).toEqual([
      ["Item", "2025", "2024"],
      ["Current assets:", "", ""],
      ["Cash", "3,820", "3,145"],
      ["Receivables", "2,610", "2,290"],
      ["Inventory", "1,100", "950"],
      ["Fixed assets", "9,470", "8,860"],
      ["Total assets", "17,350", "15,920"],
      ["Loans", "1,500", "2,000"],
    ]);
    const pages = verificationOf(client.doc)?.pages ?? {};
    const pageOfRow = (index: number) =>
      pages[String(blocks[1]?.content?.[index]?.content?.[0]?.content?.[0]?.attrs?.id)];
    expect([pageOfRow(2), pageOfRow(5), pageOfRow(7)]).toEqual([1, 2, 2]);

    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "found", claims: 2 });
    await client.settled();
    expect(verificationOf(client.doc)?.claims?.map((claim) => claim.text)).toEqual([
      "Cash",
      "Fixed assets",
    ]);
    await core.verifyClaims(request(mind.id));
    const promptOf = (claim: string) =>
      calls.find((call) => sentenceOf(call) === claim)?.prompt ?? "";
    expect(promptOf(CASH)).toContain("Current assets:");
    expect(promptOf(CASH)).toContain("Balance sheet at 31 December (in thousands)");
    expect(promptOf(FIXED)).toContain("Balance sheet at 31 December (in thousands)");
    expect(promptOf(FIXED)).not.toContain("\uFFFC");
  });

  test("a PDF with no text, or one that can't be read, makes no Mind and says why", async () => {
    const { core, sources } = await setUp();
    const blank = await writeSourceFile(sources, "Blank.pdf", buildPdf([{ lines: [] }]));
    const broken = await writeSourceFile(sources, "Broken.pdf", "This is no PDF.");

    expect(await core.verifyDocument({ path: blank })).toEqual({ ok: false, reason: "no-text" });
    expect(await core.verifyDocument({ path: broken })).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect((await core.listMinds()).map((mind) => mind.title)).toEqual([]);
  });

  test("one run at a time: another asked for while one runs says which Mind it is in", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = scriptedModel(
      () => ({ text: "Verdict: unsupported", pause: { after: 0, until: held } }),
      {
        generate: (call) => ({
          text: JSON.stringify({
            sentences: listedSentences(call.prompt).map(({ number, text }) => ({
              number,
              parts: number <= 3 ? [{ kind: "fact", text }] : [],
            })),
          }),
        }),
      },
    );
    const { core, report } = await setUp(model);
    const { mind, client } = await verified(core, report);
    await core.findClaims(request(mind.id));
    const first = request(mind.id);
    const running = core.verifyClaims(first);
    await vi.waitFor(async () => expect(await shownChecks(core, client)).toHaveLength(3));

    expect(await core.verifyClaims(request(mind.id))).toEqual({ kind: "busy", mindId: mind.id });
    expect(await core.findClaims(request(mind.id))).toEqual({ kind: "busy", mindId: mind.id });

    await core.cancelCheck(first.requestId);
    release();
    expect(await running).toEqual({ kind: "cancelled" });
    expect((await shownChecks(core, client)).map((each) => each.shown)).toEqual(
      [1, 2, 3].map(() => ({ state: "not-checked", reason: "stopped" })),
    );
  });
});
