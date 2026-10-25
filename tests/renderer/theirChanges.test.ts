/**
 * The reviewing pane's cards (#697), from a Word file imported through the
 * core: someone's changes and the file's comments in the Mind's order, with
 * their clause numbers, authors and excerpts, and a change decided keeping
 * its card until Undo makes it wait again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { readManifest, WORD_DIR } from "../../eval/word/corpus";
import { mindOf } from "../../eval/word/exports";
import { MIND_CONTENT_FIELD, MIND_PROPOSAL_REQUESTS_FIELD, WORD_CHANGE_ID } from "../../src/core";
import { WordRefusedError } from "../../src/core/documents/formats/docxPackage";
import {
  initialsOf,
  keepDecisions,
  namesList,
  type ReviewItem,
  reviewItemsIn,
  splitNumber,
  waitingChanges,
} from "../../src/renderer/src/editor/theirChanges";
import { authorShown, filterOf, shownIn } from "../../src/renderer/src/reviewPane";
import { translate } from "../../src/shared/i18n";
import { decideProposals, pendingProposals } from "../../src/shared/proposals";
import { createTempDataFolder, startCore } from "../helpers/core";
import type { MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { supplyRedline } from "../helpers/redline";
import { paragraph, wordFile } from "../helpers/word";
import { importWordBytes } from "../helpers/wordMinds";

async function imported(bytes: Buffer): Promise<MindClient> {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir);
  const { client } = await importWordBytes(core, dataDir, bytes, { origin: "someone-else" });
  return client;
}

const itemsOf = (client: MindClient) => reviewItemsIn(readMind(client), client.doc);

/** A card as the pane shows it: who, the clause, its state, and its words, struck [-…-] and underlined {+…+}. */
const card = (item: ReviewItem) =>
  item.kind === "comment"
    ? `comment · ${item.author}: ${item.text}`
    : `${item.clause} · ${initialsOf(item.author)} · ${item.state}: ${item.excerpt
        .map((part) =>
          part.kind === "insert"
            ? `{+${part.text}+}`
            : part.kind === "delete"
              ? `[-${part.text}-]`
              : part.text,
        )
        .join("")}`;

/** Accepts or rejects changes as the editor does: in one step, keeping each one's card. */
function decide(client: MindClient, ids: readonly string[], outcome: "accept" | "reject"): void {
  const before = readMind(client);
  client.doc.transact(() => {
    const resolved = decideProposals(client.blocks, (ref) => ids.includes(ref.id), outcome);
    keepDecisions(client.doc, before, resolved, outcome);
  });
}

describe("the reviewing pane's cards", () => {
  test("list every change and comment in the Mind's order: clause, initials and a few words around each change", async () => {
    const client = await imported(supplyRedline());
    expect(itemsOf(client).map(card)).toEqual([
      "1.2 · DK · waiting: …at its plants in Leeds{+ and Gdańsk+} and delivers them to Corran under clause 4.",
      "1.3 · LO · waiting: Northwind gives [-90-]{+60+} days’ notice before moving production to another plant.",
      "2.1 · DK · waiting: …a year by up to [-8%, on 30 days’ notice-]{+6%, on 45 days’ notice, as agreed on the call of 3 September+}.",
      "comment · Dana Kim: Resin is up 11% since June. Our letter of 19 September has the figures.",
      "3.1 · LO · waiting: Corran pays each invoice within [-14-]{+30+} days of the invoice date. Late payments carry interest at 4% a year above the Bank of England base rate.",
      "4.2 · DK · waiting: …the sites in Schedule 3{+, for orders of at least 40 pallets+}.",
      "6.2 · DK · waiting: Otherwise, {+Northwind’s total liability is capped at the fees paid in the three months before the claim+}.",
      "comment · Dana Kim: Our insurer needs a cap in every supply contract.",
      "7.1 · DK · waiting: {+Every plant that makes the Products holds ISO 22000 certification.+}",
    ]);
    const changes = waitingChanges(itemsOf(client));
    expect(changes.map((each) => each.author)).toEqual([
      "Dana Kim",
      "Luis Ortega",
      "Dana Kim",
      "Luis Ortega",
      "Dana Kim",
      "Dana Kim",
      "Dana Kim",
    ]);
    expect(changes[1]?.date).toBe("2026-10-05T16:20:00Z");
  });

  test("a change decided keeps its card, Accepted or Rejected, where its paragraph is; Undo makes it wait again", async () => {
    const client = await imported(supplyRedline());
    const steps = new Y.UndoManager([
      client.blocks,
      client.doc.getMap(MIND_PROPOSAL_REQUESTS_FIELD),
    ]);
    const [, notice, , , , , quality] = waitingChanges(itemsOf(client));
    if (!notice || !quality) throw new Error("The redline's changes didn't come in.");

    decide(client, [notice.id], "accept");
    steps.stopCapturing();
    decide(client, [quality.id], "reject");
    const after = itemsOf(client);
    expect(after.map(card)).toContain(
      "1.3 · LO · accepted: Northwind gives [-90-]{+60+} days’ notice before moving production to another plant.",
    );
    // Its paragraph went with it: the card stays at the end, after the clause before it.
    expect(after.map(card).at(-1)).toBe(
      "7.1 · DK · rejected: {+Every plant that makes the Products holds ISO 22000 certification.+}",
    );
    expect(after.filter((item) => item.kind === "change").map((item) => item.id)).toHaveLength(7);
    expect(waitingChanges(after)).toHaveLength(5);
    expect(readMind(client).textContent).not.toContain("ISO 22000");

    steps.undo();
    expect(waitingChanges(itemsOf(client)).map((each) => each.id)).toContain(quality.id);
    expect(readMind(client).textContent).toContain("ISO 22000");
    steps.undo();
    expect(waitingChanges(itemsOf(client))).toHaveLength(7);
    expect(itemsOf(client).some((item) => item.kind === "change" && item.state !== "waiting")).toBe(
      false,
    );
  });

  test("a file with no changes or comments has nothing to review", async () => {
    const client = await imported(wordFile({ body: paragraph("1. A clause nobody changed.") }));
    expect(itemsOf(client)).toEqual([]);
  });
});

describe("which cards a pane shows", () => {
  const cards = [
    { kind: "change", author: "Dana Kim", state: "accepted" },
    { kind: "change", author: "Luis Ortega", state: "accepted" },
    { kind: "comment", author: "Dana Kim" },
    { kind: "change", author: "Dana Kim", state: "waiting" },
  ] as const;

  test("Unresolved once anything is decided, unless the User picked; decided cards leave it, comments stay", () => {
    expect(filterOf(undefined, cards)).toBe("unresolved");
    expect(filterOf({ filter: "all" }, cards)).toBe("all");
    expect(filterOf(undefined, [cards[2], cards[3]])).toBe("all");
    expect(shownIn(cards, { filter: "unresolved", who: null })).toEqual([cards[2], cards[3]]);
    expect(shownIn(cards, { filter: "all", who: "Luis Ortega" })).toEqual([cards[1]]);
  });

  test("an author with nothing in the filter shown is no choice there: everyone shows", () => {
    expect(authorShown(cards, { filter: "unresolved", who: "Luis Ortega" })).toBeNull();
    expect(shownIn(cards, { filter: "unresolved", who: "Luis Ortega" })).toEqual([
      cards[2],
      cards[3],
    ]);
    expect(authorShown(cards, { filter: "all", who: "Luis Ortega" })).toBe("Luis Ortega");
  });
});

describe("what a card says", () => {
  test("a typed clause number, not a number that starts a sentence", () => {
    expect(splitNumber("1.2 Northwind makes")).toEqual({ number: "1.2", rest: "Northwind makes" });
    expect(splitNumber("3. Orders").number).toBe("3");
    expect(splitNumber("(a)\tthe Buyer").number).toBe("(a)");
    expect(splitNumber("一、总则").number).toBe("一");
    expect(splitNumber("第三条 付款").number).toBe("第三条");
    expect(splitNumber("Clause 8 Payment").number).toBe("Clause 8");
    expect(splitNumber("2026 was a good year").number).toBeNull();
    expect(splitNumber("Northwind gives").number).toBeNull();
  });

  test("initials and lists of names, in English and Chinese", () => {
    expect(initialsOf("Dana Kim")).toBe("DK");
    expect(initialsOf("Acien, Clara")).toBe("AC");
    expect(initialsOf("Legal")).toBe("L");
    expect(initialsOf("审核人甲")).toBe("审");
    expect(initialsOf(null)).toBe("?");
    expect(namesList(["Dana Kim", "Luis Ortega"], "en")).toBe("Dana Kim and Luis Ortega");
    expect(namesList(["Dana Kim", "Luis Ortega"], "zh-CN")).toBe("Dana Kim 和 Luis Ortega");
    expect(namesList(["审核人甲", "对方律师"], "zh-CN")).toBe("审核人甲和对方律师");
    expect(namesList(["Dana Kim", "Luis Ortega", "审核人甲"], "zh-CN")).toBe(
      "Dana Kim、Luis Ortega 和审核人甲",
    );
    // A space between Chinese and a Latin name, none beside a Chinese one (docs/agents/zh-CN.md).
    const line = (names: string) => translate("zh-CN", "review.line", { count: 4, names });
    expect(line(namesList(["对方律师", "审核人甲"], "zh-CN"))).toBe(
      "来自对方律师和审核人甲的 4 处修订",
    );
    expect(line(namesList(["Dana Kim", "Luis Ortega"], "zh-CN"))).toBe(
      "来自 Dana Kim 和 Luis Ortega 的 4 处修订",
    );
    expect(translate("zh-CN", "review.acceptAuthor", { person: "对方律师" })).toBe(
      "全部接受对方律师的修订",
    );
    expect(translate("zh-CN", "review.rejectAuthor", { person: "Luis Ortega" })).toBe(
      "全部拒绝 Luis Ortega 的修订",
    );
    expect(translate("en", "review.line", { count: 4, names: "Dana Kim and Luis Ortega" })).toBe(
      "4 changes from Dana Kim and Luis Ortega",
    );
  });
});

const reviewed = readManifest()
  .filter((entry) => entry.features.trackedChanges > 0 || entry.features.comments > 0)
  .map((entry) => entry.file);

test.each(reviewed)(
  "%s: the pane has a card for every change waiting and every comment, in the Mind's order, and every one decided keeps it",
  async (file) => {
    let doc: Y.Doc;
    try {
      doc = await mindOf(readFileSync(join(WORD_DIR, file)));
    } catch (error) {
      if (error instanceof WordRefusedError) return;
      throw error;
    }
    const client = { doc, blocks: doc.getXmlFragment(MIND_CONTENT_FIELD) } as MindClient;
    const items = itemsOf(client);
    const theirs = pendingProposals(client.blocks)
      .filter((each) => each.id.startsWith(WORD_CHANGE_ID))
      .map((each) => each.id);
    expect(waitingChanges(items).map((each) => each.id)).toEqual(theirs);
    let comments = 0;
    readMind(client).descendants((node) => {
      if (node.type.name === "wordAtom" && node.attrs.kind === "comment") comments++;
    });
    expect(items.filter((item) => item.kind === "comment")).toHaveLength(comments);
    const places = items.map((item) => item.from);
    expect(places).toEqual([...places].sort((a, b) => a - b));
    for (const change of waitingChanges(items)) {
      expect(change.excerpt.some((part) => part.kind !== "same" && part.text !== "")).toBe(true);
    }

    theirs.forEach((id, index) => {
      decide(client, [id], index % 2 === 0 ? "accept" : "reject");
    });
    const decided = itemsOf(client).filter((item) => item.kind === "change");
    expect(waitingChanges(decided)).toEqual([]);
    expect(
      decided
        .filter((item) => item.state !== "kept")
        .map((item) => item.id)
        .sort(),
    ).toEqual([...theirs].sort());
    doc.destroy();
  },
  60_000,
);
