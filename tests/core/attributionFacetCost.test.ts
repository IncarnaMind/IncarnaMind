import { describe, expect, test } from "vitest";
import { markedSentences } from "../../src/core/answers/checks/sentences";
import { setMindScope } from "../../src/shared/mindScope";
import { requestedFigures } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

type Mode = "plain" | "native-supported" | "native-contradicted" | "factual-supported";

const CASES = [
  {
    language: "en",
    qualifier: "Currently",
    numeric: "the base rate is 5%.",
    plain: "The base rate was 5%.",
    factual: "the branch is open.",
    oldRate: "On 1 March 2026, the base rate was 5%.",
    newRate: "On 30 October 2026, the base rate is 6%.",
    oldStatus: "On 1 March 2026, the branch was open.",
    newStatus: "On 30 October 2026, the branch is closed.",
    decoy: "On 30 October 2026, an unrelated bank's base rate is 9%.",
  },
  {
    language: "zh-CN",
    qualifier: "目前",
    numeric: "基准利率为5%。",
    plain: "基准利率曾为5%。",
    factual: "分行已营业。",
    oldRate: "2026年3月1日，基准利率为5%。",
    newRate: "2026年10月30日，基准利率为6%。",
    oldStatus: "2026年3月1日，分行已营业。",
    newStatus: "2026年10月30日，分行已停业。",
    decoy: "2026年10月30日，另一家无关银行的基准利率为9%。",
  },
] as const;

async function measure(row: (typeof CASES)[number], mode: Mode) {
  const plain = mode === "plain";
  const factual = mode === "factual-supported";
  const fact = plain ? row.plain : factual ? row.factual : row.numeric;
  const claim = plain ? fact : `${row.qualifier}${row.language === "en" ? ", " : "，"}${fact}`;
  const quotes = factual ? [row.oldStatus, row.newStatus] : [row.oldRate, row.newRate];
  const mainMarker = mode === "native-contradicted" ? 2 : 1;
  const expectedNative = mode === "native-contradicted" ? "contradicted" : "supported";
  const plans = [
    ...(!plain ? [{ kind: "fact", text: row.qualifier, facet: { kind: "time" } }] : []),
    { kind: "fact", text: fact },
  ];
  const frames: ModelCall[] = [];
  const comparisons: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      frames.push(call);
      const search = call.results.find((result) => result.tool === "search_documents");
      if (!search)
        return {
          text: `Parts: ${JSON.stringify(plans)}`,
          calls: [{ tool: "search_documents", input: { query: quotes.join(" ") } }],
        };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = shownPassages(search.text);
        expect(passages.some((passage) => passage.text.includes(row.decoy))).toBe(false);
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: (plain ? quotes.slice(0, 1) : quotes).map((quote, index) => {
                  const passage = passages.find((candidate) => candidate.text.includes(quote));
                  if (!passage)
                    throw new Error("The time-cost Source quote was not in the scoped search.");
                  return { marker: index + 1, passage: passage.id, quote };
                }),
              },
            },
          ],
        };
      }
      const figures = requestedFigures(call);
      return {
        text: [
          `Verdict: ${expectedNative}`,
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Calculation: none",
          `Evidence: [${mainMarker}]`,
          `${quotes[0]} [^1]`,
          ...(!plain ? [`${quotes[1]} [^2]`] : []),
          ...(figures.length
            ? [
                `Figures: ${JSON.stringify({
                  items: figures.map((figure) => ({
                    id: figure.id,
                    verdict: expectedNative,
                    scope: "same",
                    topic: "found",
                    roles: "same",
                    says: quotes[mainMarker - 1],
                    reading: figure.reading,
                    relation: "equals",
                    source: { citation: mainMarker, number: mainMarker === 2 ? "6%" : "5%" },
                    calculation: null,
                  })),
                  remainder: null,
                })}`,
              ]
            : []),
          ...(!plain
            ? [
                `Facets: ${JSON.stringify({
                  items: [
                    {
                      text: row.qualifier,
                      kind: "time",
                      occurrence: 1,
                      verdict: "contradicted",
                      scope: "same",
                      topic: "found",
                      roles: "same",
                      says: quotes[1],
                      evidence: [2],
                      time: "present",
                      period: { start: "2026-10-30", end: "2026-10-30", precision: "day" },
                    },
                  ],
                })}`,
              ]
            : []),
        ].join("\n"),
      };
    },
    {
      generate: (call) => {
        comparisons.push(call);
        if (!call.system.startsWith("Compare a sentence"))
          throw new Error("The time-cost test received an unexpected auxiliary request.");
        return {
          text: call.system.includes("exactly three lines")
            ? `Sentence: ${claim}\nQuote: ${quotes[1]}\nJudgement: conflict`
            : "conflict",
        };
      },
    },
  );
  const setup = await setUpWithDocuments(model, [], {
    now: manualClock("2026-10-30T12:00:00.000Z").now,
  });
  const { settings } = await setup.core.getLibrary();
  await setup.core.saveLibrarySettings({ ...settings, automatic: false });
  const folder = await createTempDataFolder();
  const paths = await Promise.all([
    writeSourceFile(folder, "Earlier statement.md", quotes[0] ?? ""),
    writeSourceFile(folder, "Current statement.md", quotes[1] ?? ""),
    writeSourceFile(folder, "Unrelated bank.md", row.decoy),
  ]);
  const [older, newer, decoy] = await addAndProcess(setup.core, paths);
  if (!older || !newer || !decoy)
    throw new Error("The three time-cost Documents were not imported.");
  await setup.core.updateSettings({ user: { language: row.language } });
  const blockId = "facet-cost";
  writeMind(setup.client, [
    { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: claim }] },
  ]);
  setMindScope(setup.client.doc, { folderIds: [], tagIds: [], documentIds: [older.id, newer.id] });
  await setup.client.settled();
  frames.length = 0;
  comparisons.length = 0;
  const before = { streamed: model.doStreamCalls.length, generated: model.doGenerateCalls.length };
  const result = await setup.core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: setup.mind.id,
    action: "check-against-documents",
    from: { blockId, offset: 0 },
    to: { blockId, offset: claim.length },
  });
  const owner = markedSentences(setup.client.blocks)[0]?.check;
  if (!owner) throw new Error("The time-cost Note has no checked owner.");
  const calls = {
    streamed: model.doStreamCalls.length - before.streamed,
    generated: model.doGenerateCalls.length - before.generated,
  };
  return {
    claim,
    fact,
    result,
    owner,
    older,
    newer,
    decoy,
    quotes,
    frames,
    comparisons,
    calls: { ...calls, total: calls.streamed + calls.generated },
    expectedNative,
  };
}

for (const row of CASES)
  describe(row.language, () => {
    test("a plain native fact remains three requests", async () => {
      const measured = await measure(row, "plain");
      expect(measured.result.kind).toBe("checked");
      expect(measured.owner.state).toBe("supported");
      expect(measured.owner.parts).toHaveLength(1);
      const ordinary = measured.owner.parts?.[0];
      expect(ordinary?.facet).toBeUndefined();
      expect(ordinary?.figures).toHaveLength(1);
      expect(ordinary?.figures?.[0]?.sourceInput?.citation).toMatchObject({
        documentId: measured.older.id,
        quote: measured.quotes[0],
        check: "found",
      });
      expect(measured.comparisons).toHaveLength(0);
      expect(measured.calls).toEqual({ streamed: 3, generated: 0, total: 3 });
    });

    test.each(["native-supported", "native-contradicted", "factual-supported"] as const)(
      "a contradicted time facet keeps two confirmations for %s",
      async (mode) => {
        const measured = await measure(row, mode);
        expect(measured.result.kind).toBe("checked");
        expect(measured.owner.state).toBe("contradicted");
        expect(measured.owner.parts).toHaveLength(2);
        const temporal = measured.owner.parts?.find((part) => part.facet?.kind === "time");
        const ordinary = measured.owner.parts?.find((part) => part.facet === undefined);
        expect(temporal).toMatchObject({
          span: { start: 0, end: row.qualifier.length },
          verdict: "contradicted",
          facet: {
            kind: "time",
            period: { start: "2026-10-30", end: "2026-10-30", precision: "day" },
          },
          evidence: [
            {
              documentId: measured.newer.id,
              contentHash: measured.newer.contentHash,
              quote: measured.quotes[1],
              check: "found",
            },
          ],
        });
        expect(ordinary?.verdict).toBe(measured.expectedNative);
        if (mode !== "factual-supported") {
          expect(ordinary?.figures).toHaveLength(1);
          expect(ordinary?.figures?.[0]?.result.verdict).toBe(measured.expectedNative);
          expect(ordinary?.figures?.[0]?.sourceInput?.citation).toMatchObject({
            documentId: mode === "native-contradicted" ? measured.newer.id : measured.older.id,
            quote: measured.quotes[mode === "native-contradicted" ? 1 : 0],
            check: "found",
          });
        }
        expect(
          measured.owner.versions.some((version) => version.documentId === measured.decoy.id),
        ).toBe(false);
        expect(measured.frames.map((call) => call.results.map((result) => result.tool))).toEqual([
          [],
          ["search_documents"],
          ["search_documents", "cite"],
        ]);
        for (const call of measured.comparisons) {
          expect(call.prompt).toContain(`<sentence>\n${measured.claim}\n</sentence>`);
          expect(call.prompt).toContain(measured.quotes[1]);
          expect(call.prompt).not.toContain(measured.quotes[0]);
          expect(call.prompt).not.toContain(row.decoy);
        }
        expect(measured.comparisons).toHaveLength(2);
        expect(measured.calls).toEqual({ streamed: 3, generated: 2, total: 5 });
      },
    );
  });
