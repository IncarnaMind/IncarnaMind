import { expect, test } from "vitest";
import { notesContext, sectionsContext } from "../../src/core/meetings/fillPrompt";

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
  expect(prompt).toContain("in English Me is I, Them is the other side");
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
