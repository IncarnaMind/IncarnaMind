/**
 * A batch's reply read back (#2311): each sentence's verdict by its number, and nothing for a
 * sentence the reply gave no readable verdict, or two entries, readable or not; nothing at all when
 * an entry's number can't be read.
 */
import { describe, expect, test } from "vitest";
import { readBatchReply } from "../../src/core/answers/checks/sentenceBatch";
import { estimateTokens } from "../../src/core/answers/context";
import { outputTokens } from "../../src/core/providers/outputLimits";

const entry = (number: number, verdict: string) => ({
  number,
  kind: "fact",
  verdict,
  roles: "same",
  time: "same",
  unstated: null,
  uncited: null,
  says: "The schedule says so.",
});

describe("a batch's reply", () => {
  test("a sentence numbered twice is left unjudged, never green, and the others keep theirs", async () => {
    const reply = JSON.stringify({
      sentences: [
        entry(1, "unsupported"),
        entry(1, "supported"),
        entry(2, "supported"),
        entry(3, "contradicted"),
      ],
    });

    const read = await readBatchReply(reply, 3);

    expect(read.has(1)).toBe(false);
    expect(read.get(2)).toMatchObject({ verdict: "supported" });
    expect(read.get(3)).toMatchObject({ verdict: "contradicted" });
  });

  test.each([
    {
      case: "its second verdict unreadable",
      entries: [entry(1, "supported"), entry(1, "Contradicted"), entry(2, "supported")],
    },
    {
      case: "its first number written as digits",
      entries: [
        { ...entry(1, "contradicted"), number: "1" },
        entry(1, "supported"),
        entry(2, "supported"),
      ],
    },
  ])("a sentence numbered twice, $case, is left unjudged, never green", async ({ entries }) => {
    const read = await readBatchReply(JSON.stringify({ sentences: entries }), 2);

    expect(read.has(1)).toBe(false);
    expect(read.get(2)).toMatchObject({ verdict: "supported" });
  });

  test.each(["1.0", null, "0x1"])(
    "an entry numbered %j, which can't be read as a sentence's, leaves the whole batch unjudged",
    async (number) => {
      const reply = JSON.stringify({
        sentences: [
          { ...entry(1, "contradicted"), number },
          entry(1, "supported"),
          entry(2, "supported"),
        ],
      });

      expect((await readBatchReply(reply, 2)).size).toBe(0);
    },
  );

  test.each([
    '{"sentences":[{"number":1,"verdict":"supported"}]}',
    '{"sentences":[{"number":1,"kind":"fact","unstated":null,"uncited":null,"verdict":"supported","roles":"different","time":"same","says":"The slide says so."}]}',
    '{"sentences":[{"number":1,"kind":"fact","unstated":null,"uncited":null,"verdict":"supported","roles":"same","says":"幻灯片这样写。"}]}',
    '{"sentences":[{"number":1,"kind":"Fact","unstated":null,"uncited":null,"verdict":"supported","roles":"same","time":"same","says":"幻灯片这样写。"}]}',
    '{"sentences":[{"number":1,"kind":"fact","uncited":null,"verdict":"supported","roles":"same","time":"same","says":"The slide says so."}]}',
    '{"sentences":[{"number":1,"kind":"fact","unstated":null,"verdict":"supported","roles":"same","time":"same","says":"幻灯片这样写。"}]}',
    '{"sentences":[{"number":1,"kind":"fact","unstated":false,"uncited":null,"verdict":"supported","roles":"same","time":"same","says":"The slide says so."}]}',
  ])(
    "an entry whose kind, roles, time, unstated or uncited is missing or not one of its words is left unjudged, never same (#2816, #2739, #3003): %s",
    async (reply) => {
      expect((await readBatchReply(reply, 1)).has(1)).toBe(false);
    },
  );

  test.each([
    {
      reply:
        '{"sentences":[{"number":1,"kind":"fact","unstated":null,"uncited":null,"verdict":"supported","roles":"same","time":"same","says":"The slide says so."}]}',
      unstated: null,
      uncited: null,
    },
    {
      reply:
        '{"sentences":[{"number":1,"kind":"fact","unstated":"因此周末不营业","uncited":" ","verdict":"supported","roles":"same","time":"same","says":"幻灯片这样写。"}]}',
      unstated: "因此周末不营业",
      uncited: null,
    },
    {
      reply:
        '{"sentences":[{"number":1,"kind":"fact","unstated":"","uncited":"as the board decided","verdict":"supported","roles":"same","time":"same","says":"The slide says so."}]}',
      unstated: null,
      uncited: "as the board decided",
    },
  ])(
    "an entry with every field is judged, the words it copies kept and an empty copy read as none (#2816, #3003): $reply",
    async ({ reply, unstated, uncited }) => {
      const entry = JSON.parse(reply).sentences[0];
      expect((await readBatchReply(reply, 1)).get(1)).toEqual({
        kind: "fact",
        verdict: "supported",
        roles: "same",
        time: "same",
        unstated,
        uncited,
        says: entry.says,
      });
    },
  );

  test("a clean batch's entries are each judged", async () => {
    const reply = JSON.stringify({
      sentences: [entry(1, "supported"), { ...entry(2, "contradicted"), number: "2" }],
    });

    const read = await readBatchReply(reply, 2);

    expect(read.get(1)).toMatchObject({ verdict: "supported" });
    expect(read.get(2)).toMatchObject({ verdict: "contradicted" });
  });

  test("a reply in another order, with a number past the batch, maps each verdict to its sentence", async () => {
    const reply = JSON.stringify({
      sentences: [entry(2, "unsupported"), entry(4, "supported"), entry(1, "supported")],
    });

    const read = await readBatchReply(reply, 2);

    expect([...read.entries()].map(([number, { verdict }]) => [number, verdict])).toEqual([
      [2, "unsupported"],
      [1, "supported"],
    ]);
  });
});

describe("a batch's reply with the words it copies fits the room its records are given", () => {
  // protects=the two copied fields of #3003 don't push a full batch's reply past what the meter sets aside a sentence (300 tokens beside the room for thinking), so a long Answer's check isn't cut short; fails_when=an entry copying long clauses in both fields, in English or Chinese, costs more than 300 tokens; no_claim=what a model writes, which the dev trial measures.
  test.each([
    {
      language: "English",
      clause:
        "so the board can expect the whole programme to pay for itself well before the second winter of running both kilns at full load",
      says: "The deck gives the price of two kilns, installed, and the month they are installed, and nothing about savings, payback or the board's plans for the second winter.",
    },
    {
      language: "Chinese",
      clause:
        "因此董事会可以预期整个项目在两台窑炉满负荷运行的第二个冬天之前就能收回全部成本并开始带来额外的利润",
      says: "演示稿只写了两台窑炉含安装的价格和安装月份，没有写节省的费用、回本时间或董事会在第二个冬天的计划。",
    },
  ])(
    "in $language, eight entries copying long clauses in both fields stay within 300 tokens each",
    ({ clause, says }) => {
      const reply = JSON.stringify({
        sentences: Array.from({ length: 8 }, (_, index) => ({
          number: index + 1,
          kind: "fact",
          unstated: clause,
          uncited: clause,
          verdict: "unsupported",
          roles: "same",
          time: "same",
          says,
        })),
      });

      expect(outputTokens("sentence-batch", 8)).toBe(7_400);
      expect(estimateTokens(reply) / 8).toBeLessThan(300);
      expect(readBatchReply(reply, 8).size).toBe(8);
    },
  );
});
