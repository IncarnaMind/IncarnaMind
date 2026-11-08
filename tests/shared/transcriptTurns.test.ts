import { describe, expect, test } from "vitest";
import {
  endsSentence,
  joinsUnspaced,
  PARAGRAPH_MS,
  type TurnLine,
  turnsOf,
} from "../../src/shared/transcriptTurns";

const line = (startMs: number, endMs: number, text: string, speaker: string | null = "Me") => ({
  startMs,
  endMs,
  text,
  speaker,
});

/** Each turn as its Speaker and its paragraphs' texts. */
const shown = (lines: readonly TurnLine[]) =>
  turnsOf(lines).map((turn) => ({
    speaker: turn.speaker,
    startMs: turn.startMs,
    paragraphs: turn.paragraphs.map((paragraph) => paragraph.map((each) => each.text).join(" ")),
  }));

/** A monologue of `seconds`, a sentence every five seconds, a breath between each. */
function monologue(seconds: number, words: (n: number) => string, speaker = "Me"): TurnLine[] {
  return Array.from({ length: seconds / 5 }, (_, n) =>
    line(n * 5000, n * 5000 + 4500, words(n), speaker),
  );
}

describe("A Transcript as a script (turns)", () => {
  // protects=one Speaker's lines one after another, breaths of half a second between them, are one turn with one name and one start, in English and Chinese, however long; fails_when=a breath, a line's end or a time cuts the turn; no_claim=where a route cuts its lines, which the route tests cover.
  test("a three-minute monologue with breaths in it is one turn", () => {
    for (const words of [
      (n: number) => `Sentence ${n} of the plan goes on.`,
      (n: number) => `第${n}句话继续说下去。`,
    ]) {
      const turns = turnsOf(monologue(180, words));
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({ speaker: "Me", startMs: 0 });
    }
  });

  // protects=a long turn breaks into paragraphs at sentence ends only, once a paragraph holds half a minute; a line that ends mid-sentence never ends a paragraph; fails_when=a paragraph breaks inside a sentence or after every line; no_claim=how paragraphs look, which the window spec covers.
  test("a long turn reads in paragraphs, broken only at a sentence's end", () => {
    const turns = shown(monologue(90, (n) => `Sentence ${n} goes on.`));
    expect(turns).toHaveLength(1);
    const paragraphs = turns[0]?.paragraphs ?? [];
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(paragraphs.length).toBeLessThanOrEqual(90_000 / PARAGRAPH_MS + 1);
    for (const paragraph of paragraphs) expect(endsSentence(paragraph)).toBe(true);
    // Cut every 20 seconds inside a sentence, as Transcripts saved before were: no paragraph breaks there.
    const cut = [
      line(0, 20_000, "We talked about the launch and"),
      line(20_000, 40_000, "the budget for the review, which"),
      line(40_000, 60_000, "moves to Friday."),
    ];
    expect(shown(cut)).toEqual([
      {
        speaker: "Me",
        startMs: 0,
        paragraphs: [
          "We talked about the launch and the budget for the review, which moves to Friday.",
        ],
      },
    ]);
  });

  // protects=someone else's short line is a turn of its own, and the first Speaker's next lines start a new turn after it; a pause of two seconds or more starts a new turn too; a line that must start one (after a gap) does; fails_when=an interjection is swallowed into the turn, the first Speaker's words after it join the turn before it, or a long pause leaves one turn; no_claim=who speaks, which the speaker pass and the User say.
  test("an interjection is its own turn, and a long pause starts a new one", () => {
    expect(
      shown([
        line(0, 4000, "We sign on Friday."),
        line(4100, 4800, "Right.", "Them"),
        line(4900, 9000, "Then the board reads it."),
        line(11_500, 13_000, "One more thing."),
        line(13_200, 14_000, "After a gap.", "Me"),
      ]).map((turn) => [turn.speaker, turn.paragraphs.join(" | ")]),
    ).toEqual([
      ["Me", "We sign on Friday."],
      ["Them", "Right."],
      ["Me", "Then the board reads it."],
      ["Me", "One more thing. After a gap."],
    ]);
    const gapped = turnsOf([
      line(0, 4000, "Before."),
      { ...line(4100, 5000, "After."), startsTurn: true },
    ]);
    expect(gapped).toHaveLength(2);
  });

  // protects=lines cut inside a Chinese word read whole, with no space, and English lines with one; fails_when=a space splits "这个", or English words run together; no_claim=Japanese, which reads the same way.
  test("lines join without a space between Chinese characters, and with one otherwise", () => {
    expect(joinsUnspaced("我们讨论了这", "个级别的问题")).toBe(true);
    expect(joinsUnspaced("课代表", "黎震说")).toBe(true);
    expect(joinsUnspaced("The budget", "holds.")).toBe(false);
    expect(joinsUnspaced("预算。", "The review")).toBe(false);
  });
});
