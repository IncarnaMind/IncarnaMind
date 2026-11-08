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
    "Name everyone else as they introduced themselves or were named in the call, on either side: a named person is never the other side, 对方 or they",
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

test("a section-only fill uses the same fact and overview protocol", () => {
  const context = sectionsContext("Write the notes");
  expect(context).toMatchObject({ meetingFacts: true });
  const prompt = JSON.stringify(context.messages);
  expect(prompt).toContain("The User took no notes");
  expect(prompt).toContain("### FACT P1_F1");
  expect(prompt).toContain("### OVERVIEW");
  expect(prompt).not.toContain("HEADINGS: H1=ACTIONS");
});

// protects=the call's language is told from what was said, its time and speaker marks left out, so a short English call isn't taken for the interface's language and a Chinese one with English marks is Chinese (#2770); fails_when=the marks' English words decide it, or a short call is unknown; no_claim=languages the notes have no titles in, which fall back to the interface's.
test.each([
  ["[0:01 Them] 企业版如果按年付费，每个席位每月多少钱？\n[0:05 Me] 可以打九折。", "Chinese"],
  ["[0:01 Them] Is the price fixed?", "English"],
  [
    "[0:01 Speaker 1] Can we start the trial in December?\n[0:04 Speaker 2] 可以，十二月一号开始试用。",
    "Chinese",
  ],
  ["[0:01 Them] Le prix est fixé pour une année avec les mises à jour.", null],
  ["[0:01 Them] 45, 270, SSO.", null],
] as const)("a call that says %j is held in %s", (text, language) => {
  expect(callLanguage([{ text }])).toBe(language);
});

// protects=with no ordinary line to point to, the model is told lines is empty, never the transcript's times, which left every fact out for its metadata on Claude Haiku 5.5 (#2773); fails_when=a note with no typed lines, or only headings, is told to list L addresses; no_claim=a real model's reply, which the PR's real-model runs cover.
test.each([
  ["no notes", []],
  ["only a heading", [{ marker: "H1", text: "Action items", heading: true }]],
] as const)("with %s, lines is always empty", (_, lines) => {
  const prompt = JSON.stringify(notesContext(lines, "Write the notes").messages);
  expect(prompt).toContain("The User wrote no ordinary L lines, so lines is always []");
  expect(prompt).not.toContain("lines lists related ordinary L addresses");
});

test("with a typed line, lines lists its L address", () => {
  const prompt = JSON.stringify(
    notesContext([{ marker: "L1", text: "price", heading: false }], "Fill the note").messages,
  );
  expect(prompt).toContain("lines lists related ordinary L addresses");
  expect(prompt).not.toContain("lines is always []");
});
