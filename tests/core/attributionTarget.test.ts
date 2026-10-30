import { expect, test } from "vitest";
import { markedSentences } from "../../src/core/answers/checks/sentences";
import { requestedFigures } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

const SPEAKERS = [
  {
    language: "en",
    claim: "Nora said the deal is off.",
    speaker: "Nora said",
    fact: "the deal is off.",
    claimed: "Nora",
    actual: "Li",
    quote: "Li said the deal is off.",
  },
  {
    language: "zh-CN",
    claim: "诺拉说交易已取消。",
    speaker: "诺拉说",
    fact: "交易已取消。",
    claimed: "诺拉",
    actual: "李",
    quote: "李说交易已取消。",
  },
] as const;

test.each(SPEAKERS)(
  "$language an ordinary contradiction comparison does not judge its sibling speaker again",
  async (row) => {
    const comparisons: GenerateCall[] = [];
    const model = scriptedModel(
      (call) => {
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search)
          return {
            text: `Parts: ${JSON.stringify([
              { kind: "speaker", text: row.speaker },
              { kind: "fact", text: row.fact },
            ])}`,
            calls: [{ tool: "search_documents", input: { query: row.quote } }],
          };
        if (!call.results.some((result) => result.tool === "cite")) {
          const passage = shownPassages(search.text).find((each) => each.text.includes(row.quote));
          if (!passage) throw new Error("The deal Source did not contain its literal quote.");
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
              },
            ],
          };
        }
        return {
          text: [
            "Verdict: contradicted",
            "Absence: no",
            "Scope: none, same",
            "Topic: found",
            "Roles: none, same",
            "Evidence: [1]",
            "Calculation: none",
            "Covered: the deal status",
            "Not covered: the named speaker",
            `Facets: ${JSON.stringify({
              items: [
                {
                  text: row.speaker,
                  kind: "speaker",
                  occurrence: 1,
                  verdict: "supported",
                  scope: "same",
                  topic: "found",
                  roles: "same",
                  says: null,
                  evidence: [1],
                  claimedSpeaker: row.claimed,
                  actualSpeaker: row.actual,
                  actualSpeakerNamed: true,
                  speakerOrigin: "quote",
                },
              ],
            })}`,
          ].join("\n"),
        };
      },
      {
        generate(call) {
          if (!call.system.startsWith("Compare a sentence"))
            throw new Error("The target fixture received an unexpected auxiliary request.");
          comparisons.push(call);
          return {
            text: call.prompt.includes(`<sentence>\n${row.fact}\n</sentence>`)
              ? "same"
              : "conflict",
          };
        },
      },
    );
    const { core } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-30T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const folder = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(folder, "Deal record.md", row.quote)]);
    await core.updateSettings({ user: { language: row.language } });
    const streams = model.doStreamCalls.length;
    const generates = model.doGenerateCalls.length;

    const result = await core.checkClaim({ claim: row.claim });

    expect(JSON.stringify(result)).not.toContain('"ordinaryTarget"');
    expect(result.verdict).toBe("unsupported");
    expect(result.parts?.find((part) => part.facet?.kind === "speaker")).toMatchObject({
      verdict: "unsupported",
      evidence: [{ quote: row.quote, check: "found" }],
    });
    expect(result.parts?.find((part) => !part.facet)?.verdict).toBe("unsupported");
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.prompt).toContain(`<sentence>\n${row.fact}\n</sentence>`);
    expect(comparisons[0]?.prompt).toContain(`<assertion>\n${row.claim}\n</assertion>`);
    expect([
      model.doStreamCalls.length - streams,
      model.doGenerateCalls.length - generates,
    ]).toEqual([3, 1]);
  },
);

const CONTROLS = [
  {
    language: "en",
    claim: "Zhang said that the deal was off.",
    qualifier: "Zhang said",
    fact: "that the deal was off.",
    quote: "Zhang said that the deal was off.",
    kind: "speaker",
    name: "Zhang",
  },
  {
    language: "zh-CN",
    claim: "张三说交易取消了。",
    qualifier: "张三说",
    fact: "交易取消了。",
    quote: "张三说交易取消了。",
    kind: "speaker",
    name: "张三",
  },
  {
    language: "en",
    claim: "Currently the base rate is 5%.",
    qualifier: "Currently",
    fact: "the base rate is 5%.",
    quote: "In March 2026, the base rate is 5%.",
    kind: "time",
    name: "",
  },
  {
    language: "zh-CN",
    claim: "目前基准利率为5%。",
    qualifier: "目前",
    fact: "基准利率为5%。",
    quote: "2026年3月，基准利率为5%。",
    kind: "time",
    name: "",
  },
] as const;

for (const row of CONTROLS) {
  const modes =
    row.kind === "speaker" ? ["valid", "invalid-cue"] : ["valid", "unsupported", "stale"];
  test.each(modes)(
    `${row.language} ${row.claim} keeps its %s facet's own judgment`,
    async (mode) => {
      const frames: ModelCall[] = [];
      const quote = mode === "stale" ? row.quote.replace("2026", "2023") : row.quote;
      const model = scriptedModel((call) => {
        frames.push(call);
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search)
          return {
            text: `Parts: ${JSON.stringify([
              { kind: row.kind, text: row.qualifier },
              { kind: "fact", text: row.fact },
            ])}`,
            calls: [{ tool: "search_documents", input: { query: quote } }],
          };
        if (!call.results.some((result) => result.tool === "cite")) {
          const passage = shownPassages(search.text).find((each) => each.text.includes(quote));
          if (!passage) throw new Error("The control Source did not contain its literal quote.");
          return {
            calls: [
              { tool: "cite", input: { citations: [{ marker: 1, passage: passage.id, quote }] } },
            ],
          };
        }
        return {
          text: [
            "Verdict: supported",
            "Absence: no",
            "Scope: none, same",
            "Topic: found",
            "Roles: none, same",
            "Evidence: [1]",
            "Calculation: none",
            `Facets: ${JSON.stringify({
              items: [
                {
                  text: row.qualifier,
                  kind: row.kind,
                  occurrence: 1,
                  verdict: mode === "unsupported" ? "unsupported" : "supported",
                  scope: "same",
                  topic: "found",
                  roles: "same",
                  says: null,
                  evidence: [1],
                  ...(row.kind === "speaker"
                    ? {
                        claimedSpeaker: row.name,
                        actualSpeaker: row.name,
                        actualSpeakerNamed: true,
                        speakerOrigin: mode === "invalid-cue" ? "cue" : "quote",
                      }
                    : {
                        time: "present",
                        period: {
                          start: `${mode === "stale" ? "2023" : "2026"}-03-01`,
                          end: `${mode === "stale" ? "2023" : "2026"}-03-31`,
                          precision: "month",
                        },
                      }),
                },
              ],
            })}`,
          ].join("\n"),
        };
      });
      const { core } = await setUpWithDocuments(model, [], {
        now: manualClock("2026-10-30T12:00:00.000Z").now,
      });
      const { settings } = await core.getLibrary();
      await core.saveLibrarySettings({ ...settings, automatic: false });
      const folder = await createTempDataFolder();
      await addAndProcess(core, [await writeSourceFile(folder, "Control record.md", quote)]);
      await core.updateSettings({ user: { language: row.language } });
      const streams = model.doStreamCalls.length;
      const generates = model.doGenerateCalls.length;

      const result = await core.checkClaim({ claim: row.claim });

      const expected =
        mode === "valid" ? "supported" : mode === "invalid-cue" ? "not-checked" : "unsupported";
      expect(result.verdict).toBe(expected);
      expect(result.parts?.find((part) => part.facet)?.verdict).toBe(expected);
      expect(result.parts?.find((part) => !part.facet)).toMatchObject({
        verdict: "supported",
        evidence: [{ quote, check: "found" }],
      });
      expect([
        model.doStreamCalls.length - streams,
        model.doGenerateCalls.length - generates,
      ]).toEqual([3, 0]);
      expect(frames.at(-1)?.system).toContain("ordinary literal target");
      if (row.kind === "speaker")
        expect(frames.at(-1)?.system).toContain("Document prose is not a cue");
    },
  );
}

test.each([
  {
    language: "en",
    qualifier: "According to Agreement",
    fact: "the Company pays the Employee rent of 950 per month.",
    claim: "According to Agreement, the Company pays the Employee rent of 950 per month.",
    quote: "The Employee pays the Company rent of 950 per month.",
    name: "Agreement",
    number: "950",
  },
  {
    language: "zh-CN",
    qualifier: "据劳动合同",
    fact: "甲方每月向乙方支付租金1500元。",
    claim: "据劳动合同，甲方每月向乙方支付租金1500元。",
    quote: "乙方每月向甲方支付租金1500元。",
    name: "劳动合同",
    number: "1500元",
  },
] as const)(
  "$language native strict comparisons keep the exact ordinary owner on first and cached checks",
  async (row) => {
    const frames: ModelCall[] = [];
    const comparisons: GenerateCall[] = [];
    const ids = new Set<string>();
    const model = scriptedModel(
      (call) => {
        frames.push(call);
        const search = call.results.find((result) => result.tool === "search_documents");
        if (!search)
          return {
            text: `Parts: ${JSON.stringify([
              { kind: "source", text: row.qualifier },
              { kind: "fact", text: row.fact },
            ])}`,
            calls: [{ tool: "search_documents", input: { query: row.quote } }],
          };
        if (!call.results.some((result) => result.tool === "cite")) {
          const passage = shownPassages(search.text).find((each) => each.text.includes(row.quote));
          if (!passage) throw new Error("The rent Source did not contain its literal quote.");
          return {
            calls: [
              {
                tool: "cite",
                input: { citations: [{ marker: 1, passage: passage.id, quote: row.quote }] },
              },
            ],
          };
        }
        const figures = requestedFigures(call);
        for (const figure of figures) ids.add(figure.id);
        return {
          text: [
            "Verdict: contradicted",
            "Absence: no",
            "Scope: none, same",
            "Topic: found",
            "Roles: none, same",
            "Evidence: [1]",
            "Calculation: none",
            `Figures: ${JSON.stringify({ items: figures.map((figure) => ({ id: figure.id, reading: figure.reading, verdict: "contradicted", scope: "same", topic: "found", roles: "differs", says: null, relation: "equals", source: { citation: 1, number: row.number }, calculation: null })), remainder: null })}`,
            `Facets: ${JSON.stringify({ items: [{ text: row.qualifier, kind: "source", sourceName: row.name, occurrence: 1, verdict: "supported", scope: "same", topic: "found", roles: "same", says: null, evidence: [1] }] })}`,
          ].join("\n"),
        };
      },
      {
        generate(call) {
          if (!call.system.startsWith("Compare a sentence"))
            throw new Error("The rent fixture received an unexpected auxiliary request.");
          comparisons.push(call);
          return { text: "conflict" };
        },
      },
    );
    const { core, client, mind } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-30T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const folder = await createTempDataFolder();
    await addAndProcess(core, [await writeSourceFile(folder, `${row.name}.md`, row.quote)]);
    await core.updateSettings({ user: { language: row.language } });
    const blockId = "native-ordinary-owner";
    writeMind(client, [
      { type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: row.claim }] },
    ]);
    await client.settled();
    for (const cached of [false, true]) {
      const before = {
        streams: model.doStreamCalls.length,
        generates: model.doGenerateCalls.length,
        comparisons: comparisons.length,
        frames: frames.length,
      };
      await core.checkSentences({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        action: "check-against-documents",
        from: { blockId, offset: 0 },
        to: { blockId, offset: row.claim.length },
      });
      await client.settled();
      const owner = markedSentences(client.blocks)[0]?.check;
      expect(JSON.stringify(owner)).not.toContain('"ordinaryTarget"');
      expect(owner?.state).toBe("contradicted");
      expect(owner?.parts?.find((part) => part.facet)?.verdict).toBe("supported");
      expect(owner?.parts?.find((part) => !part.facet)?.verdict).toBe("contradicted");
      expect(ids.size).toBe(1);
      const strict = comparisons.slice(before.comparisons);
      expect(strict).toHaveLength(2);
      for (const call of strict) {
        expect(call.prompt).toContain(`<sentence>\n${row.fact}\n</sentence>`);
        expect(call.prompt).toContain(`<assertion>\n${row.claim}\n</assertion>`);
        expect(call.prompt).toContain(row.quote);
      }
      expect([
        model.doStreamCalls.length - before.streams,
        model.doGenerateCalls.length - before.generates,
      ]).toEqual([3, 2]);
      if (cached)
        expect(frames[before.frames]?.prompt).toContain(
          `"span":{"start":${row.claim.indexOf(row.fact)},"end":${row.claim.length}}`,
        );
    }
  },
);
