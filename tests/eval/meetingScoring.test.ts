import { describe, expect, test } from "vitest";
import { formatReport, scoreCase, scoreCells } from "../../eval/meetings/report";
import type { CaseDefinition, Hypothesis, Reference } from "../../eval/meetings/types";

const definition = (over: Partial<CaseDefinition> = {}): CaseDefinition => ({
  id: "en-online-X",
  language: "en",
  setting: "online",
  source: "ami-online",
  recording: "X",
  durationSeconds: 600,
  speakers: 2,
  files: {},
  ...over,
});

const reference: Reference = {
  format: 1,
  segments: [
    { start: 0, end: 5, speaker: "A", text: "Hello there, twenty five of us.", track: "mic" },
    { start: 6, end: 10, speaker: "B", text: "Fine. [laughter] Thanks!", track: "system" },
    { start: 70, end: 75, speaker: "A", text: "Much later.", track: "mic" },
  ],
};

const hypothesis = (over: Partial<Hypothesis> = {}): Hypothesis => ({
  case: "en-online-X",
  transcriber: "test",
  processingSeconds: 150,
  segments: [
    { start: 0, end: 5, speaker: "Me", text: "hello there 25 of us" },
    { start: 6, end: 10, speaker: "Them", text: "Fine, thanks." },
    { start: 70, end: 75, speaker: "Me", text: "Much later" },
  ],
  ...over,
});

describe("Scoring one case", () => {
  test("a transcript that says the same after normalising scores 0, with DER and the real-time factor", () => {
    const score = scoreCase(definition(), reference, hypothesis(), { collar: 0 });
    expect(score.errors).toEqual({ errors: 0, total: 9, rate: 0 });
    expect(score.unit).toBe("word");
    expect(score.der?.rate).toBe(0);
    expect(score.rtf).toBeCloseTo(0.25);
  });

  test("words are compared in time order, whatever order the segments come in", () => {
    const shuffled = hypothesis({ segments: [...hypothesis().segments].reverse() });
    expect(scoreCase(definition(), reference, shuffled).errors.errors).toBe(0);
  });

  test("a wrong word and a missing one are errors over the reference's words", () => {
    const wrong = hypothesis({
      segments: [
        { start: 0, end: 5, speaker: "Me", text: "hello where 25 of us" },
        { start: 6, end: 10, speaker: "Them", text: "Fine." },
        { start: 70, end: 75, speaker: "Me", text: "Much later" },
      ],
    });
    const score = scoreCase(definition(), reference, wrong);
    expect(score.errors.errors).toBe(2);
    expect(score.errors.rate).toBeCloseTo(2 / 9);
  });

  test("a transcript that doesn't say who spoke has no diarisation score", () => {
    const plain = hypothesis({
      segments: hypothesis().segments.map(({ speaker: _speaker, ...rest }) => rest),
    });
    expect(scoreCase(definition(), reference, plain).der).toBeNull();
  });

  test("Chinese counts characters, and mixed text counts Han characters and English words", () => {
    const zh: Reference = {
      format: 1,
      segments: [
        { start: 0, end: 4, speaker: "A", text: "我有二十五个 WiFi 门铃。", track: "room" },
      ],
    };
    const said = (text: string): Hypothesis => ({
      case: "x",
      transcriber: "t",
      segments: [{ start: 0, end: 4, text }],
    });
    const chinese = definition({ language: "zh", setting: "room" });
    expect(scoreCase(chinese, zh, said("我有25个wifi门铃")).errors).toEqual({
      errors: 0,
      total: 7,
      rate: 0,
    });
    const mixed = definition({ language: "mixed", setting: "conversation" });
    const score = scoreCase(mixed, zh, said("我有25个wifi门玲"));
    expect(score.unit).toBe("mixed unit");
    expect(score.errors.errors).toBe(1);
  });

  test("only the first minutes can be scored, with no real-time factor", () => {
    const score = scoreCase(definition(), reference, hypothesis(), { until: 60 });
    expect(score.errors.total).toBe(7);
    expect(score.seconds).toBe(60);
    expect(score.rtf).toBeNull();
  });
});

describe("Scoring a set", () => {
  test("cases of one language and setting add up by their reference's units and speech time", () => {
    const small = scoreCase(definition({ id: "a" }), reference, hypothesis(), { until: 60 });
    const empty = scoreCase(
      definition({ id: "b" }),
      reference,
      { case: "b", transcriber: "t", segments: [] },
      { until: 60 },
    );
    const room = scoreCase(definition({ id: "c", setting: "room" }), reference, hypothesis());
    const cells = scoreCells([small, empty, room]);
    expect(cells).toHaveLength(2);
    const online = cells.find((c) => c.setting === "online");
    expect(online).toMatchObject({ cases: 2, errors: { errors: 7, total: 14, rate: 0.5 } });
    expect(online?.minutes).toBeCloseTo(2);
    expect(online?.der).toBeNull();
  });

  test("the report states the collar, and whether each target was met", () => {
    const score = scoreCase(definition(), reference, hypothesis(), { collar: 0.5 });
    const report = formatReport([score], 0.5);
    expect(report).toContain("DER (collar 0.5 s)");
    expect(report).toContain("WER 0.0% (target 15.0%, met)");
    expect(report).toContain("0.0% (target 20.0%, met)");
    expect(report).toContain("0.25×");
  });
});
