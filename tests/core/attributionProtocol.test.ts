import { describe, expect, test } from "vitest";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";

const sentences = [
  {
    language: "en",
    claim: "Nora lives in Oslo.",
    source: { name: "Residents.md", contents: "# Residents\n\nNora lives in Oslo." },
    quote: "Nora lives in Oslo.",
  },
  {
    language: "zh-CN",
    claim: "诺拉住在奥斯陆。",
    source: { name: "居民.md", contents: "# 居民\n\n诺拉住在奥斯陆。" },
    quote: "诺拉住在奥斯陆。",
  },
] as const;

describe("Plain factual assertion request protocol", () => {
  test.each(sentences)("plain fact uses three provider requests ($language)", async (row) => {
    const frames: ModelCall[] = [];
    const model = scriptedModel((call) => {
      frames.push(call);
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched) {
        return { calls: [{ tool: "search_documents", input: { query: row.claim } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searched.text).find((each) => each.text.includes(row.quote));
        if (!passage) throw new Error("The search did not show Nora's residence.");
        const citations = [{ marker: 1, passage: passage.id, quote: row.quote }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return {
        text: [
          "Verdict: supported",
          "Scope: none, same",
          "Topic: found",
          "Roles: none, same",
          "Calculation: none",
          "",
          row.language === "en" ? "Nora lives in Oslo. [^1]" : "诺拉住在奥斯陆。[^1]",
        ].join("\n"),
      };
    });
    const { core } = await setUpWithDocuments(model, [], {
      now: manualClock("2026-10-29T12:00:00.000Z").now,
    });
    const { settings } = await core.getLibrary();
    await core.saveLibrarySettings({ ...settings, automatic: false });
    const sources = await createTempDataFolder();
    const path = await writeSourceFile(sources, row.source.name, row.source.contents);
    const documents = await addAndProcess(core, [path]);
    await core.updateSettings({ user: { language: row.language } });
    const document = documents[0];
    if (!document) throw new Error("The residence Source was not imported.");
    expect(document.tagging).toBe("off");
    const streamedBefore = model.doStreamCalls.length;
    const generatedBefore = model.doGenerateCalls.length;
    const framesBefore = frames.length;

    const result = await core.checkClaim({ claim: row.claim });

    expect(result).toMatchObject({
      verdict: "supported",
      evidence: { documentId: document.id, quote: row.quote, check: "found" },
      versions: [{ documentId: document.id, contentHash: document.contentHash }],
    });
    const streams = model.doStreamCalls.length - streamedBefore;
    const generates = model.doGenerateCalls.length - generatedBefore;
    expect(streams + generates).toBe(3);
    const checked = frames.slice(framesBefore);
    expect(checked.map((call) => call.results.map((result) => result.tool))).toEqual([
      [],
      ["search_documents"],
      ["search_documents", "cite"],
    ]);
    const feedback = checked[2]?.results.find((result) => result.tool === "cite")?.text;
    expect(feedback).toContain("Recorded [^1]");
  });
});
