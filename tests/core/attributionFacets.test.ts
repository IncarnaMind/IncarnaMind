import { describe, expect, test } from "vitest";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    kind: "source",
    qualifier: "According to Residents",
    claim: "According to Residents, Nora lives in Oslo.",
    fact: "Nora lives in Oslo.",
    source: "Residents.md",
    sourceName: "Residents",
    quote: "Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    kind: "source",
    qualifier: "据居民记录",
    claim: "据居民记录，诺拉住在奥斯陆。",
    fact: "诺拉住在奥斯陆。",
    source: "居民记录.md",
    sourceName: "居民记录",
    quote: "诺拉住在奥斯陆。",
  },
  {
    language: "en",
    kind: "speaker",
    qualifier: "Nora said",
    claim: "Nora said the branch is open.",
    fact: "the branch is open.",
    source: "Call transcript.txt",
    quote: "Nora: the branch is open.",
  },
  {
    language: "zh-CN",
    kind: "speaker",
    qualifier: "诺拉说",
    claim: "诺拉说分行已营业。",
    fact: "分行已营业。",
    source: "通话文字稿.txt",
    quote: "诺拉：分行已营业。",
  },
] as const;

describe.each(["valid", "missing"] as const)("Same-Run attribution: %s facet result", (mode) => {
  test.each(CASES)("$language $kind retains exact rows without another request", async (row) => {
    const frames: ModelCall[] = [];
    const plans = [
      { kind: "fact", text: row.qualifier, facet: { kind: row.kind } },
      { kind: "fact", text: row.fact },
    ];
    const model = scriptedModel((call) => {
      frames.push(call);
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return {
          text: `Parts: ${JSON.stringify(plans)}`,
          calls: [{ tool: "search_documents", input: { query: row.fact } }],
        };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searched.text).find((each) => each.text.includes(row.quote));
        if (!passage) throw new Error("The check did not find the exact attribution quote.");
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
          "Verdict: supported",
          "Scope: none, same",
          "Topic: found",
          "Absence: no",
          "Roles: none, same",
          "Calculation: none",
          "Evidence: [1]",
          `${row.quote} [^1]`,
          ...(mode === "valid"
            ? [
                `Facets: ${JSON.stringify({
                  items: [
                    {
                      text: row.qualifier,
                      kind: row.kind,
                      ...(row.kind === "source" && { sourceName: row.sourceName }),
                      ...(row.kind === "speaker" && {
                        claimedSpeaker: row.language === "en" ? "Nora" : "诺拉",
                        actualSpeaker: row.language === "en" ? "Nora" : "诺拉",
                        actualSpeakerNamed: true,
                        speakerOrigin: "quote",
                      }),
                      occurrence: 1,
                      verdict: "supported",
                      scope: "same",
                      topic: "found",
                      roles: "same",
                      says: row.quote,
                      evidence: [1],
                    },
                  ],
                })}`,
              ]
            : []),
        ].join("\n"),
      };
    });
    const { core } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-29T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const sources = await createTempDataFolder();
    const path = await writeSourceFile(sources, row.source, `${row.quote}\n`);
    const [document] = await addAndProcess(core, [path]);
    if (!document) throw new Error("The attribution Source was not imported.");
    await core.updateSettings({ user: { language: row.language } });
    const before = model.doStreamCalls.length + model.doGenerateCalls.length;
    const frameStart = frames.length;

    const result = await core.checkClaim({ claim: row.claim });

    expect(result.verdict).toBe(mode === "valid" ? "supported" : "not-checked");
    expect(result.parts).toHaveLength(2);
    expect(result.parts?.[0]).toMatchObject({
      span: { start: 0, end: row.qualifier.length },
      kind: "fact",
      facet: { kind: row.kind },
      verdict: mode === "valid" ? "supported" : "not-checked",
      ...(mode === "valid" && {
        evidence: [{ documentId: document.id, quote: row.quote, check: "found" }],
      }),
    });
    expect(result.parts?.[1]).toMatchObject({
      span: { start: row.claim.indexOf(row.fact), end: row.claim.length },
      kind: "fact",
      verdict: "supported",
      evidence: [{ documentId: document.id, quote: row.quote, check: "found" }],
    });
    expect(model.doStreamCalls.length + model.doGenerateCalls.length - before).toBe(3);
    expect(frames.slice(frameStart)).toHaveLength(3);
    for (const frame of frames.slice(frameStart)) expect(frame.prompt).toContain(row.claim);
  });
});
