/**
 * An AI edit changes only what it says (#2333, #2711): a task that takes no text out never takes a
 * paragraph out on the strength of the reply's quote alone, a reply's own talk never goes into the
 * Note, and Citations that go in after a write never write over a later revision of its Blocks.
 * The model is scripted: no request is paid for.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { EditWithAiInput } from "../../src/core";
import { setUpWithDocuments } from "../helpers/citations";
import { type EditCall, editingModel, type RemovalAnswer, wholeMind } from "../helpers/editing";
import type { MindClient } from "../helpers/mindClient";
import { resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";

let ids = 0;
const paragraph = (value: string): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `only-${++ids}` },
  content: [{ type: "text", text: value }],
});

const FIVE = {
  en: [
    "The harbour office is open on weekdays and posts the tide tables every Monday morning.",
    "Gauge readings are checked twice a week by the duty officer, who logs any drift in a notebook.",
    "A new pontoon was added at the north quay last spring, and it takes boats up to twelve metres.",
    "Visitors must book a mooring through the office at least two days before they arrive.",
    "Fees are charged per night and are lower between November and March.",
  ],
  zh: [
    "港务办公室工作日开放，每周一上午公布潮汐表。",
    "值班员每周检查两次水位计读数，并在笔记本上记录任何偏差。",
    "去年春天在北码头新增了一个浮桥，可停靠十二米以内的船只。",
    "访客须在抵达前至少两天通过办公室预订泊位。",
    "费用按夜收取，十一月至三月较低。",
  ],
} as const;

/** Each paragraph a little shorter: well under half of the text goes. */
const SHORTER = {
  en: [
    "The harbour office is open on weekdays and posts the tide tables every Monday.",
    "Gauge readings are checked twice a week by the duty officer, who logs any drift.",
    "A new pontoon was added at the north quay last spring and takes boats up to twelve metres.",
    "Visitors must book a mooring through the office two days before they arrive.",
    "Fees are charged per night and are lower between November and March.",
  ],
  zh: [
    "港务办公室工作日开放，每周一公布潮汐表。",
    "值班员每周检查两次水位计读数，并记录任何偏差。",
    "去年春天在北码头新增了一个浮桥，可停靠十二米以内的船只。",
    "访客须在抵达前两天通过办公室预订泊位。",
    "费用按夜收取，十一月至三月较低。",
  ],
} as const;

async function noteOf(
  lines: readonly string[],
  reply: (call: EditCall) => string,
  removal: RemovalAnswer = "yes",
) {
  const calls: EditCall[] = [];
  const asked: string[] = [];
  const set = await setUpWithDocuments(editingModel(reply, calls, { removal, asked }), []);
  writeMind(set.client, lines.map(paragraph));
  await set.client.settled();
  return { ...set, calls, asked };
}

/** Edit with AI over all of the Mind's text, as a fixed action (Shorten, Improve, Translate). */
function fixed(
  client: MindClient,
  mindId: string,
  action: EditWithAiInput["action"],
  instruction?: string,
): EditWithAiInput {
  const { instruction: _instruction, ...whole } = wholeMind(client, mindId, "");
  return { ...whole, action, ...(instruction !== undefined && { instruction }) };
}

describe.each(["en", "zh"] as const)("A task that takes no text out (%s)", (language) => {
  const lines = FIVE[language];
  const quoted = (...which: number[]) =>
    lines.map((line, index) => (which.includes(index) ? `<removed>${line}</removed>` : line));

  // protects=a Shorten, Improve or Translate whose reply quotes a whole paragraph as taken out waits for the User, whatever share of the text it is: such a task takes none out, so the quote alone doesn't (#2333 part 5); fails_when=the quoted paragraph is taken out at once; no_claim=how often a real model quotes one.
  test.each([
    { action: "shorten" as const, instruction: undefined },
    { action: "improve" as const, instruction: undefined },
    { action: "translate" as const, instruction: "French" },
  ])("$action: a whole paragraph quoted as taken out waits", async ({ action, instruction }) => {
    const { core, mind, client } = await noteOf(lines, () => quoted(0, 1).join("\n\n"));

    const result = await core.editWithAi(fixed(client, mind.id, action, instruction));

    expect(result).toMatchObject({ kind: "proposed", held: true });
  });

  // protects=a Shorten that quotes nothing applies as it did, and Undo-free: the guard is for the quote alone; fails_when=a Shorten with no quote is held; no_claim=none.
  test("a Shorten that quotes nothing is not held", async () => {
    const { core, mind, client } = await noteOf(lines, () => SHORTER[language].join("\n\n"));

    const result = await core.editWithAi(fixed(client, mind.id, "shorten"));

    expect(result).toMatchObject({ kind: "proposed" });
    expect(result).not.toHaveProperty("held");
    await resolveChanges(client, "accept");
    expect(shownWithChanges(client)).toEqual([...SHORTER[language]]);
  });
});

const TRANSLATED = {
  en: [
    "Le bureau du port est ouvert en semaine et publie les tables des marées chaque lundi matin.",
    "Les relevés des jauges sont vérifiés deux fois par semaine par l'officier de service, qui note toute dérive dans un carnet.",
    "Un nouveau ponton a été ajouté au quai nord au printemps dernier et accueille des bateaux jusqu'à douze mètres.",
    "Les visiteurs doivent réserver un mouillage auprès du bureau au moins deux jours avant leur arrivée.",
    "Les frais sont facturés par nuit et sont moins élevés entre novembre et mars.",
  ],
  zh: [
    "The harbour office is open on weekdays and publishes the tide tables on Monday mornings.",
    "The duty officer checks the gauge readings twice a week and notes any deviation in a notebook.",
    "A pontoon was added at the north quay last spring and takes boats up to twelve metres.",
    "Visitors must reserve a berth through the office at least two days before arriving.",
    "Fees are charged by the night, and are lower from November to March.",
  ],
} as const;

describe.each(["en", "zh"] as const)(
  "A translation writes every paragraph anew (%s)",
  (language) => {
    const lines = FIVE[language];

    // protects=a Translate that writes each of the five paragraphs in the other language applies at once and never waits: its paragraphs are replaced, none is taken out; fails_when=a translation waits because each old paragraph reads as struck and written again (the 3 of 3 held runs of the first over-removal round); no_claim=how a real model translates.
    test("is applied at once", async () => {
      const { core, mind, client } = await noteOf(lines, () => TRANSLATED[language].join("\n\n"));

      const result = await core.editWithAi(
        fixed(client, mind.id, "translate", language === "en" ? "French" : "English"),
      );

      expect(result).toMatchObject({ kind: "proposed" });
      expect(result).not.toHaveProperty("held");
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual([...TRANSLATED[language]]);
    });
  },
);

const REASONING = {
  en: "The passage has five paragraphs. Shortening means fewer words, same facts. I'll keep all five paragraphs but tighten each.",
  zh: "这段话有五个自然段。缩短意味着更少的字，同样的事实。我会保留全部五段，但每段都精简。",
} as const;

describe.each(["en", "zh"] as const)("A reply's own talk to a fixed task (%s)", (language) => {
  const lines = FIVE[language];

  // protects=a line of a reply to Shorten or Improve that talks about the task and says none of the passage's words never goes into the Note, however many paragraphs the reply has and wherever the line stands; fails_when=the line is added as a paragraph; no_claim=how often a real model talks first (1 of 3 runs of #2490's probe).
  test.each([
    { action: "shorten" as const, at: "first" },
    { action: "improve" as const, at: "first" },
    { action: "shorten" as const, at: "last" },
  ])("$action: the talk, $at in the reply, stays out of the Note", async ({ action, at }) => {
    const reply =
      at === "first"
        ? [REASONING[language], ...SHORTER[language]]
        : [...SHORTER[language], REASONING[language]];
    const { core, mind, client } = await noteOf(lines, () => reply.join("\n\n"));

    const result = await core.editWithAi(fixed(client, mind.id, action));
    await resolveChanges(client, "accept");

    expect(result).toMatchObject({ kind: "proposed" });
    expect(shownWithChanges(client)).toEqual([...SHORTER[language]]);
  });

  // protects=a paragraph a reply splits in two keeps both halves, as before: the second is the passage's own words, not talk; fails_when=the second half is dropped; no_claim=how often a model splits.
  test("a paragraph split in two is not talk", async () => {
    const [first = "", second = "", ...rest] = lines;
    const half = Math.floor(first.length / 2);
    const cut = first.slice(0, half);
    const tail = first.slice(half);
    const { core, mind, client } = await noteOf(lines, () =>
      [cut, tail, second, ...rest].join("\n\n"),
    );

    await core.editWithAi(fixed(client, mind.id, "improve"));
    await resolveChanges(client, "accept");

    expect(shownWithChanges(client).join("")).toContain(tail);
  });
});

describe.each(["en", "zh"] as const)(
  "A request in the User's words and a paragraph quoted as taken out (%s)",
  (language) => {
    const lines = FIVE[language];
    const SHORT_ASK = { en: "Make it shorter.", zh: "把它改短一些。" }[language];
    const DELETE_ASK = { en: "Delete the first two paragraphs.", zh: "把前两段删掉。" }[language];
    const wholeQuoted = () =>
      [`¶1 <removed>${lines[0]}</removed>`, `¶2 <removed>${lines[1]}</removed>`].join("\n\n");

    // protects=a request that asks for no text to go, whose reply quotes a whole paragraph as taken out, waits for the User: the small model reads the User's words alone, once, and says no; fails_when=the paragraph is taken out at once; or the passage goes to the small model; no_claim=how often a real model quotes one (1 of 3 runs of #2490's probe).
    test("words that don't ask for a removal: the quoted paragraphs wait", async () => {
      const { core, mind, client, asked } = await noteOf(lines, wholeQuoted, "no");

      const result = await core.editWithAi(wholeMind(client, mind.id, SHORT_ASK));

      expect(result).toMatchObject({ kind: "proposed", held: true });
      expect(asked).toHaveLength(1);
      // Only the User's words go to the small model, never the passage.
      expect(asked[0]).toContain(SHORT_ASK);
      expect(asked[0]).not.toContain(lines[0]);
    });

    // protects=a request whose words ask for text to go keeps taking the quoted paragraphs out at once, as before (#2180); fails_when=an asked deletion waits; no_claim=how a model reads other phrasings.
    test("words that ask for a removal: the quoted paragraphs go at once", async () => {
      const { core, mind, client, asked } = await noteOf(lines, wholeQuoted, "yes");

      const result = await core.editWithAi(wholeMind(client, mind.id, DELETE_ASK));

      expect(result).toMatchObject({ kind: "proposed" });
      expect(result).not.toHaveProperty("held");
      expect(asked).toHaveLength(1);
    });

    // protects=a removal waits when the small model can't be asked or can't be read: it never applies on no answer; fails_when=a removal applies when the question failed or was unreadable; no_claim=why it failed.
    test.each(["fails", "unreadable"] as const)(
      "the question %s: the quoted paragraphs wait",
      async (removal) => {
        const { core, mind, client } = await noteOf(lines, wholeQuoted, removal);

        const result = await core.editWithAi(wholeMind(client, mind.id, DELETE_ASK));

        expect(result).toMatchObject({ kind: "proposed", held: true });
      },
    );

    // protects=a reply that names no paragraph and quotes the last one as taken out is read the same: words that ask for no removal wait for the User, as the window's scripted model writes it; fails_when=a nameless quote of a whole paragraph applies unasked; no_claim=how often a real model leaves out the names.
    test("a nameless reply that quotes the last paragraph: the quote waits", async () => {
      const keep = lines.slice(0, -1).join("\n\n");
      const { core, mind, client, asked } = await noteOf(
        lines,
        () => `${keep}\n\n<removed>${lines.at(-1)}</removed>`,
        "no",
      );

      const result = await core.editWithAi(wholeMind(client, mind.id, SHORT_ASK));

      expect(result).toMatchObject({ kind: "proposed", held: true });
      expect(asked).toHaveLength(1);
    });

    // protects=the question is asked only when a reply quotes a whole paragraph: a sentence quoted from a paragraph, or no quote at all, asks nothing; fails_when=every edit asks the small model; no_claim=none.
    test("a part quote, or no quote, asks nothing", async () => {
      const [first = ""] = lines;
      const sentence = first.slice(0, Math.min(18, first.length));
      const part = await noteOf(
        lines,
        () => `¶1 <removed>${sentence}</removed>${first.slice(sentence.length)}`,
        "no",
      );
      await part.core.editWithAi(wholeMind(part.client, part.mind.id, SHORT_ASK));
      expect(part.asked).toHaveLength(0);

      const none = await noteOf(lines, () => `¶1 ${first}`, "no");
      await none.core.editWithAi(wholeMind(none.client, none.mind.id, SHORT_ASK));
      expect(none.asked).toHaveLength(0);
    });
  },
);

const SUMMARY = {
  en: [
    "The survey team is two people and a volunteer.",
    "It used 14 stations along the north shore.",
    "The approved survey budget is £182,500.",
    "The report is due on 12 December.",
  ],
  zh: [
    "测量组有两名成员和一名志愿者。",
    "共使用了北岸沿线的14个测量站。",
    "获批的测量预算为182,500英镑。",
    "报告须于12月12日提交。",
  ],
} as const;
const MERGED = {
  en: "It used 14 stations along the north shore, on a budget of £182,500.",
  zh: "共使用了北岸沿线的14个测量站，预算为182,500英镑。",
} as const;

describe.each(["en", "zh"] as const)("A rewrite that merges two paragraphs (%s)", (language) => {
  const lines = SUMMARY[language];
  const ASK = { en: "Make the summary shorter.", zh: "把摘要改短一些。" }[language];

  // protects=a merge that names both old paragraphs, the first replaced by the merged text and the second quoted as taken out, leaves no sentence of the old text standing beside its new version once the User applies it; the removal waits, since the words of the second are not all in the merged text; fails_when=the old paragraph stays beside the merged one, or the merge applies unseen; no_claim=how often a real model merges (the 2026-11-07 walk).
  test("both named: the merged text stands alone once applied, and it waits", async () => {
    const { core, mind, client } = await noteOf(
      lines,
      () => `¶2 ${MERGED[language]}\n\n¶3 <removed>${lines[2]}</removed>`,
      "no",
    );

    const result = await core.editWithAi(wholeMind(client, mind.id, ASK));
    await resolveChanges(client, "accept");

    expect(result).toMatchObject({ kind: "proposed", held: true });
    expect(shownWithChanges(client)).toEqual([lines[0], MERGED[language], lines[3]]);
  });
});
