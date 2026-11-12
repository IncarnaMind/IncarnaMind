/**
 * The checks evaluation's pipeline (#86), run end to end through a core with
 * a scripted model in place of a real one: claims extracted from a received
 * document, each claim and each Find support sentence searched for in the
 * Folder with `searchEvidence`, checked, and scored against labels. A model
 * failure leaves a sentence "not checked", never supported. The run checks
 * with the app's claim check (`corePipeline`), which the baseline's tests
 * stand beside.
 */
import { describe, expect, test } from "vitest";
import { baselinePipeline, corePipeline } from "../../eval/checks/lib/pipeline";
import {
  type ExtractedClaim,
  type SentenceResult,
  scoreFindSupport,
  scoreVerify,
} from "../../eval/checks/lib/scoring";
import type { CheckLabel, FindSupportItem, VerifyItem } from "../../eval/checks/lib/set";
import type { Generate } from "../../eval/lib/rewrites";
import type { PassageSearchResult } from "../../src/core";
import { checkingModel } from "../helpers/checks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { scriptedModels } from "../helpers/models";

const TIDES =
  "# Tides\n\nSpring tides happen at new moon and at full moon.\n\n## Harbour\n\nThe harbour office opens on Mondays at 8am.\n";
const CHINESE = "# 潮汐\n\n大潮出现在新月和满月的时候。\n";
const NOTICE =
  "# Harbour notice\n\nSpring tides happen at new moon and at full moon. The harbour office opens on Tuesdays at 8am. The harbour has 40 moorings. Visitors pay a mooring fee of £20 a night.\n";

const EXTRACTED = [
  "Spring tides happen at new moon and at full moon.",
  "The harbour office opens on Tuesdays at 8am.",
  "The harbour has 40 moorings.",
];

const reply = (value: unknown) => ({
  text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
  inputTokens: 100,
  outputTokens: 20,
});

/** The passage the prompt lists under "[Pn]" that holds `words`, as "Pn". */
function passageWith(prompt: string, words: string): string | null {
  const listed = prompt.split(/\n(?=\[P\d+\] )/);
  const found = listed.find((part) => /^\[P\d+\] /.test(part) && part.includes(words));
  return found ? (/^\[(P\d+)\]/.exec(found)?.[1] ?? null) : null;
}

/** A model that extracts three of the notice's four claims, and checks sentences by their words. */
const scripted: Generate = async (prompt) => {
  if (prompt.startsWith("Below is a document")) {
    return reply({ claims: EXTRACTED.map((claim) => ({ claim, source: claim })) });
  }
  const sentence = /^Sentence: (.*)$/m.exec(prompt)?.[1] ?? "";
  if (sentence.includes("moorings")) throw new Error("429 Too Many Requests");
  for (const [words, evidence] of [
    ["new moon", "Spring tides happen at new moon"],
    ["新月", "大潮出现在新月"],
  ]) {
    const passage = sentence.includes(words as string)
      ? passageWith(prompt, evidence as string)
      : null;
    if (passage) return reply({ verdict: "supported", passage, quote: evidence });
  }
  const mondays = passageWith(prompt, "opens on Mondays");
  if (sentence.includes("Tuesdays") && mondays) {
    return reply({ verdict: "contradicted", passage: mondays, quote: "opens on Mondays at 8am" });
  }
  return reply({ verdict: "unsupported", passage: null, quote: null });
};

function sentence(id: string, text: string, label: CheckLabel, document: string): FindSupportItem {
  return {
    id,
    set: "find-support",
    language: document === "潮汐.md" ? "zh" : "en",
    document,
    sentence: text,
    label,
    evidence:
      label === "unsupported"
        ? null
        : {
            document,
            location: "§ Tides",
            units: [1, 1],
            quote: "Spring tides happen at new moon",
          },
    contradiction: null,
    note: null,
    confirmed: false,
  };
}

function claim(id: string, text: string, label: CheckLabel): VerifyItem {
  const at = {
    document: "Harbour notice.md",
    location: "§ Harbour notice",
    units: [1, 1] as [number, number],
  };
  return {
    id,
    set: "verify",
    language: "en",
    ...at,
    claim: text,
    label,
    evidence:
      label === "unsupported"
        ? null
        : {
            document: "Tides.md",
            location: "§ Tides",
            units: [1, 2],
            quote: "Spring tides happen",
          },
    contradiction: label === "contradicted" ? { ...at, quote: "on Tuesdays" } : null,
    note: null,
    confirmed: false,
  };
}

describe("The checks pipeline", { timeout: 60_000 }, () => {
  test("extracts, searches the Folder without the received document, checks, and is scored", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const paths = [
      await writeSourceFile(sources, "Tides.md", TIDES),
      await writeSourceFile(sources, "潮汐.md", CHINESE),
      await writeSourceFile(sources, "Harbour notice.md", NOTICE),
    ];
    const [tides, chinese, notice] = await addAndProcess(core, paths);
    if (!tides || !chinese || !notice) throw new Error("The Documents weren't added.");
    const folder = await core.createLibraryGroup({
      name: "Harbour",
      description: "Tides and the harbour.",
    });
    await core.moveToFolder({ documentIds: [tides.id, chinese.id], folderId: folder.id });
    const names = new Map([
      [tides.id, "Tides.md"],
      [chinese.id, "潮汐.md"],
      [notice.id, "Harbour notice.md"],
    ]);
    const prompts: string[] = [];
    const pipeline = baselinePipeline({
      core,
      generate: (prompt) => {
        prompts.push(prompt);
        return scripted(prompt);
      },
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      nameOf: (passage: PassageSearchResult) =>
        names.get(passage.documentId) ?? passage.documentName,
    });

    const sentences = [
      sentence("fs-1", "Spring tides come at new moon.", "supported", "Tides.md"),
      sentence("fs-2", "大潮出现在新月。", "supported", "潮汐.md"),
      sentence("fs-3", "The harbour office opens on Tuesdays.", "contradicted", "Tides.md"),
      sentence("fs-4", "The harbour has 40 moorings.", "unsupported", "Tides.md"),
      sentence("fs-5", "Neap tides come at the quarter moons.", "unsupported", "Tides.md"),
    ];
    const results: SentenceResult[] = [];
    for (const item of sentences) {
      results.push({ id: item.id, outcome: await pipeline.check(item.sentence) });
    }
    const extraction = await pipeline.extractClaims(NOTICE);
    const checked: ExtractedClaim[] = [];
    for (const each of extraction.claims) {
      checked.push({
        ...each,
        outcome: await pipeline.check(each.text, { documentIds: [notice.id] }),
      });
    }

    const findSupport = scoreFindSupport(sentences, results, () => "markdown");
    expect(findSupport.supported).toMatchObject({ precision: 1, recall: 1 });
    expect(findSupport.labelledEvidence).toEqual({ hits: 2, total: 2, share: 1 });
    expect(findSupport.misses).toMatchObject([
      { id: "fs-4", verdict: "not-checked", reason: "The model failed: 429 Too Many Requests" },
    ]);
    expect(results[2]?.outcome).toEqual({
      verdict: "contradicted",
      evidence: { document: "Tides.md", units: [1, 2], quote: "opens on Mondays at 8am" },
    });

    const verify = scoreVerify(
      [
        claim("vf-1", "Spring tides happen at new moon and at full moon.", "supported"),
        claim("vf-2", "The harbour office opens on Tuesdays at 8am.", "contradicted"),
        claim("vf-3", "The harbour has 40 moorings.", "unsupported"),
        claim("vf-4", "Visitors pay a mooring fee of £20 a night.", "unsupported"),
      ],
      [{ document: "Harbour notice.md", claims: checked, failure: extraction.failure }],
    );
    expect(verify.extracted).toEqual({ hits: 3, total: 4, share: 0.75 });
    expect(verify.contradicted).toMatchObject({ precision: 1, recall: 1 });
    expect(verify.misses.map((miss) => [miss.id, miss.verdict])).toEqual([
      ["vf-3", "not-checked"],
      ["vf-4", "not-extracted"],
    ]);

    // The notice says the same as the Folder in places, but is never evidence for its own claims.
    for (const each of checked)
      expect(each.outcome.evidence?.document).not.toBe("Harbour notice.md");
    expect(prompts.filter((prompt) => /\[P\d+\] Harbour notice/.test(prompt))).toEqual([]);
    // Two of the nine calls failed, and reported no tokens.
    expect(pipeline.usage()).toEqual({ calls: 9, inputTokens: 700, outputTokens: 140 });
  });

  test("a reply that isn't a verdict or a list of claims says so, and nothing found is unsupported", async () => {
    const passage: PassageSearchResult = {
      passageId: "p1",
      documentId: "d1",
      documentName: "Tides",
      pageFrom: 1,
      pageTo: 1,
      position: 0,
      text: "Spring tides happen at new moon.",
    };
    let found = [passage];
    let text = "I can't help with that.";
    const pipeline = baselinePipeline({
      core: { searchEvidence: async () => ({ passages: found, excluded: [] }) },
      generate: async () => ({ text, inputTokens: null, outputTokens: null }),
      scope: { folderIds: [], tagIds: [], documentIds: [] },
      nameOf: (each) => each.documentName,
    });

    expect(await pipeline.extractClaims("A notice.")).toEqual({
      claims: [],
      failure: "The model's reply held no list of claims.",
    });
    expect(await pipeline.check("Spring tides come at new moon.")).toEqual({
      verdict: "not-checked",
      reason: "The model's reply held no verdict.",
      evidence: null,
    });
    text = "  ";
    expect((await pipeline.check("Spring tides come at new moon.")).reason).toBe(
      "The model's reply was empty.",
    );
    found = [];
    expect(await pipeline.check("Spring tides come at new moon.")).toEqual({
      verdict: "unsupported",
      evidence: null,
    });
    expect(pipeline.usage().calls).toBe(3);
  });

  test("the run's pipeline checks with the app's claim check: its verdict and the Citation that decides it, the received document never its evidence", async () => {
    const plans = {
      "Spring tides come at new moon.": {
        verdict: "supported",
        quote: "Spring tides happen at new moon and at full moon.",
      },
      "The harbour office opens on Tuesdays.": {
        verdict: "contradicted",
        quote: "The harbour office opens on Mondays at 8am.",
      },
      "The harbour has 40 moorings.": { reply: { text: "I'm sorry, I can't help with that." } },
    } as const;
    const core = startCore(await createTempDataFolder(), {
      createChatModel: scriptedModels(checkingModel(plans)).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const sources = await createSourceFolder();
    const [tides, notice] = await addAndProcess(core, [
      await writeSourceFile(sources, "Tides.md", TIDES),
      await writeSourceFile(sources, "Harbour notice.md", NOTICE),
    ]);
    if (!tides || !notice) throw new Error("The Documents weren't added.");
    const folder = await core.createLibraryGroup({ name: "Harbour", description: "Tides." });
    await core.moveToFolder({ documentIds: [tides.id], folderId: folder.id });
    const names = new Map([
      [tides.id, "Tides.md"],
      [notice.id, "Harbour notice.md"],
    ]);
    const pipeline = corePipeline({
      core,
      generate: scripted,
      scope: { folderIds: [folder.id], tagIds: [], documentIds: [] },
      nameOf: (passage) => names.get(passage.documentId) ?? passage.documentName,
      citedName: (citation) => names.get(citation.documentId) ?? citation.documentName,
    });

    expect(await pipeline.check("Spring tides come at new moon.")).toMatchObject({
      verdict: "supported",
      evidence: {
        document: "Tides.md",
        quote: "Spring tides happen at new moon and at full moon.",
      },
    });
    expect(
      await pipeline.check("The harbour office opens on Tuesdays.", { documentIds: [notice.id] }),
    ).toMatchObject({
      verdict: "contradicted",
      evidence: { document: "Tides.md", quote: "The harbour office opens on Mondays at 8am." },
    });
    expect(await pipeline.check("The harbour has 40 moorings.")).toEqual({
      verdict: "not-checked",
      reason: "refused",
      code: "refused",
      evidence: null,
    });
    expect(await pipeline.check("Penguins nest on the harbour wall.")).toEqual({
      verdict: "unsupported",
      evidence: null,
    });
    // Extraction is still the baseline's one call.
    expect((await pipeline.extractClaims(NOTICE)).claims).toHaveLength(3);
    expect(pipeline.usage().calls).toBe(1);
  });
});
