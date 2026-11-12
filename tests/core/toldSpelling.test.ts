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

  // protects=a heard word is its run of Latin letters, so what stands against it in another script stays in the line (Katherineさん, Katherine씨), and a word holding a letter or a digit the rough sound leaves out is another word and stays as heard; fails_when=さん, 씨 or β is gone from the line, or Katherineø or Katherine2 is written Catherine with or without its last character, or a letter that only carries a mark (é) stops a word being respelled; no_claim=a word in a script without capitals, which is never a candidate.
  test("what stands against a heard word in another script stays; a word with a letter or digit the sound leaves out stays as heard", () => {
    const told = ["Catherine"];
    expect(inToldSpelling("We asked Katherineさん about it.", told)).toBe(
      "We asked Catherineさん about it.",
    );
    expect(inToldSpelling("We asked Katherine씨 and Katherineβ.", told)).toBe(
      "We asked Catherine씨 and Catherineβ.",
    );
    expect(inToldSpelling("We asked Katherineø and Katherine2.", told)).toBe(
      "We asked Katherineø and Katherine2.",
    );
    // Their twin: a mark on a letter is sounded as the letter, so the word is still respelled.
    expect(inToldSpelling("We asked Kathérine about it.", told)).toBe(
      "We asked Catherine about it.",
    );
  });

  // protects=a told name the rough sound can't read whole (a digit, a letter it leaves out) is never written for something heard, so Phase2 is not written over the Phase of "Phase 2" and Søren not over a word that only lacks its ø; fails_when=the line reads "Phase2 2" or "Søren", or the told name already in the line changes, or a told name of plain letters beside it is no longer respelled; no_claim=telling such a name to the transcriber, which this does not change.
  test("a told name with a digit, or a letter the sound leaves out, is never written for something heard", () => {
    expect(inToldSpelling("We start Phase 2 on Monday.", ["Phase2"])).toBe(
      "We start Phase 2 on Monday.",
    );
    expect(inToldSpelling("We start Phase2 on Monday.", ["Phase2"])).toBe(
      "We start Phase2 on Monday.",
    );
    expect(inToldSpelling("We asked Sren about it.", ["Søren"])).toBe("We asked Sren about it.");
    // Its twin: a told name of plain letters beside it is respelled as before.
    expect(inToldSpelling("We start Phase 2 with Katherine.", ["Phase2", "Catherine"])).toBe(
      "We start Phase 2 with Catherine.",
    );
  });

  // protects=a full stop, a line break or more than one mark between two words written as names is never inside one name, so a sentence's end stays where it was heard; fails_when="Katherine. Marsh" loses its stop, or the two words on each side of a line break or of an ellipsis become one name, or one space or one hyphen between a name's words no longer joins them; no_claim=a told name that itself holds an abbreviation heard with its stop (Dr Catherine Marsh told, Dr. Katherine Marsh heard), which stays as heard.
  test("a full stop between two words written as names stays: the words on each side are never one name", () => {
    const told = ["Catherine Marsh"];
    expect(inToldSpelling("We asked Katherine. Marsh has the draft.", told)).toBe(
      "We asked Catherine. Marsh has the draft.",
    );
    expect(inToldSpelling("We asked Katherine... Marsh has it.", told)).toBe(
      "We asked Catherine... Marsh has it.",
    );
    expect(inToldSpelling("We asked Katherine\nMarsh has it.", told)).toBe(
      "We asked Catherine\nMarsh has it.",
    );
    // Their twin: one space or one hyphen between them is the name's own.
    expect(inToldSpelling("We asked Katherine Marsh about it.", told)).toBe(
      "We asked Catherine Marsh about it.",
    );
    expect(inToldSpelling("We asked Katherine-Marsh about it.", told)).toBe(
      "We asked Catherine Marsh about it.",
    );
    expect(inToldSpelling("We asked Mary-Ann about it.", ["Maryann"])).toBe(
      "We asked Maryann about it.",
    );
    // A dash with spaces around it is the sentence's, not a name's hyphen.
    expect(inToldSpelling("We asked Mary - Ann about it.", ["Maryann"])).toBe(
      "We asked Mary - Ann about it.",
    );
    // And a name after an abbreviation's stop is respelled, with the stop where it was.
    expect(inToldSpelling("We asked Dr. Katherine Marsh about it.", told)).toBe(
      "We asked Dr. Catherine Marsh about it.",
    );
  });

  // protects=a name with an apostrophe after its first capital (O'Neill, D'Angello) is heard as one name and written as the told one, alone or after a first name, with either apostrophe; fails_when=O'Neill stays when O'Neil is told, or a capital standing alone before a space starts a name (A Dell for Adel), or the capital before the apostrophe is written as a told word by itself (Oo, a told name of the same rough sound, for the O of O'Neill); no_claim=a told name whose first word is one capital and a space (Ó Briain), which is not respelled.
  test("a capital alone is part of a name only where an apostrophe joins it to the rest", () => {
    expect(inToldSpelling("We asked O'Neill about it.", ["O'Neil"])).toBe(
      "We asked O'Neil about it.",
    );
    expect(
      inToldSpelling("We asked Mary O’Neill and D'Angello.", ["Mary O’Neil", "D'Angelo"]),
    ).toBe("We asked Mary O’Neil and D'Angelo.");
    // Their twins: a capital before a space is a word of its own, and one before an apostrophe is never a told word alone.
    expect(inToldSpelling("We bought A Dell for the office.", ["Adel"])).toBe(
      "We bought A Dell for the office.",
    );
    expect(inToldSpelling("We asked O'Neill about it.", ["Oo"])).toBe("We asked O'Neill about it.");
  });

  // protects=a told name keeps its place only where it stands as a whole word, so a longer heard word that begins with it is still written as the told name it sounds like (Anni as Ani, with Ann told too); fails_when=Anni or Sammy stays as heard, or a told name standing whole in another case is rewritten (Deshawn, told DeShawn); no_claim=which of two told names of the same sound was said, which nothing here decides.
  test("a told name keeps its place only as a whole word: inside a longer word it holds nothing back", () => {
    expect(inToldSpelling("We asked Ann and Anni about it.", ["Ann", "Ani"])).toBe(
      "We asked Ann and Ani about it.",
    );
    expect(inToldSpelling("We asked Sammy about it.", ["Sam", "Samy"])).toBe(
      "We asked Samy about it.",
    );
    // Its twin: standing whole, in another case, it keeps its place.
    expect(inToldSpelling("We asked Deshawn about it.", ["DeShawn"])).toBe(
      "We asked Deshawn about it.",
    );
  });
});

/** A name as a transcriber writes it: words in Latin letters with one space, apostrophe or hyphen between them. */
const AS_HEARD = String.raw`\p{Script=Latin}+(?:[ '’-]\p{Script=Latin}+)*`;
const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `written` is `heard` with nothing changed but names: each told name in it, or word of
 * one, stands where the heard line has words a name could have been heard as, and everything
 * else is the heard line character for character.
 */
function onlyNamesDiffer(heard: string, written: string, told: readonly string[]): boolean {
  const names = told
    .flatMap((name) => [name, ...name.split(" ")])
    .filter((name) => new RegExp(`^${AS_HEARD}$`, "u").test(name))
    .sort((a, b) => b.length - a.length);
  const name = new RegExp(
    String.raw`(?<!\p{Script=Latin})(?:${names.map(literally).join("|")})(?!\p{Script=Latin})`,
    "u",
  );
  return new RegExp(`^${written.split(name).map(literally).join(AS_HEARD)}$`, "u").test(heard);
}

describe("A respelling changes nothing in a line but the name it writes (#1031)", () => {
  const TOLD = ["Catherine Marsh", "Erik", "O'Neil", "Maryann", "DeShawn", "高欣"];

  // protects=the lines below, in English, in Chinese with an English name in it and mixed, with full stops, commas, colons, apostrophes, hyphens, quotes and a name at the line's end, are written exactly so: the name in the told spelling and every other character where it was heard; fails_when=any line differs from its written form by one character; no_claim=lines beyond these, which the property below covers.
  const LINES: [heard: string, written: string][] = [
    ["We asked Katherine. Marsh has the draft.", "We asked Catherine. Marsh has the draft."],
    ["We asked Katherineさん about it.", "We asked Catherineさん about it."],
    ["高新请Katherine确认，然后问Eric：预算呢？", "高新请Catherine确认，然后问Erik：预算呢？"],
    [
      "She said “Katherine Marsh” twice, and 'Eric' once.",
      "She said “Catherine Marsh” twice, and 'Erik' once.",
    ],
    [
      "Notes: we met Mary-Ann, De Shawn and O'Neill; the draft is O’Neill's.",
      "Notes: we met Maryann, DeShawn and O'Neil; the draft is O'Neil's.",
    ],
    [
      "下周三Katherine Marsh和Eric过来, then we ship.",
      "下周三Catherine Marsh和Erik过来, then we ship.",
    ],
    ["The last word goes to Katherine", "The last word goes to Catherine"],
  ];

  test.each(LINES)("%s", (heard, written) => {
    expect(inToldSpelling(heard, TOLD)).toBe(written);
    expect(onlyNamesDiffer(heard, written, TOLD)).toBe(true);
  });

  // protects=the yardstick of the property below: it turns away a line that lost a sentence's full stop inside a name, one that lost the characters of another script against a name, and one with a comma moved, and takes a hyphen between a name's heard words as the name's to write; fails_when=the yardstick takes any of the three, or turns the hyphen away; no_claim=which heard words are a name's, which the tests above hold.
  test("the yardstick turns away a lost full stop, lost characters of another script and a moved comma", () => {
    expect(
      onlyNamesDiffer(
        "We asked Katherine. Marsh has the draft.",
        "We asked Catherine Marsh has the draft.",
        TOLD,
      ),
    ).toBe(false);
    expect(
      onlyNamesDiffer("We asked Katherineさん about it.", "We asked Catherine about it.", TOLD),
    ).toBe(false);
    expect(
      onlyNamesDiffer("We asked Katherine, then Eric.", "We asked Catherine then, Erik.", TOLD),
    ).toBe(false);
    expect(onlyNamesDiffer("We asked Mary-Ann.", "We asked Maryann.", TOLD)).toBe(true);
  });

  const HEARD = [
    "Katherine",
    "Katherine Marsh",
    "Marsh",
    "Eric",
    "O'Neill",
    "Mary-Ann",
    "De Shawn",
    "Dana",
  ];
  const AROUND: ((first: string, second: string) => string)[] = [
    (first, second) => `We asked ${first}. ${second} has the draft.`,
    (first, second) => `We asked ${first}, ${second} and the others.`,
    (first, second) => `Notes: ${first} said "${second}" twice.`,
    (first, second) => `She said “${first}” and '${second}' once.`,
    (first, second) => `高新请${first}确认，${second}跟进。`,
    (first, second) => `We asked ${first}さん and ${second}씨 about it.`,
    (first, second) => `It was ${first}'s draft, not ${second}’s.`,
    (first, second) => `We asked ${first}-${second} (the lead) about it`,
    (first, second) => `Then ${first}... ${second}?`,
    (first, second) => `The draft went from ${second} to ${first}`,
  ];

  // protects=whatever stands around a name, the written line outside the names it writes is the heard line character for character, and a name is written only over words a name could have been heard as, with at most the one space, apostrophe or hyphen between them: no full stop, comma, colon, quote, bracket or character of another script is removed, added or moved; fails_when=for any of the 640 lines (8 heard forms in each of two places of 10 sentences) the written line differs from the heard one outside a told name, or a told name stands over anything but such words; no_claim=that the right words were taken for the name, which the lines above and the tests of each rule hold.
  test("in every sentence, with every heard form in both places, only names differ", () => {
    const lines = AROUND.flatMap((around) =>
      HEARD.flatMap((first) => HEARD.map((second) => around(first, second))),
    );
    expect(lines).toHaveLength(640);
    const broken = lines.filter(
      (heard) => !onlyNamesDiffer(heard, inToldSpelling(heard, TOLD), TOLD),
    );
    expect(broken).toEqual([]);
    // Its twin: the lines are respelled, not left alone, with each heard form written as its told name.
    expect(lines.filter((heard) => inToldSpelling(heard, TOLD) !== heard)).toHaveLength(576);
    for (const [heard, name] of [
      ["Katherine", "Catherine"],
      ["Katherine Marsh", "Catherine Marsh"],
      ["Eric", "Erik"],
      ["O'Neill", "O'Neil"],
      ["Mary-Ann", "Maryann"],
      ["De Shawn", "DeShawn"],
    ]) {
      expect(inToldSpelling(`We asked ${heard} about it.`, TOLD)).toBe(
        `We asked ${name} about it.`,
      );
    }
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
