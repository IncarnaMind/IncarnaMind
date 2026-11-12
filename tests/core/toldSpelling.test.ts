import { describe, expect, test } from "vitest";
import { inToldSpelling, wordsInToldSpelling } from "../../src/core/transcription/spelling";
import { alignWords } from "../../src/shared/wordTimes";

describe("A name the Meeting was told is written its way in a line (#1031)", () => {
  test("words written as a name that sound the same are written as the told name; a like sound is not", () => {
    const told = ["Catherine Marsh", "Erik", "Nikki"];
    expect(inToldSpelling("We asked Katherine to send the draft to Eric.", told)).toBe(
      "We asked Catherine to send the draft to Erik.",
    );
    expect(inToldSpelling("Then Katherine Marsh and Nicky agreed.", told)).toBe(
      "Then Catherine Marsh and Nikki agreed.",
    );
    // Kathryn and Erica are other names: one sound of theirs differs.
    expect(inToldSpelling("We asked Kathryn and Erica.", told)).toBe("We asked Kathryn and Erica.");
  });

  test("a told name already written keeps its place, whatever its case", () => {
    const told = ["Catherine Marsh", "Erik"];
    expect(inToldSpelling("We asked Catherine and erik.", told)).toBe(
      "We asked Catherine and erik.",
    );
  });

  test("a word that opens a sentence, or isn't written as a name, stays", () => {
    const told = ["Phil", "Guy"];
    expect(inToldSpelling("Fill in the form, said Fill.", told)).toBe(
      "Fill in the form, said Phil.",
    );
    expect(inToldSpelling("Please fill in the form.", told)).toBe("Please fill in the form.");
    expect(inToldSpelling("The new GUI ships with Gui.", told)).toBe("The new GUI ships with Guy.");
  });

  test("when two told names sound the same, neither is written for the other or for a third spelling", () => {
    const line = "We asked Mark and Marc, then Marq.";
    expect(inToldSpelling(line, ["Marc", "Mark Stone"])).toBe(line);
    expect(inToldSpelling(line, ["Marc"])).toBe("We asked Marc and Marc, then Marc.");
  });

  test("a Chinese line that reads the same as a told name stays as the engine wrote it; the English name in it is respelled", () => {
    const told = ["高欣", "王丽", "Catherine Marsh"];
    expect(inToldSpelling("高新说下周交付，往里走。", told)).toBe("高新说下周交付，往里走。");
    expect(inToldSpelling("高新请Katherine确认。", told)).toBe("高新请Catherine确认。");
  });

  test("with no told name, or none that sounds like a word of the line, the line is as it came", () => {
    expect(inToldSpelling("We asked Katherine.", [])).toBe("We asked Katherine.");
    expect(inToldSpelling("We asked Katherine.", ["Harbor Logistics", "星河科技"])).toBe(
      "We asked Katherine.",
    );
  });

  // protects=only the name is respelled: the ordinary words around it in the same line stay as heard, a common word of the same sound (mark, fill), a word that holds the heard spelling (market) and a word of a like sound (file) among them, with the name in the middle of the line; fails_when=any word but the name changes, or the name keeps the engine's spelling; no_claim=a capitalised word in mid-sentence of the same sound that is not the person (a product called Mark, told Marc), which is written as the name: the rule can't tell them apart.
  test("in a line of ordinary words, only the name in its middle is respelled; a common word of the same sound stays", () => {
    const marked = "We put a mark on the page that Mark sent to the market.";
    expect(inToldSpelling(marked, ["Marc"])).toBe(
      "We put a mark on the page that Marc sent to the market.",
    );
    const filled = "Please fill in the form that Katherine and Fill will file by Friday.";
    expect(inToldSpelling(filled, ["Phil", "Catherine Marsh"])).toBe(
      "Please fill in the form that Catherine and Phil will file by Friday.",
    );
    // Their twin: with other names told, both lines are as they came.
    expect(inToldSpelling(marked, ["Dana Whitfield"])).toBe(marked);
    expect(inToldSpelling(filled, ["Dana Whitfield"])).toBe(filled);
  });
});

/** Where a line's heard words are placed once each is written as the line writes it, and which word's time each place has. */
function placed(line: string, heard: readonly string[], told: readonly string[]) {
  const written = wordsInToldSpelling(line, heard, told);
  return alignWords(
    inToldSpelling(line, told),
    heard.map((_, index) => ({ text: written[index] ?? "", ms: index })),
  ).map(({ at, ms }) => [at, ms]);
}

describe("The transcriber's words as the line writes them, for their times (#1031)", () => {
  // protects=the word heard for a told name is written as the name, so it is placed at the name with its own time, and the same spelling standing again in the line (inside a longer word, as a common word, or as a sentence's first word) keeps its own place and time; fails_when=the heard word's time lands on the later word, or the words between lose theirs; no_claim=the times themselves, which the Transcript's word-time tests hold through the core.
  test("a word heard for a told name is the name; the same spelling later in the line stays where it is", () => {
    const market = ["We", " asked", " Mark", " about", " the", " Market."];
    expect(wordsInToldSpelling("We asked Mark about the Market.", market, ["Marc"])).toEqual([
      "We",
      " asked",
      "Marc",
      " about",
      " the",
      " Market.",
    ]);
    expect(placed("We asked Mark about the Market.", market, ["Marc"])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [20, 4],
      [24, 5],
    ]);
    expect(
      placed(
        "We asked Mark to mark the page.",
        ["We", "asked", "Mark", "to", "mark", "the", "page."],
        ["Marc"],
      ),
    ).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [17, 4],
      [22, 5],
      [26, 6],
    ]);
    // A service that gives a whole turn: the first is respelled, the second opens a sentence and stays.
    const twice = ["We", " asked", " Katherine", ".", " Katherine", " agreed", "."];
    expect(
      wordsInToldSpelling("We asked Katherine. Katherine agreed.", twice, ["Catherine"]),
    ).toEqual(["We", " asked", "Catherine", ".", " Katherine", " agreed", "."]);
    expect(placed("We asked Katherine. Katherine agreed.", twice, ["Catherine"])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [18, 3],
      [20, 4],
      [30, 5],
      [36, 6],
    ]);
  });

  // protects=a name of several words keeps each word's place; a name written in fewer or more words than were heard stands whole for the first word heard, whose time it takes, and the other words heard for it are left out, as is every part but the first where a service times parts of words; fails_when=a word of the name is placed outside it, or a later word of the line takes a time of the name's; no_claim=the time a click inside the name plays from past its first word, which is an estimate between two known times.
  test("a name of several words is written word for word; heard as more or fewer words than it has, it stands whole for the first and the rest are left out", () => {
    expect(
      wordsInToldSpelling(
        "Then we asked Katherine Marsh, and Katherine agreed.",
        ["Then", "we", "asked", "Katherine", "Marsh,", "and", "Katherine", "agreed."],
        ["Catherine Marsh"],
      ),
    ).toEqual(["Then", "we", "asked", "Catherine", "Marsh", "and", "Catherine", "agreed."]);
    const split = ["We", "asked", "Lind", "Qvist", "about", "it."];
    expect(wordsInToldSpelling("We asked Lind Qvist about it.", split, ["Lindqvist"])).toEqual([
      "We",
      "asked",
      "Lindqvist",
      "",
      "about",
      "it.",
    ]);
    expect(placed("We asked Lind Qvist about it.", split, ["Lindqvist"])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [19, 4],
      [25, 5],
    ]);
    const joined = ["We", "asked", "DeShawn", "about", "it."];
    expect(wordsInToldSpelling("We asked DeShawn about it.", joined, ["De Shawn"])).toEqual([
      "We",
      "asked",
      "De Shawn",
      "about",
      "it.",
    ]);
    expect(placed("We asked DeShawn about it.", joined, ["De Shawn"])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [18, 3],
      [24, 4],
    ]);
    // A service that times parts of words: the name is placed at its first part.
    const parts = ["We", " asked", " Kath", "erine", " about", " it", "."];
    expect(placed("We asked Katherine about it.", parts, ["Catherine"])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [19, 4],
      [25, 5],
      [27, 6],
    ]);
  });

  test("their twin: with no name told, or none heard, every word is as it came and keeps its place", () => {
    const market = ["We", " asked", " Mark", " about", " the", " Market."];
    expect(wordsInToldSpelling("We asked Mark about the Market.", market, [])).toEqual(market);
    expect(wordsInToldSpelling("We asked Mark about the Market.", market, ["Dana"])).toEqual(
      market,
    );
    expect(placed("We asked Mark about the Market.", market, [])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [20, 4],
      [24, 5],
    ]);
    const twice = ["We", " asked", " Katherine", ".", " Katherine", " agreed", "."];
    expect(wordsInToldSpelling("We asked Katherine. Katherine agreed.", twice, [])).toEqual(twice);
    expect(placed("We asked Katherine. Katherine agreed.", twice, [])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [18, 3],
      [20, 4],
      [30, 5],
      [36, 6],
    ]);
    const split = ["We", "asked", "Lind", "Qvist", "about", "it."];
    expect(placed("We asked Lind Qvist about it.", split, [])).toEqual([
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [20, 4],
      [26, 5],
    ]);
  });
});
