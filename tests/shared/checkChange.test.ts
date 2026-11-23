/**
 * The change a check gives reads on its card as a change waiting in the Note reads (#3715): the
 * words it takes out and the words it writes, or the sentence written anew under "Was:".
 */
import { describe, expect, it } from "vitest";
import { changedSentence, changeView } from "../../src/shared/checkChange";
import { INLINE_NODE } from "../../src/shared/sentences";

const OWEN =
  "Mara Quinn confirmed the pontoon opens in May, and Owen Hale agreed the ferry will run every 30 minutes all summer.";

describe("a check's change on its card (#3715)", () => {
  // protects=the card shows the sentence the change makes, and only where its words are in the sentence once; fails_when=a change is drawn over words the sentence has twice or not at all
  it("is made only where its words are in the sentence exactly once", () => {
    expect(
      changedSentence("Ferries carried 48,200 passengers.", { replace: "48,200", with: "42,800" }),
    ).toBe("Ferries carried 42,800 passengers.");
    expect(changedSentence("The tide, the tide.", { replace: "tide", with: "sea" })).toBeNull();
    expect(changedSentence("The tide turns.", { replace: "moon", with: "sun" })).toBeNull();
  });

  // protects=a change of a few words reads as the Note shows a waiting change: struck words, then the new ones, starting at the clause they are in; fails_when=the whole sentence is drawn again, or old and new words interleave wrongly
  it("strikes the words it takes out and underlines the words it writes, from the clause they are in", () => {
    const view = changeView(OWEN, {
      replace: "agreed the ferry will run every 30 minutes all summer",
      with: "said the ferry can run every 30 minutes only on spring tides in July and August",
    });
    expect(view).toEqual({
      kind: "words",
      cut: true,
      runs: [
        { kind: "kept", text: "and Owen Hale " },
        { kind: "struck", text: "agreed" },
        { kind: "written", text: "said" },
        { kind: "kept", text: " the ferry " },
        { kind: "struck", text: "will" },
        { kind: "written", text: "can" },
        { kind: "kept", text: " run every 30 minutes " },
        { kind: "struck", text: "all summer" },
        { kind: "written", text: "only on spring tides in July and August" },
        { kind: "kept", text: "." },
      ],
    });
  });

  // protects=a figure changed in a short sentence shows the whole sentence with the figure struck and the right one after it; fails_when=the sentence is cut or a Citation's place shows as a stray character
  it("keeps a short sentence whole and leaves out its Citations", () => {
    expect(
      changeView(`Kestrel Ferries carried 48,200 passengers in 2025${INLINE_NODE}.`, {
        replace: "48,200",
        with: "42,800",
      }),
    ).toEqual({
      kind: "words",
      cut: false,
      runs: [
        { kind: "kept", text: "Kestrel Ferries carried " },
        { kind: "struck", text: "48,200" },
        { kind: "written", text: "42,800" },
        { kind: "kept", text: " passengers in 2025." },
      ],
    });
  });

  // protects=a sentence written anew reads as a rewritten paragraph does in the Note: the old one on its own line, then the new; fails_when=a change of most of its words is drawn word by word
  it("shows a sentence written anew under the old one", () => {
    expect(
      changeView("The pontoon takes two boats at a time.", {
        replace: "The pontoon takes two boats at a time.",
        with: "Half-hourly sailings are possible only on spring tides.",
      }),
    ).toEqual({
      kind: "anew",
      was: "The pontoon takes two boats at a time.",
      now: "Half-hourly sailings are possible only on spring tides.",
    });
  });

  // protects=a Chinese sentence's change reads by its words, from the clause it is in; fails_when=Chinese is struck character by character or not cut at its comma
  it("reads a Chinese sentence by its words", () => {
    const view = changeView("林晓雯确认浮码头5月开放，何文海也同意整个夏天渡轮每30分钟一班。", {
      replace: "也同意整个夏天",
      with: "说只有7月和8月的大潮时",
    });
    expect(view?.kind).toBe("words");
    if (view?.kind !== "words") return;
    expect(view.cut).toBe(true);
    expect(view.runs[0]).toEqual({ kind: "kept", text: "何文海" });
    expect(
      view.runs
        .filter((run) => run.kind !== "written")
        .map((run) => run.text)
        .join(""),
    ).toBe("何文海也同意整个夏天渡轮每30分钟一班。");
    expect(
      view.runs
        .filter((run) => run.kind !== "struck")
        .map((run) => run.text)
        .join(""),
    ).toBe("何文海说只有7月和8月的大潮时渡轮每30分钟一班。");
  });
});
