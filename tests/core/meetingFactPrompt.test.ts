import { expect, test } from "vitest";
import { callLanguage, notesContext, sectionsContext } from "../../src/core/meetings/fillPrompt";

test.each(["price and next steps", "价格与后续分工"])(
  "meeting facts keep the User's line and request one identity per fact: %s",
  (text) => {
    const context = notesContext([{ marker: "L1", text, heading: false }], "Fill the note");
    const prompt = JSON.stringify(context.messages);
    expect(context).toMatchObject({ meetingFacts: true });
    expect(prompt).toContain(`L1: ${text}`);
    expect(prompt).toContain("### FACT P1_F1");
    expect(prompt).toContain("### END P1_F1");
    expect(prompt).toContain("### OVERVIEW");
    expect(prompt).toContain("### END OVERVIEW");
    expect(prompt).toContain("Code, not your reply, writes the full fact once");
    expect(prompt).toContain("all related final choices and work assignments");
    expect(prompt).not.toContain("### ACTIONS H1");
    expect(prompt).not.toContain("HEADINGS: H1=ACTIONS");
  },
);

test("heading meaning stays in the generation, not in a heading-name list", () => {
  const context = notesContext(
    [
      { marker: "H1", text: "Where we landed", heading: true },
      { marker: "L1", text: "timing", heading: false },
    ],
    "Fill the note",
  );
  const prompt = JSON.stringify(context.messages);
  expect(prompt).toContain("H1 (heading): Where we landed");
  expect(prompt).toContain("HEADINGS: H1=ACTIONS H2=NONE");
  expect(prompt).toContain("in any wording or language");
  expect(prompt).toContain("whether or not the User typed lines under it");
  expect(prompt).toContain("never an ordinary paragraph");
  expect(prompt).toContain(
    "Write the User, who reads these notes, in the first person (I, my; 我 in Chinese), even when the call gave their name",
  );
  expect(prompt).toContain(
    "Name everyone else as they introduced themselves or were named in the call or in the User's notes, on either side: a named person is never the other side, 对方 or they",
  );
  expect(prompt).toContain("as we or our (我们) where they spoke for their side");
  expect(prompt).toContain(
    "in English Me is I, Them is the other side, and a numbered voice keeps its mark",
  );
  expect(prompt).toContain(
    "Write a decision once, as finally agreed: not the proposal and then its confirmation, and never its figures twice",
  );
  expect(prompt).toContain(
    "The speaker marks (Me, Them and numbered voices, or their translations) are not names",
  );
});

// protects=each fact names the part of the call it goes under, at most six in the call's order, the User's own heading's words where they typed one, and the overview is two or three sentences on what the call was about and what came out of it, with claims only for what a Document could state (#2306); fails_when=the heading field, its limit or the overview's shape is missing from the prompt; no_claim=a real model's topics, which tests/live/meetingFillSections.live.test.ts measures.
test.each([
  ["no notes", []],
  ["a typed line", [{ marker: "L1", text: "价格", heading: false }]],
] as const)(
  "with %s, facts are asked for a heading and the overview for what came out",
  (_, lines) => {
    const prompt = JSON.stringify(notesContext(lines, "Write the notes").messages);
    expect(prompt).toContain('\\"heading\\":\\"<the part of the call>\\"');
    expect(prompt).toContain("at most 6 headings in all, in the order the call took them up");
    expect(prompt).toContain("Where the User typed a heading for that part, use its words.");
    expect(prompt).toContain(
      "two or three short sentences on what the call was about and what came out of it",
    );
    expect(prompt).toContain("claim is true only for a figure, date, price or term");
    expect(prompt).toContain("A fact is one short point, a single sentence");
    expect(prompt).toContain("never the figures, dates or owners the notes below give");
    expect(prompt).not.toContain('\\"summary\\" for other figures');
  },
);

// protects=a decision is what the people in the call agreed to do and never a figure one side stated; a named other side is named on every line of theirs when they alone speak as Them, in the User's spelling where the User typed it, and never with an invented name; and a decision is written once, not also as its proposal or inside another decision (#2306); fails_when=any of these rules is missing from the prompt; no_claim=a real model following them, which tests/live/meetingFillSections.live.test.ts measures.
test.each([
  ["no notes", []],
  ["a typed line", [{ marker: "L1", text: "和王磊通话", heading: false }]],
] as const)(
  "with %s, the prompt says what a decision is, who is named, and that a decision is said once",
  (_, lines) => {
    const prompt = JSON.stringify(notesContext(lines, "Write the notes").messages);
    expect(prompt).toContain(
      "a figure, price, term or fact one side stated is never a decision, even when nobody objects, and takes no section",
    );
    expect(prompt).toContain(
      "When one person speaks as Them and their name is known, that name is Them on every line",
    );
    expect(prompt).toContain(
      "A name the User typed is written as they typed it, even when the transcript heard it differently. Never invent a name.",
    );
    expect(prompt).toContain(
      "A proposal agreed as it stood is not a fact of its own, and a decision names only its own choice, never another decision's terms.",
    );
  },
);

test("a section-only fill uses the same fact and overview protocol", () => {
  const context = sectionsContext("Write the notes");
  expect(context).toMatchObject({ meetingFacts: true });
  const prompt = JSON.stringify(context.messages);
  expect(prompt).toContain("The User took no notes");
  expect(prompt).toContain("### FACT P1_F1");
  expect(prompt).toContain("### OVERVIEW");
  expect(prompt).not.toContain("HEADINGS: H1=ACTIONS");
});

// protects=the call's language is told from all that was said, its time and speaker marks left out, so a Chinese call with English marks is Chinese and one that opens in Chinese small talk is still told by the rest (#2770); fails_when=the marks' words decide it, or only the opening counts; no_claim=languages the notes have no titles in, which keep the interface's.
test.each([
  ["[0:01 Them] 企业版如果按年付费，每个席位每月多少钱？\n[0:05 Me] 可以打九折。", "Chinese"],
  ["[0:01 Me] 好\n[0:02 Them] 嗯\n[0:03 Me] OK", "Chinese"],
  ["[0:01 Them] Is the price fixed?", "English"],
  [
    "[0:01 Speaker 1] Can we start in December?\n[0:04 Speaker 2] 可以，十二月一号开始试用，合同草稿我明天发给您。",
    "Chinese",
  ],
  [
    "[0:01 Me] 你好。\n[0:03 Them] Thanks for joining. Can we go through the price and the date for the trial, and what the contract says about the data?",
    "English",
  ],
  ["[0:01 Them] Le prix est fixé pour une année avec les mises à jour.", null],
  ["[0:01 Them] 45, 270, SSO.", null],
] as const)("a call that says %j is held in %s", (text, language) => {
  expect(callLanguage([{ text }])).toBe(language);
});

// protects=with no ordinary line to point to, the model is told lines is empty, never the transcript's times, which left every fact out for its metadata on Claude Haiku 5.5 (#2773), and a fact with no section goes under its heading (#2306); fails_when=a note with no typed lines, or only headings, is told to list L addresses or that each fact needs a section; no_claim=a real model's reply, which the PR's real-model runs cover.
test.each([
  ["no notes", []],
  ["only a heading", [{ marker: "H1", text: "Action items", heading: true }]],
] as const)("with %s, lines is always empty", (_, lines) => {
  const prompt = JSON.stringify(notesContext(lines, "Write the notes").messages);
  expect(prompt).toContain("The User wrote no ordinary L lines, so lines is always []");
  expect(prompt).not.toContain("every fact names at least one section");
  expect(prompt).toContain("[] for anything else, which the notes show under its heading");
  expect(prompt).not.toContain("lines lists related ordinary L addresses");
});

test("with a typed line, lines lists its L address", () => {
  const prompt = JSON.stringify(
    notesContext([{ marker: "L1", text: "price", heading: false }], "Fill the note").messages,
  );
  expect(prompt).toContain("lines lists related ordinary L addresses");
  expect(prompt).not.toContain("lines is always []");
});

// protects=with the User's name set, the model is told to write a token for them in every language and is never told the name, and the first-person rule and Me's own word are gone, so nothing contradicts it (#2306); fails_when=the token is missing, the first person is still asked, or Me is still given a word of its own; no_claim=a real model's wording, which tests/live/meetingFillSections.live.test.ts measures.
test.each([
  [
    "notes",
    (named: boolean) =>
      notesContext(
        [{ marker: "L1", text: "price", heading: false }],
        "Fill the note",
        undefined,
        "English",
        named,
      ),
  ],
  ["sections", (named: boolean) => sectionsContext("Write the notes", undefined, "Chinese", named)],
] as const)(
  "with the User's name set, the %s prompt asks for the token, not the first person",
  (_, context) => {
    const named = JSON.stringify(context(true).messages);
    expect(named).toContain(
      "Write the User, who reads these notes, as {{me}}, exactly so in every language, even when the call gave their name",
    );
    expect(named).toContain("Where the User said my, write {{me}}'s ({{me}}的 in Chinese).");
    expect(named).toContain(
      "Where the User said our or we (我们的, 我们) for their side, keep our or we (我们的, 我们); make {{me}} the owner of such an action only when the User clearly took it on themselves.",
    );
    expect(named).not.toContain("my or our");
    expect(named).toContain("Never write I, me, my, 我 or any name for the User.");
    expect(named).toContain("Me is always {{me}}.");
    expect(named).toContain("in Simplified Chinese Them is 对方");
    expect(named).not.toContain("in the first person");
    expect(named).not.toContain("Me is I");
    expect(named).not.toContain("Me is 我");
    expect(named).toContain("a named person is never the other side, 对方 or they");

    const unnamed = JSON.stringify(context(false).messages);
    expect(unnamed).toContain(
      "in the first person (I, my; 我 in Chinese), even when the call gave their name",
    );
    expect(unnamed).toContain("in English Me is I, Them is the other side");
    expect(unnamed).toContain("in Simplified Chinese Me is 我");
    expect(unnamed).not.toContain("{{me}}");
  },
);

// protects=a later part of a long call is shown each kept fact's heading, so its facts on the same topic go under the same heading (#2306); fails_when=the history leaves the heading out; no_claim=a real model reusing it.
test("a later part is shown each kept fact's heading, so a topic keeps its words", () => {
  const prompt = JSON.stringify(
    notesContext([], "Write the notes", {
      part: 2,
      facts: [
        {
          id: "P1_F1",
          topic: "fee",
          heading: "价格与付款",
          text: "费用是 2%。",
          lines: [],
          sections: [],
        },
      ],
    }).messages,
  );
  expect(prompt).toContain("Use new ids P2_F1");
  expect(prompt).toContain('\\"heading\\":\\"价格与付款\\"');
});
