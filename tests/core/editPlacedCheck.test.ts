/**
 * Edit with AI's changes are checked once written (#2424), as an outside agent's are: every
 * Citation, footnote and figure a change leaves is one that was there, as it was, or one its
 * reply placed, told apart by all it holds. A writer made to add or change one refuses the
 * whole change on each of Edit with AI's paths, in English and Chinese, and the Note is as it
 * was. Honest edits, and seeded random replies, are never refused.
 */
import type { JSONContent } from "@tiptap/core";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  CALCULATED_FIGURE_NODE,
  CITATION_NODE,
  type Document,
  FOOTNOTE_NODE,
  MIND_CONTENT_FIELD,
} from "../../src/core";
import { createElement } from "../../src/core/answers/blocks";
import { citingKey, splitCiting, unplacedSince } from "../../src/core/proposals/placed";
import { layout, proposeRewrite, readSelection, setProposal } from "../../src/core/proposals/write";
import { translate } from "../../src/shared/i18n";
import {
  decideProposals,
  outOfDateProposals,
  pendingProposals,
  targetHash,
} from "../../src/shared/proposals";
import { propose, userNote } from "../helpers/agentChanges";
import { setUpWithDocuments } from "../helpers/citations";
import { editingModel, plainOf, wholeMind, wholeParagraph } from "../helpers/editing";
import { note, readMind, writeMind } from "../helpers/minds";
import { controlledModel } from "../helpers/models";
import { random } from "../helpers/random";

type Drift = "add" | "alter" | "footnote";

/**
 * What the writing below the check does of its own, as a writer that drifted would: after the
 * `at`-th write that writes anything (`mode`), or in each Citation it makes from a marker
 * (`forge`).
 */
const drift = vi.hoisted(() => ({ mode: null as Drift | null, at: 1, forge: false }));

vi.mock("../../src/core/answers/blocks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/answers/blocks")>();
  return {
    ...real,
    createElement: (...args: Parameters<typeof real.createElement>) => {
      const [node] = args;
      const made =
        drift.forge && node.type === CITATION_NODE
          ? { ...node, attrs: { ...node.attrs, quote: "The Moon is made of cheese." } }
          : node;
      return real.createElement(made);
    },
  };
});

vi.mock("../../src/core/proposals/write", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/proposals/write")>();
  return {
    ...real,
    createRewriteStream: (...args: Parameters<typeof real.createRewriteStream>) => {
      const stream = real.createRewriteStream(...args);
      const [selection, request] = args;
      let writes = 0;
      const after = (wrote: boolean) => {
        const element = selection.segments[0]?.element;
        if (wrote) writes += 1;
        if (wrote && writes === drift.at && drift.mode && element) {
          driftIn(element, request, drift.mode);
        }
        return wrote;
      };
      return {
        ...stream,
        write: (text: string, done?: boolean) => after(stream.write(text, done)),
        finish: () => after(stream.finish()),
        stop: () => after(stream.stop()),
      };
    },
    proposeAfter: (...args: Parameters<typeof real.proposeAfter>) => {
      const written = real.proposeAfter(...args);
      const [, selection, , request] = args;
      const element = selection.segments[0]?.element;
      if (drift.mode && element) driftIn(element, request, drift.mode);
      return written;
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
  const next = paragraph.doc
    ?.getXmlFragment(MIND_CONTENT_FIELD)
    .toArray()
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
async function editing(
  language: Language,
  path: Path,
  reply: string = PATHS[language][path],
  block = "first",
  model: MockLanguageModelV4 = editingModel(() => reply),
) {
  const set = await setUpWithDocuments(model, [TIDES]);
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
    block,
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

  test.each([
    { mode: "alter", language: "en" },
    { mode: "footnote", language: "en" },
    { mode: "alter", language: "zh-CN" },
    { mode: "footnote", language: "zh-CN" },
  ] as const)(
    "refuses it when the writing does $mode of its own ($language)",
    async ({ mode, language }) => {
      const { core, client, input } = await editing(language, "improve");
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

  test("takes back what earlier paragraphs merged when a later one adds a Citation its reply didn't place", async () => {
    const reply = [
      "Spring tides come at new moon and at full moon [1]. Harbours publish the times.",
      "Neap tides are much weaker [2] [^1].",
      "Both follow the Moon.",
    ].join("\n\n");
    const whole = async () => {
      const { core, client, mind, input } = await editing("en", "improve", reply);
      const second = plainOf(client, "second");
      return {
        core,
        client,
        input: {
          ...input,
          to: { blockId: "second", offset: second.length },
          text: `${input.text}\n${second}`,
        },
        mind,
      };
    };
    const honest = await whole();
    expect((await honest.core.editWithAi(honest.input)).kind).toBe("proposed");

    // The first paragraph is in the Note when the second is written, with its forged Citation.
    const { core, client, input } = await whole();
    const before = readMind(client).toJSON();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    drift.mode = "add";
    drift.at = 2;
    try {
      expect(await core.editWithAi(input)).toEqual({ kind: "not-placed" });
      // Said with the request and the action, by kind and count, and none of the words.
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("(improve)"), {
        changed: {},
        added: { citation: 1 },
      });
    } finally {
      drift.mode = null;
      drift.at = 1;
      logged.mockRestore();
    }
    await client.settled();
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(readMind(client).toJSON()).toEqual(before);
  });

  test("refuses Explain's words when the writing adds a Citation to them", async () => {
    const explaining = async () => {
      const set = await editing("en", "improve", "It says when spring tides come.");
      return { ...set, input: wholeParagraph(set.client, set.mind.id, "first", "explain") };
    };
    const honest = await explaining();
    expect((await honest.core.editWithAi(honest.input)).kind).toBe("proposed");

    const { core, client, input } = await explaining();
    const before = readMind(client).toJSON();
    drift.mode = "add";
    try {
      expect(await core.editWithAi(input)).toEqual({ kind: "not-placed" });
    } finally {
      drift.mode = null;
    }
    await client.settled();
    expect(readMind(client).toJSON()).toEqual(before);
  });

  test("refuses Regenerate's change when the writing adds a Citation its reply didn't place", async () => {
    const { core, client, mind, input } = await editing("en", "improve");
    const made = await core.editWithAi(input);
    expect(made.kind).toBe("proposed");
    await client.settled();
    // The User types in the words the change takes out: it is out of date, for Regenerate.
    const [stale] = pendingProposals(client.blocks);
    const paragraph = client.blocks.get(0);
    const words = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(words instanceof Y.XmlText) || !stale) throw new Error("No change to put out of date.");
    words.insert("Spring tides ha".length, "p");
    await client.settled();
    expect(outOfDateProposals(client.blocks).has(stale.id)).toBe(true);
    const before = readMind(client).toJSON();

    drift.mode = "add";
    try {
      expect(
        await core.regenerateProposal({
          requestId: "again",
          mindId: mind.id,
          proposalId: stale.id,
        }),
      ).toEqual({ kind: "not-placed" });
    } finally {
      drift.mode = null;
    }
    await client.settled();
    expect(readMind(client).toJSON()).toEqual(before);
  });

  test("marks a rewrite whose writer makes a Citation other than the one its marker names", () => {
    const rewrite = (text: string) => {
      const { doc, blocks } = userNote();
      const paragraph = blocks.get(0);
      if (!(paragraph instanceof Y.XmlElement)) throw new Error("No paragraph.");
      const size = layout(paragraph).reduce((sum, child) => sum + child.size, 0);
      const read = readSelection(
        blocks,
        { blockId: "p1", offset: 0 },
        { blockId: "p1", offset: size },
      );
      if (!read.ok) throw new Error(`The paragraph can't be read: ${read.reason}.`);
      return doc.transact(() =>
        proposeRewrite(read.selection, text, "edit-request", () => crypto.randomUUID()),
      );
    };
    // The kept marker moved: its Citation is made again where the reply put it.
    const moved = "[1] Spring tides come at new moon, as noted.";
    expect(rewrite(moved).notPlaced).toBeUndefined();
    drift.forge = true;
    try {
      expect(rewrite(moved).notPlaced).toBe(true);
    } finally {
      drift.forge = false;
    }
  });

  test("refuses an outside agent's change when the writer makes a Citation other than its token's", () => {
    const text = "Moon rocks are grey [cite:moona001].";
    expect(propose("rewrite", text).outcome).toBe("accepted");
    drift.forge = true;
    try {
      const { blocks, outcome } = propose("rewrite", text);
      expect(outcome).toBe("agents.propose.unplaced");
      expect(pendingProposals(blocks)).toEqual([]);
    } finally {
      drift.forge = false;
    }
  });

  test("finds a figure changed in place, and holds one left as it was", () => {
    const { blocks } = userNote();
    const before = splitCiting(blocks, "edit-request");
    expect(unplacedSince(before, blocks, "edit-request", new Map())).toBeNull();
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
    // Reported by kind and count, with none of its words.
    expect(unplacedSince(before, blocks, "edit-request", new Map())).toEqual({
      changed: { calculatedFigure: 1 },
      added: { calculatedFigure: 1 },
    });
  });

  test("says why in the User's language, in the composer and on the change card", () => {
    expect(translate("en", "edit.problem.not-placed")).toBe(
      "The AI’s rewrite would have added or edited a Citation, footnote or figure, so nothing changed. Try again.",
    );
    expect(translate("zh-CN", "edit.problem.not-placed")).toBe(
      "AI 的改写会加入或修改引用、脚注或计算结果，没有改动。请重试。",
    );
    expect(translate("en", "mindCall.failed.notPlaced", { mind: "Tides" })).toBe(
      "The rewrite would have added or edited a Citation, footnote or figure in “Tides”, so nothing changed",
    );
    expect(translate("zh-CN", "mindCall.failed.notPlaced", { mind: "潮汐" })).toBe(
      "改写会在“潮汐”里加入或修改引用、脚注或计算结果，因此没有改动",
    );
  });

  test("takes back what was merged when the write made on Stop adds a Citation its reply didn't place", async () => {
    const stopped = async (forged: boolean) => {
      const controlled = controlledModel();
      const { core, client, input } = await editing("en", "improve", "", "first", controlled.model);
      const second = plainOf(client, "second");
      const both = {
        ...input,
        to: { blockId: "second", offset: second.length },
        text: `${input.text}\n${second}`,
      };
      const before = readMind(client).toJSON();
      drift.mode = forged ? "add" : null;
      drift.at = 2;
      try {
        const result = core.editWithAi(both);
        await controlled.requested();
        // The first paragraph goes in; the next, like none of the passage's, waits for its place.
        controlled.push(
          "Spring tides come at new moon and at full moon [1]. Harbours publish the times.\n\nBoth follow the Moon.\n\nNeap",
        );
        await vi.waitFor(() => expect(pendingProposals(client.blocks).length).toBeGreaterThan(0));
        await core.cancelEdit(both.requestId);
        const done = await result;
        await client.settled();
        return { done, client, before };
      } finally {
        drift.mode = null;
        drift.at = 1;
      }
    };
    const notRefused = await stopped(false);
    expect(notRefused.done.kind).toBe("proposed");
    // Stop without a refusal keeps what is finished.
    expect(pendingProposals(notRefused.client.blocks).length).toBeGreaterThan(0);

    const { done, client, before } = await stopped(true);
    expect(done).toEqual({ kind: "not-placed" });
    expect(pendingProposals(client.blocks)).toEqual([]);
    expect(readMind(client).toJSON()).toEqual(before);
  });

  test("a part refused on Stop says why, and every part goes, as when a part fails", async () => {
    // Each paragraph is about 10,800 characters: the two are edited as two parts (#2348).
    const LINE = "Sailors kept their own tables of the tides and the times of high water. ";
    const body = (index: number) =>
      `Tide table ${index}, the water is very high. ${LINE.repeat(150)}`;
    const controlled = controlledModel();
    const set = await setUpWithDocuments(controlled.model, [TIDES]);
    writeMind(set.client, [note(body(0)), note(body(1))]);
    await set.client.settled();
    const input = { ...wholeMind(set.client, set.mind.id, ""), action: "shorten" as const };
    const before = readMind(set.client).toJSON();
    const parts: number[] = [];
    set.core.on("mind.writing", ({ part }) => {
      if (part) parts.push(part.at);
    });

    const editing = set.core.editWithAi(input);
    await controlled.requested(1);
    // The first part merges its paragraph; the change is in the Note when the next part starts.
    controlled.push(body(0).replaceAll(" very", ""));
    controlled.finish();
    await vi.waitFor(() => expect(pendingProposals(set.client.blocks).length).toBeGreaterThan(0));
    await controlled.requested(2);
    // The User presses Stop with nothing of the second part placed; what Stop writes adds a
    // Citation its reply didn't place.
    controlled.push("Neap tides are weaker.\n\nNeap");
    await vi.waitFor(() => expect(parts.at(-1)).toBe(2));
    drift.mode = "add";
    drift.at = 1;
    try {
      await set.core.cancelEdit(input.requestId);
      expect(await editing).toEqual({ kind: "not-placed" });
    } finally {
      drift.mode = null;
      drift.at = 1;
    }
    await set.client.settled();
    // The refusal is the edit's answer, not a Stop: every part is taken back, and the Note is as it was.
    expect(pendingProposals(set.client.blocks)).toEqual([]);
    expect(readMind(set.client).toJSON()).toEqual(before);
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

/** Honest replies over the paragraph with a footnote, which keep it, move it or drop it. */
const HONEST_NOTED = [
  "[^1] Neap tides are weaker [1].",
  "Neap tides are much weaker [1], as noted [^1].",
  "Neap tides are weaker [1] [^1]. They come at the quarter moons [1].",
  "Neap tides are weaker.",
] as const;

describe("Edit with AI's honest edits (#2424)", () => {
  test.each(HONEST_NOTED)("are never refused where a footnote moves: %s", async (reply) => {
    const { core, input } = await editing("en", "improve", reply, "second");
    expect((await core.editWithAi(input)).kind).toBe("proposed");
  });

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
