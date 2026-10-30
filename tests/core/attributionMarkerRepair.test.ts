import { describe, expect, test } from "vitest";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    name: "2023 Annual Report",
    qualifier: "According to the 2023 Annual Report",
    claim: "According to the 2023 Annual Report, revenue for 2023 was GBP 12 million.",
    fact: "revenue for 2023 was GBP 12 million.",
    quote: "Revenue for 2023 was GBP 12 million.",
    identity: "This is the 2023 Annual Report.",
  },
  {
    language: "zh-CN",
    name: "2023年年度报告",
    qualifier: "根据2023年年度报告",
    claim: "根据2023年年度报告，2023年的收入为1200万英镑。",
    fact: "2023年的收入为1200万英镑。",
    quote: "2023年的收入为1200万英镑。",
    identity: "这是2023年年度报告。",
  },
] as const;

type Mode = "recover" | "distinct" | "cited" | "malformed" | "unfound" | "rejected" | "failed";

async function check(row: (typeof CASES)[number], mode: Mode) {
  const frames: ModelCall[] = [];
  const repairs: GenerateCall[] = [];
  const model = scriptedModel(
    (call) => {
      frames.push(call);
      const searched = call.results.find((result) => result.tool === "search_documents");
      if (!searched)
        return {
          text: `Parts: ${JSON.stringify([
            { kind: "fact", text: row.qualifier, facet: { kind: "source" } },
            { kind: "fact", text: row.fact },
          ])}`,
          calls: [{ tool: "search_documents", input: { query: row.quote } }],
        };
      if (
        (mode === "cited" || mode === "rejected") &&
        !call.results.some((result) => result.tool === "cite")
      ) {
        const passage = shownPassages(searched.text).find((each) => each.text.includes(row.quote));
        if (!passage) throw new Error("The searched Source did not contain the fixture quote.");
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  {
                    marker: 1,
                    passage: passage.id,
                    quote: mode === "rejected" ? "A quote absent from the Source." : row.quote,
                  },
                ],
              },
            },
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
          "Facets:",
          JSON.stringify({
            items: [
              {
                text: row.qualifier,
                kind: "source",
                sourceName: row.name,
                occurrence: 1,
                verdict: "supported",
                scope: "same",
                topic: "found",
                roles: "same",
                says: null,
                evidence: [mode === "distinct" ? 2 : 1],
              },
            ],
          }),
          `Citations:\n[^1] ${row.quote}`,
        ].join("\n"),
      };
    },
    {
      generate(call) {
        if (!call.system.startsWith("You checked a sentence"))
          throw new Error("The fixture was asked for an unexpected provider request.");
        repairs.push(call);
        if (mode === "failed") return { error: { status: 402, message: "Insufficient credits" } };
        if (mode === "malformed") return { text: '{"citations":[' };
        const passages = [
          ...call.prompt.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g),
        ];
        const passage = passages.find((each) => each[2]?.includes(row.quote));
        if (!passage?.[1])
          throw new Error("The repair did not receive the searched fixture quote.");
        return {
          text: JSON.stringify({
            citations: [
              {
                marker: 1,
                passage: passage[1],
                quote: mode === "unfound" ? "A quote absent from the Source." : row.quote,
              },
              ...(mode === "distinct"
                ? [{ marker: 2, passage: passage[1], quote: row.identity }]
                : []),
            ],
          }),
        };
      },
    },
  );
  const { core } = await setUpWithDocuments(model, [], {
    now: manualClock("2026-10-29T12:00:00.000Z").now,
  });
  const { settings } = await core.getLibrary();
  await core.saveLibrarySettings({ ...settings, automatic: false });
  const sources = await createTempDataFolder();
  const path = await writeSourceFile(
    sources,
    `${row.name}.md`,
    `${row.identity}\n\n${row.quote}\n`,
  );
  const documents = await addAndProcess(core, [path]);
  await core.updateSettings({ user: { language: row.language } });
  const [document] = documents;
  if (!document) throw new Error("The fixture Source was not imported.");
  expect(document.tagging).toBe("off");
  const streams = model.doStreamCalls.length;
  const generates = model.doGenerateCalls.length;
  const result = await core.checkClaim({ claim: row.claim });
  return {
    result,
    document,
    frames,
    repairs,
    streams: model.doStreamCalls.length - streams,
    generates: model.doGenerateCalls.length - generates,
  };
}

describe.each(CASES)("$language same-Run declared Citation repair", (row) => {
  test("recovers the shared quote before resolving the Source and ordinary rows", async () => {
    const { result, document, repairs, streams, generates } = await check(row, "recover");
    expect(result.parts).toHaveLength(2);
    for (const part of result.parts ?? [])
      expect(part).toMatchObject({
        verdict: "supported",
        evidence: [{ documentId: document.id, quote: row.quote, check: "found" }],
      });
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.facet?.kind).toBe("source");
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.options.maxOutputTokens).toBe(600);
    expect(repairs[0]?.prompt).toContain("Missing Citation markers: [1]");
    expect([streams, generates]).toEqual([2, 1]);
  });

  test("recovers the distinct facet and ordinary markers together with their own quotes", async () => {
    const { result, document, repairs, streams, generates } = await check(row, "distinct");
    expect(result.verdict).toBe("supported");
    expect(result.parts?.map((part) => part.evidence.map((citation) => citation.quote))).toEqual([
      [row.identity],
      [row.quote],
    ]);
    for (const part of result.parts ?? [])
      expect(part.evidence[0]).toMatchObject({ documentId: document.id, check: "found" });
    expect(repairs).toHaveLength(1);
    expect(repairs[0]?.prompt).toContain("Missing Citation markers: [1,2]");
    expect(repairs[0]?.options.maxOutputTokens).toBe(1200);
    expect([streams, generates]).toEqual([2, 1]);
  });

  test("a normally recorded quote retains three streams and no repair", async () => {
    const { result, streams, generates, repairs, frames } = await check(row, "cited");
    expect(result.verdict).toBe("supported");
    expect(result.parts?.map((part) => part.verdict)).toEqual(["supported", "supported"]);
    expect([streams, generates]).toEqual([3, 0]);
    expect(repairs).toHaveLength(0);
    expect(frames.at(-1)?.results.find((result) => result.tool === "cite")?.text).toContain(
      "Recorded [^1]",
    );
  });

  test.each(["malformed", "unfound", "rejected", "failed"] as const)(
    "%s evidence cannot become a checked Source or trigger another recovery",
    async (mode) => {
      const { result, repairs, generates } = await check(row, mode);
      expect(result.verdict).toBe("not-checked");
      expect(result.parts?.every((part) => part.verdict === "not-checked")).toBe(true);
      expect(repairs).toHaveLength(mode === "rejected" ? 0 : 1);
      expect(generates).toBe(mode === "rejected" ? 0 : 1);
      if (mode === "failed") expect(result).toMatchObject({ reason: "out-of-credit" });
    },
  );
});
