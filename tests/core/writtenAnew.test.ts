import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import { PROPOSAL_ATTRIBUTE } from "../../src/core";
import { outOfDateProposals, pendingProposals, resolveProposals } from "../../src/shared/proposals";
import { askAssistant, changesIn } from "../helpers/assistant";
import { createTempDataFolder, startCore } from "../helpers/core";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { type ScriptedReply, scriptedModel, scriptedModels } from "../helpers/models";

/**
 * The assistant's own text already in a Mind, written anew as a whole (#1488): asked to make
 * it longer, a model gives the whole new text, and only what differs changes. Each new
 * paragraph is written over the old one it is most like, word by word; a list stays a list,
 * item by item; the rest is added or removed whole. Through the core's public interface, on a
 * scripted model.
 */

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});
const table = (rows: readonly (readonly string[])[]): JSONContent => ({
  type: "table",
  content: rows.map((cells, row) => ({
    type: "tableRow",
    content: cells.map((text) => ({
      type: row === 0 ? "tableHeader" : "tableCell",
      attrs: { colspan: 1, rowspan: 1 },
      content: [paragraph(text)],
    })),
  })),
});
const list = (items: readonly string[]): JSONContent => ({
  type: "bulletList",
  content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
});

/** A Mind holding the assistant's own `blocks`, added from an Answer; asked anything, the model writes `content` over the section `part`. */
async function writtenAnew(blocks: JSONContent[], part: string, content: string) {
  const model = scriptedModel((call): ScriptedReply => {
    if (call.results.length > 0) return { text: "Done." };
    return { calls: [{ tool: "edit_mind", input: { part, content } }] };
  });
  const core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: "Tide notes" });
  const client = await connectToMind(core, mind.id);
  await core.addToNote({ mindId: mind.id, blocks, origin: null, model: null });
  await client.settled();
  const before = shown(client);
  const answer = await askAssistant(core, { text: "Make the summary longer.", mindId: mind.id });
  await client.settled();
  const [change] = changesIn(answer);
  return { client, change, before };
}

function wordsWithChanges(block: ProseMirrorNode): string {
  let line = "";
  block.forEach((child) => {
    const inline = child.isText ? (child.text ?? "") : "￼";
    const marks = child.marks.map((mark) => mark.type.name);
    if (marks.includes("proposalDelete")) line += `[-${inline}-]`;
    else if (marks.includes("proposalInsert")) line += `{+${inline}+}`;
    else line += inline;
  });
  return line.replace(/-\]\[-|\+\}\{\+/g, "");
}

/**
 * The Mind as it reads with its changes, one line per paragraph or heading: removed words in
 * [-…-] and added ones in {+…+}, a list item after "• ", and a Block added or removed whole,
 * however far out its change sits, after "+ " or "- ".
 */
function shown(client: MindClient): string[] {
  const lines: string[] = [];
  const visit = (node: ProseMirrorNode, whole: string, item: string) => {
    const kind = (node.attrs[PROPOSAL_ATTRIBUTE] as { kind?: string } | null)?.kind;
    const here = kind === "insert" ? "+ " : kind === "delete" ? "- " : whole;
    if (node.isTextblock) {
      lines.push(`${here}${item}${wordsWithChanges(node)}`);
      return;
    }
    node.forEach((child) => {
      visit(child, here, node.type.name === "listItem" ? "• " : item);
    });
  };
  readMind(client).forEach((block) => {
    visit(block, "", "");
  });
  return lines;
}

function decided(client: MindClient, outcome: "accept" | "reject"): string[] {
  client.doc.transact(() => resolveProposals(client.blocks, () => true, outcome));
  return shown(client);
}

const OLD = [
  "Spring tides come at new and full moon.",
  "Neap tides come at the quarter moons.",
  "The harbour office posts the times each week.",
  "Boats rest on the mud at low water.",
  "Gulls wheel over the quay at dawn.",
  "The ferry runs twice a day in summer.",
  "Storms can raise the water by a metre.",
  "The lifeboat station opens on Sundays.",
];
const LONGER = [
  "Spring tides come at new and full moon, when the Sun and the Moon pull together.",
  "Twice a month, between the big tides, the range is smallest and the water barely turns.",
  "The harbour office posts the times each week.",
  "Boats rest on the soft mud at low water.",
  "Gulls wheel over the quay at dawn.",
  "Fishing boats leave on the first of the ebb.",
  "The ferry runs twice a day in summer.",
  "Storms from the west can raise the water by a metre.",
  "The lifeboat station opens on Sundays.",
];

describe("The assistant's own text written anew (#1488)", { timeout: 30_000 }, () => {
  // protects=“make it longer” given as the whole new text changes only the 4 paragraphs it edits and adds the 1 it adds, the rest left as they are, counted 5 on the change; fails_when=the whole section is removed and added again, or the count is the section's paragraphs; no_claim=what a real model writes.
  test("only the paragraphs it edits change, word by word or whole, and the one it adds is added", async () => {
    const { client, change } = await writtenAnew(
      [heading("Tides"), ...OLD.map(paragraph)],
      "Tides",
      ["## Tides", ...LONGER].join("\n\n"),
    );

    expect(shown(client)).toEqual([
      "Tides",
      "Spring tides come at new and full moon{+, when the Sun and the Moon pull together+}.",
      "[-Neap tides come at the quarter moons.-]{+Twice a month, between the big tides, the range is smallest and the water barely turns.+}",
      "The harbour office posts the times each week.",
      "Boats rest on the {+soft +}mud at low water.",
      "Gulls wheel over the quay at dawn.",
      "+ Fishing boats leave on the first of the ebb.",
      "The ferry runs twice a day in summer.",
      "Storms {+from the west +}can raise the water by a metre.",
      "The lifeboat station opens on Sundays.",
    ]);
    expect(change).toMatchObject({ changed: 5 });
    expect(pendingProposals(client.blocks)).toHaveLength(5);
    expect(outOfDateProposals(client.blocks).size).toBe(0);
    expect(decided(client, "accept")).toEqual(["Tides", ...LONGER]);
  });

  // protects=rejecting every change brings back exactly the text that was there; fails_when=a paragraph kept or edited in place is lost or doubled; no_claim=the editor's own Undo.
  test("rejected, it is the text it was", async () => {
    const { client, before } = await writtenAnew(
      [heading("Tides"), ...OLD.map(paragraph)],
      "Tides",
      ["## Tides", ...LONGER].join("\n\n"),
    );

    expect(before).toEqual(["Tides", ...OLD]);
    expect(decided(client, "reject")).toEqual(before);
  });

  // protects=the edge cases of pairing paragraphs: each pairs with the one it is most like, in order, so nothing reads as turning into another; fails_when=a moved, split or merged paragraph is paired by position; no_claim=a move shown as a move (it reads as removed where it was and added where it is, as in Word).
  test.each([
    {
      name: "every paragraph rewritten is one change each",
      old: ["Spring tides are high.", "Neap tides are low."],
      next: ["The Moon pulls the sea twice a day.", "Winds push water into the bay."],
      lines: [
        "[-Spring tides are high.-]{+The Moon pulls the sea twice a day.+}",
        "[-Neap tides are low.-]{+Winds push water into the bay.+}",
      ],
      changed: 2,
    },
    {
      name: "a paragraph split into two keeps its first part",
      old: [
        "Spring tides come at new and full moon, when the tide rises highest. Neap tides come at the quarter moons.",
      ],
      next: [
        "Spring tides come at new and full moon, when the tide rises highest.",
        "Neap tides come at the quarter moons.",
      ],
      lines: [
        "Spring tides come at new and full moon, when the tide rises highest.[- Neap tides come at the quarter moons.-]",
        "+ Neap tides come at the quarter moons.",
      ],
      changed: 2,
    },
    {
      name: "two paragraphs merged into one",
      old: ["Spring tides come at new moon.", "Neap tides come at the quarter moons."],
      next: ["Spring tides come at new moon, and neap tides at the quarter moons."],
      lines: [
        "Spring tides come at new moon{+, and neap tides at the quarter moons+}.",
        "- Neap tides come at the quarter moons.",
      ],
      changed: 2,
    },
    {
      name: "a paragraph moved reads as added where it goes and removed where it was",
      old: ["Spring tides are high.", "Neap tides are low.", "Gulls wheel at dawn."],
      next: ["Gulls wheel at dawn.", "Spring tides are high.", "Neap tides are low."],
      lines: [
        "+ Gulls wheel at dawn.",
        "Spring tides are high.",
        "Neap tides are low.",
        "- Gulls wheel at dawn.",
      ],
      changed: 2,
    },
    {
      name: "a paragraph added at the start doesn't take the first one's place",
      old: ["Spring tides are high at new moon.", "Neap tides are low at the quarter moons."],
      next: [
        "Tides follow the Moon.",
        "Spring tides are high at new and full moon.",
        "Neap tides are low at the quarter moons.",
      ],
      lines: [
        "+ Tides follow the Moon.",
        "Spring tides are high at new {+and full +}moon.",
        "Neap tides are low at the quarter moons.",
      ],
      changed: 2,
    },
    {
      name: "Chinese reads word by word, with no spaces",
      old: ["这篇论文讲的是大潮。", "小潮出现在上弦月和下弦月。"],
      next: ["这篇论文讲的是大潮和小潮。", "小潮出现在上弦月和下弦月。"],
      lines: ["这篇论文讲的是大潮{+和小潮+}。", "小潮出现在上弦月和下弦月。"],
      changed: 1,
    },
    {
      name: "a Chinese paragraph rewritten is one change",
      old: ["大潮出现在新月和满月。", "渔船在退潮时出海。"],
      next: ["每月两次，潮差最大的日子在朔望前后。", "渔船在退潮时出海。"],
      lines: [
        "[-大潮出现在新月和满月。-]{+每月两次，潮差最大的日子在朔望前后。+}",
        "渔船在退潮时出海。",
      ],
      changed: 1,
    },
  ])("$name", async ({ old, next, lines, changed }) => {
    const { client, change } = await writtenAnew(
      [heading("Tides"), ...old.map(paragraph)],
      "Tides",
      ["## Tides", ...next].join("\n\n"),
    );

    expect(shown(client).slice(1)).toEqual(lines);
    expect(change).toMatchObject({ changed });
    expect(decided(client, "accept").slice(1)).toEqual(next);
  });

  // protects=a bulleted list written anew stays a list: an item edited is changed in place, a new item is added into the list, one left out is removed from it; fails_when=the whole list is removed and a new one added, or items pair by position; no_claim=numbered lists, which go the same way.
  test("a list stays a list, its items edited, added and removed in place", async () => {
    const { client, change } = await writtenAnew(
      [
        heading("Tides"),
        list(["Spring tides at new moon", "Neap tides at the quarter moons", "Gulls at dawn"]),
      ],
      "Tides",
      [
        "## Tides",
        "- Spring tides at new and full moon",
        "- Neap tides at the quarter moons",
        "- Storms from the west",
      ].join("\n"),
    );

    expect(shown(client)).toEqual([
      "Tides",
      "• Spring tides at new {+and full +}moon",
      "• Neap tides at the quarter moons",
      "- • Gulls at dawn",
      "+ • Storms from the west",
    ]);
    expect(change).toMatchObject({ changed: 2 });
    expect(readMind(client).child(1).type.name).toBe("bulletList");
    expect(decided(client, "accept")).toEqual([
      "Tides",
      "• Spring tides at new and full moon",
      "• Neap tides at the quarter moons",
      "• Storms from the west",
    ]);
  });

  // protects=a heading reworded is one change, a table the new text keeps as it was stays, and one it changes is removed and added whole, a table both times; fails_when=the heading reads word by word, or an unchanged table is removed and added again; no_claim=tables edited cell by cell.
  test("a heading reworded is one change, a table kept stays, and a table changed is replaced whole", async () => {
    const heights = "| Day | Height |\n|---|---|\n| 1 | 4 m |";
    const { client, change } = await writtenAnew(
      [
        heading("Tides"),
        table([
          ["Day", "Height"],
          ["1", "4 m"],
        ]),
        paragraph("Spring tides are high."),
        table([
          ["Port", "Ferry"],
          ["Ayr", "9:00"],
        ]),
      ],
      "Tides",
      [
        "## Tides in May",
        heights,
        "Spring tides are high.",
        "| Port | Ferry |\n|---|---|\n| Ayr | 10:00 |",
      ].join("\n\n"),
    );

    expect(shown(client)).toEqual([
      "[-Tides-]{+Tides in May+}",
      "Day",
      "Height",
      "1",
      "4 m",
      "Spring tides are high.",
      "- Port",
      "- Ferry",
      "- Ayr",
      "- 9:00",
      "+ Port",
      "+ Ferry",
      "+ Ayr",
      "+ 10:00",
    ]);
    expect(change).toMatchObject({ changed: 1 });
    expect(readMind(client).child(4).type.name).toBe("table");
  });

  // protects=a long Mind with one paragraph edited gets one change, not one per paragraph; fails_when=the matching pairs paragraphs by position past the edit, or gives up on a long text; no_claim=how fast it is (by hand: Review opens at once on 500 paragraphs).
  test("of 500 paragraphs, the one edited is the one change", async () => {
    const old = Array.from({ length: 500 }, (_, index) => `Paragraph ${index + 1} of the log.`);
    const next = old.map((text, index) => (index === 250 ? `${text} It rained.` : text));
    const { client, change } = await writtenAnew(
      [heading("Log"), ...old.map(paragraph)],
      "Log",
      ["## Log", ...next].join("\n\n"),
    );

    expect(pendingProposals(client.blocks)).toHaveLength(1);
    expect(change).toMatchObject({ changed: 1 });
    expect(shown(client)[251]).toBe("Paragraph 251 of the log.{+ It rained.+}");
  });
});
