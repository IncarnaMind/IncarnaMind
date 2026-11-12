import { describe, expect, test } from "vitest";
import { namesIn } from "../../src/core/meetings/names";

describe("Names in a Meeting's Note and its Folder's Documents (#1031)", () => {
  test("English: runs of capitalised words, but not a sentence's or a list item's first word", () => {
    const note = [
      "Renewal call with Harbor Logistics",
      "Attendees: Marcus (Harbor Logistics), Priya Raman, Lumen Foods",
      "- Review the Rotterdam warehouse plan with Sofia Lindqvist.",
      "Daniel Weiss signs off. The contract goes to Daniel by Wednesday.",
    ].join("\n");
    expect([...namesIn(note).names]).toEqual([
      ["Harbor Logistics", 2],
      ["Marcus", 1],
      ["Priya Raman", 1],
      ["Lumen Foods", 1],
      ["Rotterdam", 1],
      ["Sofia Lindqvist", 1],
      ["Daniel Weiss", 1],
      ["Daniel", 1],
    ]);
    const { names } = namesIn(note);
    expect(names.has("Renewal")).toBe(false);
    expect(names.has("Review")).toBe(false);
    expect(names.has("Wednesday")).toBe(false);
  });

  test("English: a name's joining words are kept, a heading's words are not", () => {
    const { names } = namesIn(
      "Clients are Bank of America and Procter & Gamble. See Table 3 on Page 2.",
    );
    expect([...names.keys()]).toEqual(["Bank of America", "Procter & Gamble"]);
  });

  test("Chinese: a surname and a given name, a surname with a title, and a company", () => {
    const { names } = namesIn(
      "参会：王丽（星河科技）、陈经理、李明。好的，谢谢王总。他是我的同事张伟。把施工图发给你。",
    );
    expect([...names.keys()]).toEqual(["王丽", "星河科技", "陈经理", "李明", "王总", "张伟"]);
    expect(names.has("图发")).toBe(false);
  });

  test("text with no name gives none", () => {
    expect(namesIn("").names.size).toBe(0);
    expect(namesIn("we agreed to send it by friday.").names.size).toBe(0);
    expect(namesIn("我们下周一把合同寄给你们。").names.size).toBe(0);
    expect(namesIn("Marcus will call.").names.size).toBe(0);
    expect([...namesIn("Then Marcus will call.").names.keys()]).toEqual(["Marcus"]);
  });

  test("English: what a person has is not part of the name: Tom's is Tom", () => {
    const { names } = namesIn("We need Tom's sign-off. Then Priya's Budget is next, said Tom.");
    expect([...names]).toEqual([
      ["Tom", 2],
      ["Priya", 1],
      ["Budget", 1],
    ]);
    expect(names.has("Tom's")).toBe(false);
    expect(names.has("Priya's Budget")).toBe(false);
  });

  test("Chinese: a surname with a title is found before a word that joins two names", () => {
    const { names } = namesIn("请王总和李经理确认。王总跟陈总监或张老师及赵博士都同意。");
    expect([...names]).toEqual([
      ["王总", 2],
      ["李经理", 1],
      ["陈总监", 1],
      ["赵博士", 1],
    ]);
    // 总和 is a word of its own where no surname stands before it.
    expect(namesIn("金额的总和是五百。").names.size).toBe(0);
  });

  test("an English word ends where Chinese characters begin: a name of several words is a name, one word alone is kept apart", () => {
    const found = namesIn(
      "跟Priya确认，这个Plan先不动。请Maya Lindqvist跟进，和Lumen Foods签合同。",
    );
    expect([...found.names.keys()]).toEqual(["Maya Lindqvist", "Lumen Foods"]);
    expect([...found.besideChinese.keys()]).toEqual(["Priya", "Plan"]);
    expect(found.itemOpeners.size).toBe(0);
    // Written with spaces, as before: one word that doesn't open a sentence is a name.
    const spaced = namesIn("跟 Priya 确认，这个 Plan 先不动。");
    expect([...spaced.names.keys()]).toEqual(["Priya", "Plan"]);
    expect(spaced.besideChinese.size).toBe(0);
  });

  // protects=one English word written against a Chinese character is kept apart wherever it stands, where it opens a line, a list item or a sentence too, so this computer's transcriber is told it, and it is no name: the names found are the ones found without it; fails_when=Priya, Budget or Plan is of no kind, or is among the names, or a line's first word with no Chinese character against it becomes of any kind; no_claim=a word before a colon, which stays an item's opener (the test below).
  test("one English word against a Chinese character is kept apart where it opens a line, a list item or a sentence too, and is no name", () => {
    const found = namesIn(
      [
        "周会",
        "Priya跟进预算",
        "- Budget下周定",
        "先看合同. Plan先不动",
        "请Maya Lindqvist跟进",
      ].join("\n"),
    );
    expect([...found.besideChinese.keys()]).toEqual(["Priya", "Budget", "Plan"]);
    expect([...found.names.keys()]).toEqual(["Maya Lindqvist"]);
    expect(found.itemOpeners.size).toBe(0);
    // Its twin: with no Chinese character against it, a line's first word is of no kind.
    const english = namesIn(
      ["Priya follows up on the budget", "- Budget is due", "Then Maya Lindqvist signs."].join(
        "\n",
      ),
    );
    expect([...english.names.keys()]).toEqual(["Maya Lindqvist"]);
    expect(english.besideChinese.size).toBe(0);
    expect(english.itemOpeners.size).toBe(0);
    // Before a colon it is an item's opener, as it was: the colon stands between it and the Chinese.
    const colon = namesIn("Tom：工期");
    expect([...colon.itemOpeners.keys()]).toEqual(["Tom"]);
    expect(colon.besideChinese.size).toBe(0);
  });

  // protects=a letter and the accent written after it (e and U+0301, as many PDFs give é) are one letter, so a name is found whole however its accents are written, is given with each accent in its letter, and is one name where a text writes it both ways; fails_when=a name is cut at its accent (Jose and Marti for José Martín, Rene for Renée), or the name written both ways is listed twice, or a word of the kinds kept on this computer is cut or lost, or a mark Unicode has no one character for (the grave on the dotted o a Yoruba name ends in) ends the name; no_claim=which words are names, which the tests above hold for text written either way.
  test("a name is found whole however its accents are written, and written both ways it is one name", () => {
    const whole = namesIn("Then we ask Jos\u00e9 Mart\u00edn. We met Ren\u00e9e yesterday.");
    const apart = namesIn("Then we ask Jose\u0301 Marti\u0301n. We met Rene\u0301e yesterday.");
    expect([...whole.names]).toEqual([
      ["Jos\u00e9 Mart\u00edn", 1],
      ["Ren\u00e9e", 1],
    ]);
    expect([...apart.names]).toEqual([...whole.names]);
    const both = namesIn("Then we ask Jose\u0301 Marti\u0301n. We wait for Jos\u00e9 Mart\u00edn.");
    expect([...both.names]).toEqual([["Jos\u00e9 Mart\u00edn", 2]]);
    // The kinds kept on this computer are found whole too.
    const kept = namesIn(["\u8ddfJose\u0301\u786e\u8ba4", "Rene\u0301e: send the deck"].join("\n"));
    expect([...kept.besideChinese.keys()]).toEqual(["Jos\u00e9"]);
    expect([...kept.itemOpeners.keys()]).toEqual(["Ren\u00e9e"]);
    expect(kept.names.size).toBe(0);
    // A mark that stays a mark however it is written is part of its letter, and of the name.
    for (const written of ["Ad\u00e9b\u00e1y\u1ecd\u0300", "Ade\u0301ba\u0301yo\u0323\u0300"]) {
      expect([...namesIn(`Then we ask ${written} Okafor about it.`).names]).toEqual([
        ["Ad\u00e9b\u00e1y\u1ecd\u0300 Okafor", 1],
      ]);
    }
    // Their twin: a mark does not join what a space or a full stop parts.
    expect([...namesIn("Then we ask Rene\u0301e. Marcus will call.").names.keys()]).toEqual([
      "Ren\u00e9e",
    ]);
  });

  test("one word that opens a line before a colon, or is a list item alone, is kept apart", () => {
    const found = namesIn(
      [
        "Risks:",
        "- Tom",
        "- Priya Raman: send the deck",
        "Priya: review the plan",
        "1. Findings",
        "- Agenda",
        "Dana",
        "- Marcus will call.",
      ].join("\n"),
    );
    expect([...found.itemOpeners.keys()]).toEqual(["Risks", "Tom", "Priya", "Findings"]);
    expect([...found.names.keys()]).toEqual(["Priya Raman"]);
    // A line of one word with no list marker, and a sentence's first word, are neither.
    expect(found.itemOpeners.has("Dana")).toBe(false);
    expect(found.itemOpeners.has("Marcus")).toBe(false);
  });
});
