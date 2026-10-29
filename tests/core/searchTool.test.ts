import { describe, expect, test } from "vitest";
import type { Reranker } from "../../src/core";
import {
  centroidWindows,
  clusterByOverlap,
  documentWindows,
  ONE_SEARCH_PARAMETERS,
  SEARCH_TOOL_PARAMETERS,
  type SearchToolParameters,
  type SearchToolSources,
  searchDocumentsTool,
  topsOfEach,
  type WindowedHit,
} from "../../src/core/documents/searchTool";
import {
  askAndFinish,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
  unaskedModel,
} from "../helpers/citations";

/** A hit on the Passage at `position`, whose window range is the window of 3 ending at it. */
const hit = (position: number, score = 1): WindowedHit & { position: number } => ({
  position,
  windowFrom: Math.max(0, position - 2),
  windowTo: position,
  score,
});

/**
 * A long, repetitive logbook: every one of `count` long sections ends with
 * the same sentence about the lighthouse keeper, so each of its Passages is
 * a weaker match than one short note about the keeper.
 */
function logbook(count: number, book: number): string {
  return Array.from({ length: count }, (_, index) => {
    const day = index + 1;
    const filler = Array.from(
      { length: 18 },
      (_, line) => `Book ${book} day ${day} entry ${line} notes the ordinary coastal weather.`,
    ).join(" ");
    return `## Day ${day}\n\n${filler} The lighthouse keeper walked the shore.`;
  }).join("\n\n");
}

/** A Markdown Document of `count` long sections, the word "lighthouse" only in `marked`. */
function sections(count: number, marked: number, topic: string): string {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const special = number === marked ? ` The ${topic} lighthouse stands here.` : "";
    const filler = Array.from(
      { length: 18 },
      (_, line) => `Section ${number} sentence ${line} talks about ordinary coastal weather.`,
    ).join(" ");
    return `## Section ${number}\n\n${filler}${special}`;
  }).join("\n\n");
}

describe("The sliding-window clustering", () => {
  test("hits whose window ranges intersect, directly or through others, are one cluster, whatever their order", () => {
    const hits = [hit(20), hit(4), hit(11), hit(5), hit(13), hit(30)];

    const clusters = clusterByOverlap(hits).map((cluster) =>
      cluster.map((each) => (each as ReturnType<typeof hit>).position),
    );

    // 4 and 5 overlap; 11 and 13 overlap (windows 9–11 and 11–13); 20 and 30 are alone.
    expect(clusters).toEqual([[4, 5], [11, 13], [20], [30]]);
    expect(clusterByOverlap([...hits].reverse())).toEqual(clusterByOverlap(hits));
  });

  test("a cluster's centroid is the window that takes in most of it, so a hit comes with its neighbours", () => {
    // One hit at Passage 10 (windows 8–10): window 9, Passages 9 to 11, in the middle.
    expect(centroidWindows([hit(10)]).map((window) => window.window)).toEqual([9]);
    // Hits at 10 and 11 share windows 9 and 10; window 9 holds 9, 10 and 11.
    const pair = centroidWindows([hit(10), hit(11)]);
    expect(pair).toHaveLength(1);
    expect(pair[0]?.hits).toHaveLength(2);
    // A chain 10, 12, 14 can't fit one window of 3: the better match first, then 14 in the middle of its own.
    const chain = centroidWindows([hit(10, 3), hit(12, 1), hit(14, 1)]);
    expect(chain.map((window) => window.window)).toEqual([10, 13]);
    expect(chain.map((window) => window.hits.length)).toEqual([2, 1]);
  });

  test("a Document's windows come best first: by their best hit, then by the summed scores of the hits they take in", () => {
    const windows = documentWindows([hit(3, 0.2), hit(40, 0.5), hit(41, 0.4)]);

    expect(windows.map((window) => window.window)).toEqual([39, 2]);
    expect(windows[0]?.score).toBeCloseTo(0.9);
    expect(windows[0]?.best).toBeCloseTo(0.5);
    // Three weaker hits together don't outrank one better hit.
    const crowded = documentWindows([hit(3, 0.5), hit(40, 0.3), hit(41, 0.3), hit(42, 0.3)]);
    expect(crowded.map((window) => [window.window, window.hits.length])).toEqual([
      [2, 1],
      [40, 3],
    ]);
    // With the same best hit, the window that takes in more comes first.
    expect(documentWindows([hit(3, 0.5), hit(40, 0.5), hit(41, 0.3)])[0]?.window).toBe(39);
  });
});

describe("The document-search Tool", { timeout: 30_000 }, () => {
  test("returns the Passages around the best match, from the best Document first, in reading order", async () => {
    let shown: ShownPassage[] = [];
    const model = citingModel({
      query: "lighthouse",
      records: (passages) => {
        shown = passages;
        return [];
      },
      answer: "There is a lighthouse.",
    });
    const { core, client, mind } = await setUpWithDocuments(model, [
      { name: "Coast.md", contents: sections(24, 12, "red") },
      { name: "Weather.md", contents: sections(6, 0, "") },
    ]);
    const all = (await core.searchPassages("weather", { mode: "keyword", limit: 200 })).filter(
      (passage) => passage.documentName === "Coast",
    );
    // The model sees where each new section starts, e.g. "[§ Section 3]" (ADR-0011).
    const unmarked = (text: string) => text.replace(/\n\n\[(?:§[^\]\n]*|p\. \d+)\] /g, "\n\n");
    const positionOf = (text: string) =>
      all.find((passage) => passage.text === unmarked(text))?.position;

    await askAndFinish(core, client, mind.id, "Where is the lighthouse?");

    expect(shown.length).toBeLessThanOrEqual(SEARCH_TOOL_PARAMETERS.maxPassages);
    expect(shown[0]?.document).toBe("Coast");
    const fromCoast = shown.filter((passage) => passage.document === "Coast");
    // Coast's Passages come first, together, in reading order.
    expect(shown.slice(0, fromCoast.length)).toEqual(fromCoast);
    const positions = fromCoast.map((passage) => positionOf(passage.text) as number);
    expect(positions.every((position) => position !== undefined)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The Passage with the match is there with its neighbours: a whole window of 3 around it.
    const match = fromCoast.findIndex((passage) => passage.text.includes("red lighthouse"));
    expect(match).toBeGreaterThanOrEqual(0);
    const at = positions[match] as number;
    const windowStarts = [at - 2, at - 1, at].filter((start) =>
      [start, start + 1, start + 2].every((position) => positions.includes(position)),
    );
    expect(windowStarts.length).toBeGreaterThan(0);
    // Every Passage has a short id to cite it by.
    expect(new Set(shown.map((passage) => passage.id)).size).toBe(shown.length);
    expect(shown.every((passage) => /^P\d+$/.test(passage.id))).toBe(true);
  });

  test("a short Document with the best match comes first, before long, repetitive ones whose weaker matches add up", async () => {
    let shown: ShownPassage[] = [];
    const model = citingModel({
      query: "lighthouse keeper",
      records: (passages) => {
        shown = passages;
        return [];
      },
      answer: "The keeper lit it.",
    });
    const { core, client, mind } = await setUpWithDocuments(
      model,
      [
        { name: "Log 1.md", contents: logbook(30, 1) },
        { name: "Log 2.md", contents: logbook(30, 2) },
        {
          name: "Keeper.md",
          contents: "The lighthouse keeper lit the lamp at dusk, and kept it burning all night.",
        },
      ],
      {},
      { embeddings: true },
    );
    // This is about grouping by fused scores: no reranker (the default one is on).
    await core.removeRerankSettings();
    // The note's Passage is the best match, by keyword and by vector search alike.
    for (const mode of ["keyword", "vector"] as const) {
      const [best] = await core.searchPassages("lighthouse keeper", { mode });
      expect(best?.documentName).toBe("Keeper");
    }

    await askAndFinish(core, client, mind.id, "Who lit the lighthouse lamp?");

    // Summed, the logbooks' windows of three weaker hits each came first, and
    // filled the 8 Passages: the note wasn't shown at all.
    expect(shown[0]?.document).toBe("Keeper");
    expect(shown.length).toBeLessThanOrEqual(SEARCH_TOOL_PARAMETERS.maxPassages);
    expect(new Set(shown.map((passage) => passage.document))).toEqual(
      new Set(["Keeper", "Log 1", "Log 2"]),
    );
  });

  test("a reranker plugged into the core reorders the hits before they are grouped", async () => {
    const reranked: string[] = [];
    const reranker: Reranker = async (query, candidates) => {
      reranked.push(query);
      // A reranker that prefers the weather notes, whatever the search found.
      return candidates
        .map((candidate) => ({
          ...candidate,
          score: candidate.documentName === "Weather" ? 1 + candidate.score : candidate.score,
        }))
        .sort((a, b) => b.score - a.score);
    };
    const { core } = await setUpWithDocuments(
      unaskedModel(),
      [
        { name: "Coast.md", contents: sections(24, 12, "red") },
        { name: "Weather.md", contents: sections(6, 0, "") },
      ],
      { reranker },
      // Vector search hands the reranker the weather notes, which have no "lighthouse".
      { embeddings: true },
    );

    const found = await core.searchEvidence("lighthouse");

    expect(reranked).toEqual(["lighthouse"]);
    expect(found.passages[0]?.documentName).toBe("Weather");
  });

  test("with a reranker, it sees keyword search's top 10 and vector search's top 10, not the fused list", async () => {
    const asked: string[] = [];
    const reranked: string[][] = [];
    const candidate = (index: number) => ({
      seq: index,
      passageId: `p${index}`,
      documentId: `d${index}`,
      documentName: `Document ${index}`,
      documentKind: "markdown" as const,
      contentHash: "hash",
      pageFrom: 1,
      pageTo: 1,
      position: 0,
      windowFrom: 0,
      windowTo: 0,
      text: `Passage ${index}`,
      score: 1 / (60 + index + 1),
    });
    const sources: SearchToolSources = {
      candidates: async (_query, limit) => {
        asked.push(`fused ${limit}`);
        return Array.from({ length: limit }, (_, index) => candidate(index));
      },
      rerankCandidates: async (_query, { perList, keywordAlone }) => {
        asked.push(`each list's ${perList}, or keyword search's ${keywordAlone} alone`);
        return [3, 7, 40].map(candidate);
      },
      window: () => [],
    };
    const reranker: Reranker = async (_query, candidates) => {
      reranked.push(candidates.map((each) => each.passageId));
      return [...candidates].reverse();
    };

    await searchDocumentsTool(sources, "lighthouse");
    await searchDocumentsTool(sources, "lighthouse", { rerank: reranker });

    expect(SEARCH_TOOL_PARAMETERS.rerankPerList).toBe(10);
    expect(SEARCH_TOOL_PARAMETERS.keywordRerankCandidates).toBe(20);
    expect(asked).toEqual([
      `fused ${SEARCH_TOOL_PARAMETERS.candidates}`,
      "each list's 10, or keyword search's 20 alone",
    ]);
    expect(reranked).toEqual([["p3", "p7", "p40"]]);
  });

  test("hands the model at most 8 Passages, and a one-search Answer 12, from up to 4 Documents, in windows of 3", async () => {
    const passage = (documentId: string, position: number, score = 0) => ({
      seq: position,
      passageId: `${documentId}-${position}`,
      documentId,
      documentName: documentId,
      documentKind: "markdown" as const,
      contentHash: "hash",
      pageFrom: 1,
      pageTo: 1,
      position,
      windowFrom: position,
      windowTo: position,
      text: `Passage ${position}`,
      score,
    });
    const documents = ["d1", "d2", "d3", "d4", "d5"];
    const sources = (hitsPerDocument: number[]): SearchToolSources => ({
      candidates: async () => [],
      rerankCandidates: async () =>
        documents.flatMap((documentId, document) =>
          hitsPerDocument.map((position, hit) =>
            passage(documentId, position, 1 - document * 0.1 - hit * 0.01),
          ),
        ),
      window: (documentId, window) =>
        [window, window + 1, window + 2].map((position) => passage(documentId, position)),
    });
    const handed = async (hitsPerDocument: number[], parameters?: Partial<SearchToolParameters>) =>
      searchDocumentsTool(sources(hitsPerDocument), "lighthouse", {
        rerank: async (_query, candidates) => [...candidates],
        parameters,
      });
    const perDocument = (found: Awaited<ReturnType<typeof handed>>) =>
      Object.entries(Object.groupBy(found, (each) => each.documentId)).map(
        ([documentId, passages]) => [documentId, passages?.length],
      );

    expect(SEARCH_TOOL_PARAMETERS).toMatchObject({
      keywordRerankCandidates: 20,
      maxPassages: 8,
      maxWindowsPerDocument: 2,
      maxDocuments: 4,
    });
    expect(ONE_SEARCH_PARAMETERS).toEqual({ maxPassages: 12, maxWindowsPerDocument: 3 });
    expect(perDocument(await handed([0, 10, 20, 30]))).toEqual([
      ["d1", 6],
      ["d2", 2],
    ]);
    expect(perDocument(await handed([0, 10, 20, 30], ONE_SEARCH_PARAMETERS))).toEqual([
      ["d1", 9],
      ["d2", 3],
    ]);
    const one = await handed([0], ONE_SEARCH_PARAMETERS);
    expect(new Set(one.map((each) => each.documentId))).toEqual(new Set(["d1", "d2", "d3", "d4"]));
    expect(one).toHaveLength(12);
  });

  test("says how relevant the reranker found each hit, and nothing when it kept search's own scores", async () => {
    const passage = (index: number, score = 0) => ({
      seq: index,
      passageId: `p${index}`,
      documentId: `d${index}`,
      documentName: `Document ${index}`,
      documentKind: "markdown" as const,
      contentHash: "hash",
      pageFrom: 1,
      pageTo: 1,
      position: 0,
      windowFrom: 0,
      windowTo: 0,
      text: `Passage ${index}`,
      score,
    });
    const sources: SearchToolSources = {
      candidates: async () => [],
      rerankCandidates: async () => [passage(1, 1 / 61), passage(2, 1 / 62)],
      window: (documentId) => [passage(Number(documentId.slice(1)))],
    };
    const scoring: Reranker = async (_query, candidates) =>
      candidates.map((each) => ({ ...each, score: each.passageId === "p2" ? 0.9 : 0.1 }));
    // A reranker whose model isn't there yet gives search's order and scores back.
    const notReady: Reranker = async (_query, candidates) => [...candidates];

    const reranked = await searchDocumentsTool(sources, "lighthouse", { rerank: scoring });
    const kept = await searchDocumentsTool(sources, "lighthouse", { rerank: notReady });

    expect(reranked.map((each) => [each.passageId, each.relevance])).toEqual([
      ["p2", 0.9],
      ["p1", 0.1],
    ]);
    expect(kept.map((each) => each.relevance)).toEqual([undefined, undefined]);
  });
});

describe("The search Tool's ranks", () => {
  test("rank the Passages it returns, in reading order, by window, best first, and in a window its hits first", async () => {
    /** Passage `position` of one Document, in the windows of 3 ending at it. */
    const passage = (position: number, score = 0) => ({
      seq: position,
      passageId: `p${position}`,
      documentId: "logbook",
      documentName: "Logbook",
      documentKind: "pdf" as const,
      contentHash: "hash",
      pageFrom: position + 1,
      pageTo: position + 1,
      position,
      windowFrom: Math.max(0, position - 2),
      windowTo: position,
      text: `Passage ${position}`,
      score,
    });
    const sources: SearchToolSources = {
      // The best match is late in the Document, a weaker one early.
      candidates: async () => [passage(7, 0.9), passage(2, 0.5)],
      rerankCandidates: async () => [],
      window: (_documentId, window) =>
        [window, window + 1, window + 2].map((each) => passage(each)),
    };

    const found = await searchDocumentsTool(sources, "the keeper");

    // In reading order, the weaker window first; ranked by relevance, the best match first.
    expect(found.map((each) => [each.position, each.rank])).toEqual([
      [1, 4],
      [2, 3],
      [3, 5],
      [6, 1],
      [7, 0],
      [8, 2],
    ]);
  });
});

describe("The candidates a reranker sees, through the core", { timeout: 30_000 }, () => {
  /** Two Documents, and a reranker that records what it was handed, in the order given. */
  async function setUp(options: { embeddings?: boolean; coastSections?: number } = {}) {
    const seen: { passageId: string; score: number }[][] = [];
    const reranker: Reranker = async (_query, candidates) => {
      seen.push(candidates.map(({ passageId, score }) => ({ passageId, score })));
      return [...candidates];
    };
    const setup = await setUpWithDocuments(
      unaskedModel(),
      [
        { name: "Coast.md", contents: sections(options.coastSections ?? 24, 12, "red") },
        { name: "Weather.md", contents: sections(6, 0, "") },
      ],
      { reranker },
      { embeddings: options.embeddings },
    );
    return { ...setup, seen };
  }

  test("with embeddings off, the default, are keyword search's top 20, in its order", async () => {
    const query = "ordinary coastal weather lighthouse";
    // Enough Passages for more than 20 to match.
    const { core, seen } = await setUp({ coastSections: 70 });

    await core.searchEvidence(query);

    const keyword = await core.searchPassages(query, { mode: "keyword", limit: 20 });
    expect(keyword).toHaveLength(20);
    expect(await core.searchPassages(query, { mode: "keyword", limit: 21 })).toHaveLength(21);
    expect(seen).toHaveLength(1);
    expect((seen[0] ?? []).map((each) => each.passageId)).toEqual(
      keyword.map((passage) => passage.passageId),
    );
    // Hybrid search is keyword search, and vector search is refused: nothing is embedded.
    expect(await core.searchPassages(query, { limit: 20 })).toEqual(keyword);
    await expect(core.searchPassages(query, { mode: "vector" })).rejects.toThrow(
      /Search by meaning is off/,
    );
  });

  test("with embeddings on, are keyword search's top 10 and vector search's top 10, as searchPassages gives them, in fused order", async () => {
    const query = "ordinary coastal weather lighthouse";
    const { core, seen } = await setUp({ embeddings: true });

    await core.searchEvidence(query);

    const keyword = await core.searchPassages(query, { mode: "keyword", limit: 10 });
    const vector = await core.searchPassages(query, { mode: "vector", limit: 10 });
    expect(keyword).toHaveLength(10);
    expect(vector).toHaveLength(10);
    const union = new Set([...keyword, ...vector].map((passage) => passage.passageId));
    const candidates = seen[0] ?? [];
    expect(new Set(candidates.map((each) => each.passageId))).toEqual(union);
    expect(candidates).toHaveLength(union.size);
    // In fused order, so a reranker that fails leaves search's own order.
    const scores = candidates.map((each) => each.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe("The candidates a reranker sees", () => {
  test("each list's best few, once each, in the order they first appear", () => {
    const keyword = ["a", "b", "c", "d", "e"];
    const vector = ["c", "x", "a", "y", "z"];

    expect(topsOfEach([keyword, vector], 3)).toEqual(["a", "b", "c", "x"]);
    expect(topsOfEach([keyword, []], 3)).toEqual(["a", "b", "c"]);
    expect(topsOfEach([[], vector], 10)).toEqual(vector);
    expect(
      topsOfEach(
        [
          [{ id: 1 }, { id: 2 }],
          [{ id: 2 }, { id: 3 }],
        ],
        2,
        (each) => each.id,
      ).map((each) => each.id),
    ).toEqual([1, 2, 3]);
  });
});
