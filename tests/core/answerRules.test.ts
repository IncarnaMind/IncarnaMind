/**
 * Two things a careful reader catches (#548). Each Passage handed to the
 * model carries its Document's date: the date it states (its reference
 * record's, else a year its text writes), else the file's creation or last
 * modified day, named as the file's. And every way of answering is told to say first when the Question
 * takes for granted what the Passages don't say, and to lead with the newer of
 * two Documents that disagree, with examples in English and Chinese.
 */
import { utimes } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createCitationSession } from "../../src/core/answers/citations";
import {
  bracketedAmountsNote,
  datedDocumentsNote,
  documentInstructions,
  fileDatesNote,
} from "../../src/core/answers/prompt";
import { askAndFinish, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { type ModelCall, scriptedModel } from "../helpers/models";

/** A phrase of each rule, and of each rule's Chinese example. */
const RULES = [
  "If the Question takes for granted what the Passages don't say",
  "未在文档中找到董事会批准的记录",
  "give different figures for the same thing (one updates the other), lead with the newer Document by its date (a Passage's date, else its file-created or file-modified date)",
  "较早的手册（2024 年 1 月）写的是 6 小时",
];

const QUESTION = "How many hours of outage must be reported?";

/** What the model was sent: each request's system prompt, and what its searches returned. */
interface Seen {
  system: string[];
  results: string[];
}

/** A model that calls Tools: it searches once, then answers. */
function searchingModel(seen: Seen) {
  return scriptedModel((call: ModelCall) => {
    seen.system.push(call.system);
    const searches = call.results.filter((result) => result.tool === "search_documents");
    if (searches.length === 0) {
      return { calls: [{ tool: "search_documents", input: { query: "outages reported" } }] };
    }
    seen.results.push(...searches.map((result) => result.text));
    return { text: "Outages over 4 hours must be reported." };
  });
}

/** A model that can't call Tools: it answers from one search, with structured output when `json`. */
function oneSearchModel(seen: Seen, json: boolean) {
  return scriptedModel((call: ModelCall) => {
    seen.system.push(call.system);
    if (call.tools.length > 0) {
      return { error: { status: 400, message: "this model does not support tools" } };
    }
    if (call.json && !json) {
      return { error: { status: 400, message: "response_format is not supported" } };
    }
    const answer = "Outages over 4 hours must be reported.";
    return { text: call.json ? JSON.stringify({ answer, citations: [] }) : answer };
  });
}

/**
 * Three Documents that disagree: a memo whose text states its year, a
 * handbook that states none (its file was last modified on 1 March 2024),
 * and a circular whose reference record the User dated November 2023.
 */
async function setUp(model: ReturnType<typeof scriptedModel>) {
  const setup = await setUpWithDocuments(model, []);
  const sources = await createTempDataFolder();
  const memo = await writeSourceFile(
    sources,
    "Outage memo.md",
    "# Outage reporting memo\n\nIssued 14 May 2025. Outages over 4 hours must be reported.\n",
  );
  const handbook = await writeSourceFile(
    sources,
    "Operations handbook.md",
    "# Operations handbook\n\nOutages over 6 hours must be reported.\n",
  );
  const circular = await writeSourceFile(
    sources,
    "Circular.md",
    "# Circular\n\nOutages over 8 hours must be reported.\n",
  );
  const march = new Date("2024-03-01T12:00:00Z");
  await utimes(handbook, march, march);
  const added = await addAndProcess(setup.core, [memo, handbook, circular]);
  const dated = added.find((document) => document.name === "Circular");
  if (!dated) throw new Error("The circular wasn't added.");
  await setup.core.updateReference(dated.id, { issued: "2023-11" });
  return setup;
}

const datesIn = (text: string) =>
  Object.fromEntries(shownPassages(text).map((passage) => [passage.document, passage.date]));

const EXPECTED_DATES = {
  "Outage memo": 'date="2025"',
  "Operations handbook": 'file-modified="2024-03-01"',
  Circular: 'date="2023-11"',
};

describe("The Passages handed to the model", { timeout: 30_000 }, () => {
  test("carry their Document's date: the date it states, else the day its file was modified, named as the file's", async () => {
    const seen: Seen = { system: [], results: [] };
    const { core, client, mind } = await setUp(searchingModel(seen));

    const { finished } = await askAndFinish(core, client, mind.id, QUESTION);

    expect(finished.citationSupport).toBe("tools");
    expect(datesIn(seen.results.join("\n\n"))).toEqual(EXPECTED_DATES);
  });

  test.each([
    ["structured-output", true],
    ["none", false],
  ] as const)("carry it in one search's Passages too (%s)", async (support, json) => {
    const seen: Seen = { system: [], results: [] };
    const { core, client, mind } = await setUp(oneSearchModel(seen, json));

    const { finished } = await askAndFinish(core, client, mind.id, QUESTION);

    expect(finished.citationSupport).toBe(support);
    expect(datesIn(seen.system.at(-1) ?? "")).toEqual(EXPECTED_DATES);
  });

  test("carry no date when none is known", async () => {
    const passage = (documentId: string, documentName: string) => ({
      passageId: `${documentId}-1`,
      documentId,
      documentName,
      documentKind: "markdown" as const,
      contentHash: "v1",
      pageFrom: null,
      pageTo: null,
      position: 0,
      seq: 0,
      windowFrom: 0,
      windowTo: 0,
      text: "Outages over 4 hours must be reported.",
    });
    const session = createCitationSession(
      {
        searchableCount: () => 2,
        search: async () => [passage("memo", "Memo"), passage("note", "Note")],
        citationSource: () => null,
        pageTexts: () => [],
        documentDate: (documentId) =>
          documentId === "memo" ? { date: "2025-05-14", of: "document" } : null,
      },
      { onRecord: () => undefined },
    );

    const { text } = await session.tools.searchDocuments("outages");

    expect(datesIn(text)).toEqual({ Memo: 'date="2025-05-14"', Note: null });
    expect(text).toContain('<passage id="P2" document="Note">');
  });
});

describe("The Answer instructions", { timeout: 30_000 }, () => {
  test.each([
    ["English", QUESTION],
    ["Chinese", "停电超过几个小时必须报告？"],
  ])("have both rules for a Question in %s", async (_language, question) => {
    const seen: Seen = { system: [], results: [] };
    const { core, client, mind } = await setUp(searchingModel(seen));

    await askAndFinish(core, client, mind.id, question);

    const system = seen.system[0] ?? "";
    for (const rule of RULES) expect(system).toContain(rule);
  });

  test("ask for a table's cells of about eight words, with a quote in its Citation, as the panel is narrow (#1382)", async () => {
    const seen: Seen = { system: [], results: [] };
    const { core, client, mind } = await setUp(searchingModel(seen));

    await askAndFinish(core, client, mind.id, "Compare the three Documents in a table.");

    expect(seen.system[0]).toContain(
      "the panel is narrow, so a cell holds about eight words, or 16 Chinese characters, and a quote belongs in its Citation, not in a cell",
    );
  });

  test.each(["tools", "structured-output", "none"] as const)(
    "have both rules when answering with %s, with markers only where the Answer cites",
    (mode) => {
      const text = documentInstructions(mode, { total: 2, names: ["Memo", "Handbook"] }, "");

      for (const rule of RULES) expect(text).toContain(rule);
      expect(text.includes("says 6 hours[^2]")).toBe(mode !== "none");
      if (mode === "none") expect(text).not.toContain("[^");
    },
  );

  // protects=every way of citing is told a cited sentence says only what its quote supports, and the way with no Citations isn't; fails_when=a mode loses the rule or the one that doesn't cite gets it; no_claim=none beyond protects.
  test.each([
    ["tools", true],
    ["structured-output", true],
    ["none", false],
  ] as const)(
    "when answering with %s, a cited sentence says only what its quote supports: %s",
    (mode, cites) => {
      const text = documentInstructions(mode, { total: 1, names: ["Memo"] }, "");

      expect(text.includes("A sentence with a Citation says only what its quote supports.")).toBe(
        cites,
      );
    },
  );

  // protects=an Answer told some of the Library's Documents is told the Library's whole count, and one told all of them is told no count twice (#1333); fails_when=the count is the scope's alone, so a reply says the Library holds that many; no_claim=none beyond protects.
  test.each(["tools", "structured-output", "none"] as const)(
    "with %s, give the Library's count when it holds more Documents than the Answer can use (#1333)",
    (mode) => {
      const listed = { total: 1, names: ["Harbour lease"] };
      const library = { total: 3, examples: true };
      const text = documentInstructions(mode, listed, "", false, false, false, { library });
      expect(text).toContain(
        "The User's Library holds 3 Documents, and this Answer can use 1 of them",
      );
      expect(text).toContain(
        "Documents of an example IncarnaMind made are in the Library too, and aren't the User's own work: leave them out.",
      );
      expect(text).toContain("Never say the Library holds fewer Documents than 3.");
      expect(text).toContain(
        "When the Question names more Documents than this Answer can use, say in one sentence which you used and why, or ask which ones in one line.",
      );

      const scoped = documentInstructions(mode, listed, "", true, false, false, {
        library: { total: 3, examples: false },
      });
      expect(scoped).toContain(
        "The User limited this Question to 1 Document of the 3 in their Library",
      );
      expect(scoped).not.toContain("are in the Library too");

      const all = documentInstructions(
        mode,
        { total: 3, names: ["A", "B", "C"] },
        "",
        false,
        false,
        false,
        { library: { total: 3, examples: false } },
      );
      expect(all).toContain("The User has added 3 Documents");
      expect(all).not.toContain("Library holds");
    },
  );

  test.each(["tools", "structured-output", "none"] as const)(
    "when answering with %s, absence is about the search unless the relevant pages were read",
    (mode) => {
      const text = documentInstructions(mode, { total: 1, names: ["Memo"] }, "");

      expect(text).toContain("I didn't find");
      if (mode === "tools") {
        expect(text).toContain("Document absence needs read_document.");
      } else {
        expect(text).toContain("Never claim Document absence.");
      }
    },
  );

  test.each(["tools", "structured-output", "none"] as const)(
    "when answering with %s, stop where the Documents stop: own knowledge only for a general Question, labelled, with no figures",
    (mode) => {
      const text = documentInstructions(mode, { total: 1, names: ["Memo"] }, "");

      expect(text).toContain("If the Documents don't cover the Question, say \"I didn't find");
      expect(text).toContain("never fill the gap from your own knowledge");
      expect(text).toContain('starts "Not from your Documents:" ("以下内容不是来自你的文档：")');
      expect(text).not.toContain("answer from your own knowledge if you can");
      // The premise rule's "then answer from what they say" is the Passages, never the model's own knowledge.
      expect(text).toContain("then answer from what they say");
      expect(text).toContain("You may add what the Passages do say that comes closest");
    },
  );
});

/** Passages as the search Tool formats them: each with its Document, and its date when known. */
const handed = (...documents: readonly [string, string | null][]) =>
  documents
    .map(
      ([document, date], index) =>
        `<passage id="P${index + 1}" document="${document}"${date ? ` date="${date}"` : ""} pages="1">\nOutages must be reported.\n</passage>`,
    )
    .join("\n\n");

describe("The note on amounts in brackets (#978)", () => {
  const handed = (line: string) => `<passage id="P1" document="Statement">\n${line}\n</passage>`;

  test.each([
    ["Less: agent's fee (4,620.00)"],
    ["Less: legal fees (£1,500.00)"],
    ["Net cash flow | （1,250.5）"],
    ["Interest paid ( 340.50 )"],
    ["Net loss\t($1.2bn)"],
  ])("follows Passages in which the reader finds a negative in brackets: %s", (line) => {
    expect(bracketedAmountsNote(handed(line))).toMatch(
      /^An amount in brackets in these Passages is negative.*括号里的金额是负数/,
    );
  });

  test.each([
    ["Report outages over 4 hours (see the memo)."],
    ["Founded in 1998 (the second year of the programme) in Leeds."],
    ["The memo (2023) and the handbook (note 4) apply, see (p. 12)."],
    ["Items (1) and (2) apply, and section 1159(10)."],
    ["Fees of 4,620.00 are due."],
    ["Legal fees (250) were paid."],
    ["The fund (£2.1bn) invested in 12 properties (£4.5m)."],
    ["No Passages in the User's Documents match this search."],
  ])("is left out of Passages in which it finds none: %s", (line) => {
    expect(bracketedAmountsNote(handed(line))).toBe("");
  });

  test("is in the instructions of a model without Tools, after its Passages, and not in a Question's instructions otherwise", () => {
    const listed = { total: 1, names: ["Statement"] };
    const passages = handed("Less: fees (4,620.00)");
    for (const mode of ["structured-output", "none"] as const) {
      expect(documentInstructions(mode, listed, passages)).toContain(
        "is negative, as accountants write it",
      );
    }
    expect(documentInstructions("tools", listed)).not.toContain("accountants");
    expect(documentInstructions("none", listed, handed("Plain text."))).not.toContain(
      "accountants",
    );
  });
});

describe("The note on Documents of different dates (#660)", { timeout: 30_000 }, () => {
  const NOTE = "These Passages come from Documents of different dates:";

  test("names each dated Document with its date, newest first, and reminds the model to name the older one", () => {
    expect(
      datedDocumentsNote(
        handed(
          ["Handbook", "2024-03-01"],
          ["Memo", "2025"],
          ["Memo", "2025"],
          ["Circular", "2023-11"],
        ),
      ),
    ).toBe(
      `${NOTE} "Memo" (2025), "Handbook" (2024-03-01), "Circular" (2023-11). Take each Document's figure only from a sentence that states it for that Document, never from a passing mention. Where they give different figures for the same thing, lead with the newer Document, then write one sentence naming the older one, its date and its figure, with a Citation.`,
    );
  });

  test("is left out for one Document, for Documents of the same date, and for undated ones", () => {
    expect(datedDocumentsNote(handed(["Memo", "2025"]))).toBe("");
    expect(datedDocumentsNote(handed(["Memo", "2025"], ["Memo", "2025"]))).toBe("");
    expect(datedDocumentsNote(handed(["Memo", "2024-03-01"], ["Handbook", "2024-03-01"]))).toBe("");
    expect(datedDocumentsNote(handed(["Memo", "2025"], ["Handbook", null]))).toBe("");
    expect(datedDocumentsNote("No Passages in the User's Documents match this search.")).toBe("");
  });

  test("follows a Tool-loop search's Passages when they come from Documents of different dates, before the note on a file's date", async () => {
    const seen: Seen = { system: [], results: [] };
    const { core, client, mind } = await setUp(searchingModel(seen));

    await askAndFinish(core, client, mind.id, QUESTION);

    const [result = ""] = seen.results;
    expect(
      result.endsWith(
        `${NOTE} "Outage memo" (2025), "Operations handbook" (file modified 2024-03-01), "Circular" (2023-11). Take each Document's figure only from a sentence that states it for that Document, never from a passing mention. Where they give different figures for the same thing, lead with the newer Document, then write one sentence naming the older one, its date and its figure, with a Citation.\n\n${fileDatesNote(result)}`,
      ),
    ).toBe(true);
  });

  test("isn't added when the Passages handed are from Documents of one date", async () => {
    const seen: Seen = { system: [], results: [] };
    const setup = await setUpWithDocuments(searchingModel(seen), []);
    const sources = await createTempDataFolder();
    const day = new Date("2024-03-01T12:00:00Z");
    const paths = await Promise.all(
      ["Shift notes.md", "Night notes.md"].map(async (name) => {
        const path = await writeSourceFile(
          sources,
          name,
          `# ${name}\n\nOutages over 6 hours must be reported.\n`,
        );
        await utimes(path, day, day);
        return path;
      }),
    );
    await addAndProcess(setup.core, paths);

    await askAndFinish(setup.core, setup.client, setup.mind.id, QUESTION);

    expect(shownPassages(seen.results.join("\n\n")).map((passage) => passage.date)).toEqual([
      'file-modified="2024-03-01"',
      'file-modified="2024-03-01"',
    ]);
    expect(seen.results.join("\n")).not.toContain(NOTE);
  });

  test("follows one search's Passages in the instructions of a model that can't call Tools", async () => {
    const seen: Seen = { system: [], results: [] };
    const { core, client, mind } = await setUp(oneSearchModel(seen, true));

    await askAndFinish(core, client, mind.id, QUESTION);

    expect(seen.system.at(-1)).toContain(`${NOTE} "Outage memo" (2025)`);
  });
});
