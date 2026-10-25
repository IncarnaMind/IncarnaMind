import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { CITATION_NODE } from "../../src/core";
import { estimateTokens } from "../../src/core/answers/context";
import { skimWithin } from "../../src/core/answers/documentText";
import type { WindowedPassage } from "../../src/core/documents/search";
import { askAssistant, changesIn } from "../helpers/assistant";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/**
 * A summary of each Document reads a long one from all its parts (#894): its opening and
 * Passages spread over the rest, given up front, so a 10-K isn't summarised from whichever part a
 * search happened to return. Through the core as the assistant asks, with a scripted model.
 */

const passage = (seq: number, text: string): WindowedPassage =>
  ({
    seq,
    passageId: `p${seq}`,
    documentId: "d",
    documentName: "Filing",
    documentKind: "markdown",
    contentHash: "h",
    pageFrom: null,
    pageTo: null,
    position: seq,
    windowFrom: seq,
    windowTo: seq,
    text,
  }) as unknown as WindowedPassage;

const words = (count: number, word: string) => Array.from({ length: count }, () => word).join(" ");

describe("A long Document's skim", () => {
  // protects=a Document that fits is read whole; fails_when=part of it is left out; no_claim=none beyond protects.
  test("a short one is read whole", () => {
    const all = [passage(0, "One."), passage(1, "Two."), passage(2, "Three.")];
    expect(skimWithin(all, 1_000)).toEqual(all);
  });

  // protects=a long one is read from its opening and from across the rest, in reading order, moved to the Passages that start its parts, within its room; fails_when=it takes only the opening, or runs over its room; no_claim=how many Passages a model needs.
  test("a long one is read from its opening and every part, within its room", () => {
    const all = Array.from({ length: 40 }, (_, at) =>
      passage(
        at,
        at % 10 === 1 ? `Item ${at}. Part\n${words(90, "detail")}` : words(100, `filler${at}`),
      ),
    );
    const skim = skimWithin(all, 1_200);
    const seqs = skim.map((each) => each.seq);
    expect(seqs[0]).toBe(0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(expect.arrayContaining([11, 21, 31]));
    const tokens = skim.reduce((sum, each) => sum + estimateTokens(each.text), 0);
    expect(tokens).toBeLessThanOrEqual(1_200);
  });
});

const ITEMS = [
  "Item 1. Business",
  "Item 1A. Risk Factors",
  "Item 7. Management's Discussion and Analysis",
  "Item 8. Financial Statements",
  "Exhibit 97. Clawback Policy",
];

/** Enough words that the filing is too long to give whole. */
const CONTEXT =
  "It goes on about the stores, the suppliers, the staff and the season, at the length a filing does. ".repeat(
    6,
  );

/** A 10-K's shape: five parts of ten paragraphs, each sentence saying which part it is in. */
const FILING = [
  "# Northwind Retail plc: Annual Report on Form 10-K",
  ...ITEMS.flatMap((item, part) => [
    `## ${item}`,
    ...Array.from(
      { length: 10 },
      (_, line) =>
        `In ${item.split(".")[0]}, paragraph ${line + 1} says the group's figure ${part * 10 + line} rose over the year, as the board reported to its shareholders in detail. ${CONTEXT}`,
    ),
  ]),
].join("\n\n");

const MEMO = "# Board memo\n\nThe board approved the dividend in March.\n";

const partOf = (text: string) => /In (Item \d+A?|Exhibit \d+),/.exec(text)?.[1] ?? null;

/** Cites one Passage of each part it was given up front, then writes the summary into a new Mind. */
function summarising(calls: ModelCall[]) {
  return scriptedModel((call): ScriptedReply => {
    calls.push(call);
    if (call.results.some((each) => each.tool === "create_mind")) return { text: "Done." };
    const skims = /<document-skims>[\s\S]*?<\/document-skims>/.exec(call.prompt)?.[0] ?? "";
    const byPart = new Map<string, { id: string; quote: string }>();
    for (const shown of shownPassages(skims)) {
      const sentence = /In (?:Item \d+A?|Exhibit \d+), paragraph \d+ says[^.]*\./.exec(shown.text);
      const part = partOf(sentence?.[0] ?? "");
      if (sentence && part && !byPart.has(part)) {
        byPart.set(part, { id: shown.id, quote: sentence[0].replace(/\.$/, "") });
      }
    }
    const picked = [...byPart.values()];
    if (!call.results.some((each) => each.tool === "cite")) {
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: picked.map((each, at) => ({
                marker: at + 1,
                passage: each.id,
                quote: each.quote,
              })),
            },
          },
        ],
      };
    }
    const content = ["## Summary", ...picked.map((each, at) => `${each.quote} [^${at + 1}].`)].join(
      "\n\n",
    );
    return { calls: [{ tool: "create_mind", input: { title: "Summary", content } }] };
  });
}

describe("A summary of each Document, through the core", { timeout: 60_000 }, () => {
  // protects=asked for a summary of each Document, the model is given a long filing's opening and Passages from across its parts, so the summary cites more than one part; fails_when=nothing is given up front, or only the opening, and the summary rests on one part; no_claim=that a real model uses every part.
  test("of a 10-K and a memo, cites the 10-K's parts, not one of them", async () => {
    const folder = await mkdtemp(join(tmpdir(), "skims-"));
    const paths = await Promise.all(
      [
        ["Northwind 10-K.md", FILING],
        ["Board memo.md", MEMO],
      ].map(async ([name = "", text = ""]) => {
        const path = join(folder, name);
        await writeFile(path, text);
        return path;
      }),
    );
    const calls: ModelCall[] = [];
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, {
      createChatModel: scriptedModels(summarising(calls)).createChatModel,
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const group = await core.createLibraryGroup({ name: "Filings", description: "" });
    const added = await core.addDocuments(paths, { groupId: group.id });
    await waitForProcessing(
      core,
      added.documents.map((document) => document.id),
      30_000,
    );
    const mind = await core.createMind({ title: "Notes", folderId: group.id });

    const answer = await askAssistant(core, {
      text: "Write a summary page of these documents",
      mindId: mind.id,
      scope: { folderIds: [group.id], tagIds: [], documentIds: [] },
    });

    expect(calls[0]?.prompt).toContain("<document-skims>");
    expect(calls[0]?.prompt).toContain("Board memo");
    const made = changesIn(answer).find((change) => change.created);
    if (!made) throw new Error("No Mind was made.");
    const client = await connectToMind(core, made.mindId);
    await client.settled();
    const quotes: string[] = [];
    const visit = (element: Y.XmlElement | Y.XmlFragment) => {
      for (const child of element.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        const quote = child.getAttribute("quote");
        if (child.nodeName === CITATION_NODE && typeof quote === "string") quotes.push(quote);
        visit(child);
      }
    };
    visit(client.blocks);
    const parts = new Set(quotes.map(partOf));
    expect(parts.size).toBeGreaterThanOrEqual(3);
  });
});
