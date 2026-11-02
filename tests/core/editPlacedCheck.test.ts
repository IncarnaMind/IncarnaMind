/**
 * Edit with AI's changes are checked once written (#2424), as an outside agent's are: every
 * Citation, footnote and figure a change leaves is one that was there, as it was, or one its
 * reply placed, told apart by all it holds. A writer made to add or change one refuses the
 * whole change on each of Edit with AI's paths, in English and Chinese, and the Note is as it
 * was. Honest edits, and seeded random replies, are never refused.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  type Document,
  FOOTNOTE_NODE,
} from "../../src/core";
import { createElement } from "../../src/core/answers/blocks";
import { addsOnlyPlaced, blocksOf, citingKey, splitCiting } from "../../src/core/proposals/placed";
import { layout, proposeRewrite, readSelection, setProposal } from "../../src/core/proposals/write";
import { translate } from "../../src/shared/i18n";
import { decideProposals, pendingProposals, targetHash } from "../../src/shared/proposals";
import { userNote } from "../helpers/agentChanges";
import { setUpWithDocuments } from "../helpers/citations";
import { editingModel, wholeParagraph } from "../helpers/editing";
import { readMind, writeMind } from "../helpers/minds";
import { random } from "../helpers/random";

type Drift = "add" | "alter" | "footnote";

/** What the writing below the check does of its own, as a writer that drifted would. */
const drift = vi.hoisted(() => ({ mode: null as Drift | null }));

vi.mock("../../src/core/proposals/write", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/proposals/write")>();
  return {
    ...real,
    createRewriteStream: (...args: Parameters<typeof real.createRewriteStream>) => {
      const stream = real.createRewriteStream(...args);
      const [selection, request] = args;
      let drifted = false;
      const after = (wrote: boolean) => {
        const element = selection.segments[0]?.element;
        if (wrote && !drifted && drift.mode && element) {
          drifted = true;
          driftIn(element, request, drift.mode);
        }
        return wrote;
      };
      return {
        ...stream,
        write: (text: string, done?: boolean) => after(stream.write(text, done)),
        finish: () => after(stream.finish()),
      };
    },
  };
});

const forged = {
  documentId: "tides",
  documentName: "Tides",
  passageId: "passage-1",
  quote: "The Moon is made of cheese.",
  check: "found",
};

function driftIn(paragraph: Y.XmlElement, request: string, mode: Drift): void {
  if (mode === "add") {
    const node = createElement({ type: CITATION_NODE, attrs: forged });
    setProposal(node, { id: "forged", request, target: targetHash(""), kind: "insert" });
    paragraph.insert(paragraph.length, [node]);
  }
  if (mode === "footnote") {
    const note = createElement({
      type: FOOTNOTE_NODE,
      content: [{ type: "text", text: "Source: a court ruling that never existed." }],
    });
    paragraph.insert(paragraph.length, [note]);
  }
  // In place, in the next paragraph: the User's Citation made to quote other words.
  const next = blocksOf(paragraph)
    ?.toArray()
    .find((each) => each !== paragraph);
  const theirs = (name: string) =>
    next instanceof Y.XmlElement
      ? next.toArray().find((each) => each instanceof Y.XmlElement && each.nodeName === name)
      : undefined;
  const citation = mode === "alter" ? theirs(CITATION_NODE) : undefined;
  if (citation instanceof Y.XmlElement) citation.setAttribute("quote", "EVIL");
}

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
    "",
    "Neap tides happen at the quarter moons, when the Sun and the Moon pull apart.",
  ].join("\n"),
};

const cited = (tides: Document, quote: string): JSONContent => ({
  type: CITATION_NODE,
  attrs: {
    passageId: "passage-1",
    documentId: tides.id,
    documentName: "Tides",
    contentHash: tides.contentHash,
    pageFrom: null,
    pageTo: null,
    quote,
    check: "found",
    checkReason: null,
  },
});

const WORDS = {
  en: {
    first: ["Spring tides happen at new moon and at full moon ", ". Harbours publish the times."],
    second: "Neap tides are weaker ",
    note: "At the quarter moons.",
  },
  "zh-CN": {
    first: ["大潮出现在新月和满月前后", "。港口每年都会公布潮汐时间。"],
    second: "小潮比较弱",
    note: "出现在上弦月和下弦月。",
  },
} as const;

/** What the model gives back on each of Edit with AI's paths, in each language. */
const PATHS = {
  en: {
    improve: "Spring tides come at new moon and at full moon [1]. Harbours publish the times.",
    shorten: "Spring tides come at new and full moon [1].",
    add: "Spring tides happen at new moon and at full moon [1]. Harbours publish the times.\n\nThey bring the year's highest water [1].",
    remove: "Spring tides happen at new moon and at full moon [1].",
  },
  "zh-CN": {
    improve: "大潮在新月和满月时出现[1]。港口每年公布潮汐时间。",
    shorten: "大潮在新月和满月时出现[1]。",
    add: "大潮出现在新月和满月前后[1]。港口每年都会公布潮汐时间。\n\n大潮带来一年中最高的水位[1]。",
    remove: "大潮出现在新月和满月前后[1]。",
  },
} as const;

const ACTIONS = {
  improve: { action: "improve" },
  shorten: { action: "shorten" },
  add: { action: "instruction", instruction: "Add a sentence on what spring tides bring." },
  remove: { action: "instruction", instruction: "Remove the second sentence." },
} as const;

type Language = keyof typeof WORDS;
type Path = keyof typeof ACTIONS;

/** A Note of two cited paragraphs, the second with a footnote, and Edit with AI over the first. */
async function editing(language: Language, path: Path, reply: string = PATHS[language][path]) {
  const set = await setUpWithDocuments(
    editingModel(() => reply),
    [TIDES],
  );
  const tides = set.documents[0] as Document;
  const words = WORDS[language];
  const first = {
    type: "paragraph",
    attrs: { id: "first" },
    content: [
      { type: "text", text: words.first[0] },
      cited(tides, "Spring tides happen at new moon and at full moon"),
      { type: "text", text: words.first[1] },
    ],
  };
  const second = {
    type: "paragraph",
    attrs: { id: "second" },
    content: [
      { type: "text", text: words.second },
      cited(tides, "Neap tides happen at the quarter moons"),
      { type: "text", text: "." },
      { type: FOOTNOTE_NODE, attrs: { id: "n1" }, content: [{ type: "text", text: words.note }] },
    ],
  };
  writeMind(set.client, [first, second]);
  await set.client.settled();
  const { action, ...asked } = ACTIONS[path];
  const input = wholeParagraph(
    set.client,
    set.mind.id,
    "first",
    action,
    "instruction" in asked ? asked.instruction : undefined,
  );
  return { ...set, input };
}

describe("Edit with AI's last check on what it writes (#2424)", () => {
  for (const language of ["en", "zh-CN"] as const) {
    for (const path of Object.keys(ACTIONS) as Path[]) {
      test(`refuses the whole change when the writing adds a Citation its reply didn't place: ${path} (${language})`, async () => {
        const honest = await editing(language, path);
        expect((await honest.core.editWithAi(honest.input)).kind).toBe("proposed");

        const { core, client, input } = await editing(language, path);
        const before = readMind(client).toJSON();
        drift.mode = "add";
        try {
          expect(await core.editWithAi(input)).toEqual({ kind: "not-placed" });
        } finally {
          drift.mode = null;
        }
        await client.settled();
        expect(pendingProposals(client.blocks)).toEqual([]);
        expect(readMind(client).toJSON()).toEqual(before);
      });
    }
  }

  test.each(["alter", "footnote"] as const)(
    "refuses it when the writing does %s of its own",
    async (mode) => {
      const { core, client, input } = await editing("en", "improve");
      const before = readMind(client).toJSON();
      drift.mode = mode;
      try {
        expect(await core.editWithAi(input)).toEqual({ kind: "not-placed" });
      } finally {
        drift.mode = null;
      }
      await client.settled();
      expect(pendingProposals(client.blocks)).toEqual([]);
      expect(readMind(client).toJSON()).toEqual(before);
    },
  );

  test("finds a figure changed in place, and holds one left as it was", () => {
    const { blocks } = userNote();
    const before = splitCiting(blocks, "edit-request");
    expect(addsOnlyPlaced(before, blocks, "edit-request", new Map())).toBe(true);
    const figures: Y.XmlElement[] = [];
    const visit = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === CALCULATED_FIGURE_NODE) figures.push(child);
        visit(child);
      }
    };
    visit(blocks);
    figures[0]?.setAttribute("claimCheck", "checked");
    expect(figures).not.toHaveLength(0);
    expect(addsOnlyPlaced(before, blocks, "edit-request", new Map())).toBe(false);
  });

  test("says why in the User's language", () => {
    expect(translate("en", "edit.problem.not-placed")).toBe(
      "The AI’s rewrite would add a Citation, footnote or figure its reply didn’t place, so nothing changed. Try again.",
    );
    expect(translate("zh-CN", "edit.problem.not-placed")).toBe(
      "AI 的改写会加入回复里没有的引用、脚注或计算结果，因此没有改动。可以再试一次。",
    );
  });
});

/** Honest replies: what models write when they keep, move, repeat, drop or tabulate a Citation. */
const HONEST = [
  {
    path: "improve",
    reply: "Spring tides come at new moon and at full moon [1]. Harbours publish the times.",
  },
  {
    path: "improve",
    reply: "[1] Spring tides come at new moon and at full moon. Harbours publish the times.",
  },
  {
    path: "improve",
    reply: "Spring tides come at new moon [1] and at full moon [1]. Harbours publish the times.",
  },
  {
    path: "improve",
    reply:
      "**Spring tides** come at new moon and at full moon **[1]**. Harbours publish the times.",
  },
  { path: "shorten", reply: "Spring tides come at new and full moon." },
  {
    path: "add",
    reply:
      "Spring tides happen at new moon and at full moon [1].\n\nHarbours publish the times.\n\nThe Sun and the Moon pull together [1].",
  },
  {
    path: "add",
    reply:
      "| Tide | When | Source |\n| --- | --- | --- |\n| Spring | New and full moon | [Tides] |",
  },
  { path: "add", reply: "## Spring tides\n\n- At new moon [1]\n- At full moon [1]" },
  { path: "improve", reply: "大潮出现在新月和满月前后[1]。港口每年都会公布潮汐时间。" },
  { path: "remove", reply: "Harbours publish the times." },
] as const;

describe("Edit with AI's honest edits (#2424)", () => {
  test.each(HONEST)("are never refused: $reply", async ({ path, reply }) => {
    const { core, input } = await editing("en", path, reply);
    expect((await core.editWithAi(input)).kind).toBe("proposed");
  });
});

/** The words, markers, formats and tables a reply is made of, at random. */
const PIECES = [
  "Spring",
  "tides",
  "come",
  "at",
  "new",
  "moon",
  "大潮",
  "每月",
  "[1]",
  "[1]",
  "[^1]",
  "[2]",
  "**[1]**",
  "*[^1]*",
  "[Tides]",
  "[sic]",
  "$x$",
  "\\[1]",
  "[\u20601]",
  "(1)",
  "42%",
];

function randomReply(rng: ReturnType<typeof random>): string {
  const words = () =>
    Array.from({ length: 2 + Math.floor(rng.next() * 8) }, () => rng.pick(PIECES)).join(" ");
  const block = () => {
    const roll = rng.next();
    if (roll < 0.15)
      return `| Claim | Source |\n| --- | --- |\n| ${words()} | ${rng.pick(["[Tides]", "[1]", "[Tides, p. 1]", "none"])} |`;
    if (roll < 0.25) return `## ${words()}`;
    if (roll < 0.35) return `- ${words()}\n- ${words()}`;
    return `${words()}.`;
  };
  return Array.from({ length: 1 + Math.floor(rng.next() * 3) }, block).join("\n\n");
}

const REPLIES = 500;

describe("Edit with AI's writer, whatever a reply writes (#2424)", () => {
  test(`never refuses an honest reply, and leaves only what the passage cites: ${REPLIES} seeded replies`, () => {
    const rng = random(2424);
    let ids = 0;
    for (let index = 0; index < REPLIES; index++) {
      const reply = randomReply(rng);
      const { doc, blocks } = userNote();
      const own = new Set<string>();
      const keys = (root: Y.XmlFragment | Y.XmlElement, found: string[] = []): string[] => {
        for (const child of root.toArray()) {
          if (!(child instanceof Y.XmlElement)) continue;
          if ([CITATION_NODE, FOOTNOTE_NODE, CALCULATED_FIGURE_NODE].includes(child.nodeName)) {
            found.push(citingKey(child));
          }
          keys(child, found);
        }
        return found;
      };
      for (const key of keys(blocks)) own.add(key);
      const paragraph = blocks.get(0);
      if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
      const size = layout(paragraph).reduce((sum, child) => sum + child.size, 0);
      const read = readSelection(
        blocks,
        { blockId: "p1", offset: 0 },
        { blockId: "p1", offset: size },
      );
      if (!read.ok) throw new Error(`The paragraph can't be read: ${read.reason}.`);
      const written = doc.transact(() =>
        proposeRewrite(read.selection, reply, "edit-request", () => `id-${++ids}`),
      );
      expect(written.notPlaced, `#${index}: ${JSON.stringify(reply)}`).toBeUndefined();
      doc.transact(() => decideProposals(blocks, () => true, "accept"));
      for (const key of keys(blocks))
        expect(own.has(key), `#${index}: ${JSON.stringify(reply)}`).toBe(true);
    }
  });
});
