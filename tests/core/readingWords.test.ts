import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Document } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { wholeMind } from "../helpers/editing";
import { resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/*
 * How an edit reads the User's words against the reply's (#2589): a space or a line break parts
 * two words only where there is one, never where another inline node stands between two letters;
 * and a character is read whole, as Unicode composes it, whatever UTF-16 units or marks it is typed
 * with. So a line the reply writes as it was, with its Citation, formula, footnote or line break,
 * reads the same, and a quote that joins or parts other words, or cuts a character, takes nothing out.
 */

const NOTES = {
  name: "Fees.md",
  contents: ["# Fees", "", "Fees and rates are paid every month by card."].join("\n"),
};

let ids = 0;
const text = (value: string): JSONContent => ({ type: "text", text: value });
const block = (...content: JSONContent[]): JSONContent => ({
  type: "paragraph",
  attrs: { id: `block-${++ids}` },
  content,
});

/** A Citation of the Fees Document, as a Note holds one copied from an Answer. */
const citation = (fees: Document): JSONContent => ({
  type: "citation",
  attrs: {
    passageId: "passage-1",
    documentId: fees.id,
    documentName: "Fees",
    contentHash: fees.contentHash,
    pageFrom: null,
    pageTo: null,
    quote: "Fees and rates are paid every month by card",
    check: "found",
    checkReason: null,
  },
});

interface Atom {
  name: string;
  node: (fees: Document) => JSONContent;
  /** How the passage shows it, and the reply writes it back. */
  shown: string;
}

const ATOMS: readonly Atom[] = [
  { name: "a Citation", node: citation, shown: "[1]" },
  {
    name: "a footnote",
    node: () => ({ type: "footnote", attrs: { id: "fn-1" }, content: [text("Paid by card.")] }),
    shown: "[^1]",
  },
  { name: "a formula", node: () => ({ type: "inlineMath", attrs: { latex: "x" } }), shown: "$x$" },
  { name: "a line break", node: () => ({ type: "hardBreak" }), shown: "\n" },
];

/** A Note whose second line has `atom` between two Latin letters, and a reply that keeps or rewrites that line. */
const LINES = {
  en: {
    first: "Rates are monthly.",
    around: ["Fees and rates are", "monthly."],
    rewritten: "paid monthly.",
    last: "Fees are monthly.",
    added: "Gym fees are monthly.",
    asked: "Add a line on gym fees at the top; keep the existing lines.",
  },
  zh: {
    first: "税费按月支付。",
    around: ["费用和税费按 VAT", "tax 月付。"],
    rewritten: "tax 每月付。",
    last: "费用按月支付。",
    added: "保险费按月支付。",
    asked: "在最上面加一行保险费，原有的各行都保留。",
  },
} as const;

function replyFor(language: "en" | "zh", atom: Atom, keeps: boolean): string {
  const lines = LINES[language];
  const second = `${lines.around[0]}${atom.shown}${keeps ? lines.around[1] : lines.rewritten}`;
  return [lines.added, second, lines.last].join("\n\n");
}

async function onNote(
  language: "en" | "zh",
  atom: Atom,
  reply: (call: ModelCall) => ScriptedReply,
) {
  const set = await setUpWithDocuments(scriptedModel(reply), [NOTES]);
  const fees = set.documents[0] as Document;
  const lines = LINES[language];
  writeMind(set.client, [
    block(text(lines.first)),
    block(text(lines.around[0]), atom.node(fees), text(lines.around[1])),
    block(text(lines.last)),
  ]);
  await set.client.settled();
  return set;
}

const CASES = (["en", "zh"] as const).flatMap((language) =>
  ATOMS.flatMap((atom) =>
    [true, false].map((keeps) => ({
      language,
      atom,
      keeps,
      name: atom.name,
      how: keeps ? "writes as it was" : "rewrites",
    })),
  ),
);

describe("An inline node between two letters reads the same in the Note and the reply (#2589)", {
  timeout: 30_000,
}, () => {
  test.each(CASES)(
    "$language, $name in a line the reply $how, through Edit with AI",
    async ({ language, atom, keeps }) => {
      const reply = replyFor(language, atom, keeps);
      const { core, mind, client } = await onNote(language, atom, (call) =>
        /<passage>\n/.test(call.prompt) ? { text: `${reply}\n<why>Done.</why>` } : { text: "OK." },
      );

      await core.editWithAi(wholeMind(client, mind.id, LINES[language].asked));
      await client.settled();
      await resolveChanges(client, "accept");

      // Kept as it was, the line after says nothing of the first, which stays; rewritten, it reads
      // as a rename, and the first takes the reply's first (the residue of a rename's shape).
      expect(shownWithChanges(client).includes(LINES[language].first)).toBe(keeps);
    },
  );

  test.each(CASES)(
    "$language, $name in a line the reply $how, through the assistant",
    async ({ language, atom, keeps }) => {
      const reply = replyFor(language, atom, keeps);
      const { core, mind, client } = await onNote(language, atom, (call) => {
        if (/<passage>\n/.test(call.prompt)) return { text: `${reply}\n<why>Done.</why>` };
        return call.results.length === 0
          ? { calls: [{ tool: "edit_mind", input: { instruction: LINES[language].asked } }] }
          : { text: "Done." };
      });

      await askAssistant(core, { text: LINES[language].asked, mindId: mind.id });
      await client.settled();
      await resolveChanges(client, "accept");

      expect(shownWithChanges(client).includes(LINES[language].first)).toBe(keeps);
    },
  );
});

/** A Note with a line break between two letters, a space before it or none, and a reply that writes that line again with a space or none. */
const BREAKS = (["en", "zh"] as const).flatMap((language) =>
  [
    { how: "adds a space before the line break", note: "", written: " " },
    { how: "adds two spaces before it, as Markdown writes one", note: "", written: "  " },
    { how: "drops the space the Note has before it", note: " ", written: "" },
    { how: "writes it as it was, with its space", note: " ", written: " " },
  ].flatMap((each) =>
    (["Edit with AI", "the assistant"] as const).map((path) => ({ language, path, ...each })),
  ),
);

describe("A line break parts two words as a space does, in the Note and the reply (#2589)", {
  timeout: 30_000,
}, () => {
  test.each(BREAKS)("$language, a reply that $how, through $path", async (each) => {
    const lines = LINES[each.language];
    const second = `${lines.around[0]}${each.written}\n${lines.around[1]}`;
    const reply = [lines.added, second, lines.last].join("\n\n");
    const { core, mind, client } = await setUpWithDocuments(
      scriptedModel((call: ModelCall): ScriptedReply => {
        if (/<passage>\n/.test(call.prompt)) return { text: `${reply}\n<why>Done.</why>` };
        return call.results.length === 0
          ? { calls: [{ tool: "edit_mind", input: { instruction: lines.asked } }] }
          : { text: "Done." };
      }),
      [],
    );
    writeMind(client, [
      block(text(lines.first)),
      block(text(`${lines.around[0]}${each.note}`), { type: "hardBreak" }, text(lines.around[1])),
      block(text(lines.last)),
    ]);
    await client.settled();

    if (each.path === "Edit with AI")
      await core.editWithAi(wholeMind(client, mind.id, lines.asked));
    else await askAssistant(core, { text: lines.asked, mindId: mind.id });
    await client.settled();
    await resolveChanges(client, "accept");

    const shown = shownWithChanges(client);
    expect(shown).toContain(lines.added);
    expect(shown).toContain(lines.first);
  });
});

interface Quoted {
  case: string;
  line: string;
  quote: string;
}

/** Quotes whose words differ from the line's: they take nothing out, and the edit is refused. */
const REFUSED: readonly Quoted[] = [
  {
    case: "en, decomposed accents run together",
    line: "The résumé is ready.",
    quote: "The résuméis ready.",
  },
  {
    case: "en, letters outside the Basic Plane run together",
    line: "The label is 𝐧𝐨𝐰 𝐡𝐞𝐫𝐞.",
    quote: "The label is 𝐧𝐨𝐰𝐡𝐞𝐫𝐞.",
  },
  {
    case: "en, other letters, accented the same",
    line: "The résumé is ready.",
    quote: "The resume is ready.",
  },
  {
    case: "zh, an accented Latin word in a Chinese line run together",
    line: "简历写成 résumé here 两个词。",
    quote: "简历写成 résuméhere 两个词。",
  },
  {
    case: "ko, two Hangul words run together",
    line: "열쇠는 여기 있다.",
    quote: "열쇠는여기 있다.",
  },
  {
    case: "hi, two words with vowel signs run together",
    line: "किताब यहाँ है।",
    quote: "किताबयहाँ है।",
  },
  {
    case: "hi, a word quoted without the signs that end its last character",
    line: "किताबें यहाँ हैं।",
    quote: "किताब",
  },
  {
    case: "en, an emoji quoted without its skin tone",
    line: "Great work 👍🏽",
    quote: "Great work 👍",
  },
  {
    case: "en, an emoji quoted from the middle of its joined family",
    line: "The 👨‍👩‍👧 family is here.",
    quote: "👩‍👧 family is here.",
  },
];

/** Quotes of the line's own words, however their characters are typed: the line goes. */
const TAKEN: readonly Quoted[] = [
  {
    case: "en, decomposed accents as written",
    line: "The résumé is ready.",
    quote: "The résumé is ready.",
  },
  {
    case: "en, composed accents quoted decomposed",
    line: "The résumé is ready.",
    quote: "The résumé is ready.",
  },
  {
    case: "en, letters outside the Basic Plane as written",
    line: "The label is 𝐧𝐨𝐰 𝐡𝐞𝐫𝐞.",
    quote: "The label is 𝐧𝐨𝐰 𝐡𝐞𝐫𝐞.",
  },
  {
    case: "en, an emoji joined with zero-width joiners",
    line: "The team 👨‍👩‍👧 is here.",
    quote: "The team 👨‍👩‍👧 is here.",
  },
  {
    case: "en, a sign with a variation selector",
    line: "Mark ✔️ when done.",
    quote: "Mark ✔️ when done.",
  },
  {
    case: "ko, Hangul syllables quoted as their letters",
    line: "열쇠는 여기 있다.",
    quote: "열쇠는 여기 있다.".normalize("NFD"),
  },
  { case: "hi, words with vowel signs as written", line: "किताब यहाँ है।", quote: "किताब यहाँ है।" },
  { case: "zh, a character outside the Basic Plane", line: "𠀋字在这里。", quote: "𠀋字在这里。" },
  {
    case: "zh, a Latin word with a space beside Chinese",
    line: "请使用 Excel 表格记账。",
    quote: "请使用Excel表格记账。",
  },
];

/** Quotes of whole words of a line, which end or start beside a character of several UTF-16 units: those words go. */
const PARTS: readonly (Quoted & { after: string })[] = [
  {
    case: "hi, a word quoted with the signs that end its last character",
    line: "किताबें यहाँ हैं।",
    quote: "किताबें",
    after: "यहाँ हैं।",
  },
  {
    case: "en, an emoji quoted with its skin tone",
    line: "Great work 👍🏽 today.",
    quote: "Great work 👍🏽",
    after: "today.",
  },
  {
    case: "en, an emoji quoted with its whole joined family",
    line: "The 👨‍👩‍👧 family is here.",
    quote: "👨‍👩‍👧 family is here.",
    after: "The",
  },
];

const OTHERS = ["Rent is monthly.", "Water is quarterly."] as const;

async function quoting(each: Quoted, path: "editWithAi" | "assistant") {
  const reply = `<removed>${each.quote}</removed>`;
  const { core, mind, client } = await setUpWithDocuments(
    scriptedModel((call: ModelCall): ScriptedReply => {
      if (/<passage>\n/.test(call.prompt)) return { text: `${reply}\n<why>Done.</why>` };
      return call.results.length === 0
        ? { calls: [{ tool: "edit_mind", input: { instruction: "Delete that sentence." } }] }
        : { text: "Done." };
    }),
    [],
  );
  writeMind(client, [block(text(OTHERS[0])), block(text(each.line)), block(text(OTHERS[1]))]);
  await client.settled();
  if (path === "editWithAi")
    await core.editWithAi(wholeMind(client, mind.id, "Delete that sentence."));
  else await askAssistant(core, { text: "Delete that sentence.", mindId: mind.id });
  await client.settled();
  await resolveChanges(client, "accept");
  return shownWithChanges(client);
}

describe("A quote is read as its characters compose, its words parted where they are (#2589)", {
  timeout: 30_000,
}, () => {
  for (const path of ["editWithAi", "assistant"] as const) {
    test.each(REFUSED)(`$case takes nothing out, ${path}`, async (each) => {
      expect(await quoting(each, path)).toEqual([OTHERS[0], each.line, OTHERS[1]]);
    });

    test.each(TAKEN)(`$case takes the line out, ${path}`, async (each) => {
      expect(await quoting(each, path)).toEqual([...OTHERS]);
    });

    test.each(PARTS)(`$case takes those words out, ${path}`, async (each) => {
      expect(await quoting(each, path)).toEqual([OTHERS[0], each.after, OTHERS[1]]);
    });
  }
});

/** A line with no words of its own between two kept ones, written again by the reply in other Unicode forms. */
const RETYPED = [
  {
    case: "en, composed accents written again decomposed",
    lines: ["The résumé fees are due.", "The résumé is due.", "The résumé fees and forms are due."],
    changed: "The résumé fees and forms are due in May.",
  },
  {
    case: "ko, Hangul syllables written again as their letters",
    lines: ["열쇠 비용은 매달 낸다.", "열쇠는 매달 낸다.", "열쇠 비용과 열쇠는 매달 낸다."],
    changed: "열쇠 비용과 열쇠는 오월부터 매달 낸다.",
  },
] as const;

describe("A line the reply writes as it was reads the same, however its characters are typed (#2589)", {
  timeout: 30_000,
}, () => {
  test.each(RETYPED)("$case, through Edit with AI", async (each) => {
    const reply = [each.lines[0], each.lines[1].normalize("NFD"), each.changed].join("\n\n");
    const { core, mind, client } = await setUpWithDocuments(
      scriptedModel(
        (call: ModelCall): ScriptedReply =>
          /<passage>\n/.test(call.prompt)
            ? { text: `${reply}\n<why>Done.</why>` }
            : { text: "OK." },
      ),
      [],
    );
    writeMind(
      client,
      each.lines.map((line) => block(text(line))),
    );
    await client.settled();

    await core.editWithAi(wholeMind(client, mind.id, "Change the last line."));
    await client.settled();
    await resolveChanges(client, "accept");

    expect(shownWithChanges(client).map((line) => line.normalize("NFC"))).toEqual([
      each.lines[0],
      each.lines[1],
      each.changed,
    ]);
  });
});
