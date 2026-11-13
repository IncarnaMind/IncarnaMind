/**
 * A batch's reply read back (#2311): each sentence's verdict by its number, and nothing for a
 * sentence the reply gave no readable verdict, or two entries, readable or not; nothing at all when
 * an entry's number can't be read.
 */
import { describe, expect, test } from "vitest";
import { readBatchReply } from "../../src/core/answers/checks/sentenceBatch";

const entry = (number: number, verdict: string) => ({
  number,
  kind: "fact",
  verdict,
  roles: "same",
  time: "same",
  quoted: "states",
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
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"different","time":"same","says":"The slide says so."}]}',
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","says":"幻灯片这样写。"}]}',
    '{"sentences":[{"number":1,"kind":"Fact","verdict":"supported","roles":"same","time":"same","quoted":"states","says":"幻灯片这样写。"}]}',
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","says":"The slide says so."}]}',
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","quoted":"yes","says":"幻灯片这样写。"}]}',
  ])(
    "an entry whose kind, roles, time or quoted is missing or not one of its words is left unjudged, never same (#2816, #2739): %s",
    async (reply) => {
      expect((await readBatchReply(reply, 1)).has(1)).toBe(false);
    },
  );

  test.each([
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","quoted":"states","says":"The slide says so."}]}',
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","quoted":"other","says":"幻灯片这样写。"}]}',
  ])("an entry with every field is judged (#2816): %s", async (reply) => {
    const entry = JSON.parse(reply).sentences[0];
    expect((await readBatchReply(reply, 1)).get(1)).toEqual({
      kind: "fact",
      verdict: "supported",
      roles: "same",
      time: "same",
      quoted: entry.quoted,
      says: entry.says,
    });
  });

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

describe("a reply that corrects itself (#3029)", () => {
  // protects=a batch reply holding a first answer, words, then a corrected one reads the corrected one alone when it is a whole batch: a sentence it leaves out stays unjudged, a pass the earlier answer judged otherwise stays unjudged, a verdict it lowers stands; a reply with one answer reads as before, and a later answer that isn't a whole batch reads as before, nothing; fails_when=the two answers are mixed, the earlier one is read, a pass rests on a reply that said otherwise, or a single answer reads otherwise than before; no_claim=how often a model corrects itself, which the evaluation's trials count.
  const answer = (...entries: Record<string, unknown>[]) => JSON.stringify({ sentences: entries });
  const twice = (first: string, words: string, later: string) => `${first}\n\n${words}\n\n${later}`;
  const languages = [
    { language: "English", words: "Wait, I need to include both sentences." },
    { language: "Chinese", words: "等等，两句都要给出结论。更正如下：" },
  ];

  test.each(languages)("in $language, the corrected second answer is read", async ({ words }) => {
    const reply = twice(
      answer(entry(1, "supported")),
      words,
      answer(entry(1, "supported"), entry(2, "unsupported")),
    );

    const read = await readBatchReply(reply, 2);

    expect(read.get(1)).toMatchObject({ verdict: "supported" });
    expect(read.get(2)).toMatchObject({ verdict: "unsupported" });
  });

  test("a reply with one answer reads as before, words around it included", async () => {
    const one = answer(entry(1, "supported"), entry(2, "contradicted"));

    for (const reply of [one, `Here it is:\n${one}\nThat's all.`, `\`\`\`json\n${one}\n\`\`\``]) {
      const read = await readBatchReply(reply, 2);
      expect(read.get(1)).toMatchObject({ verdict: "supported" });
      expect(read.get(2)).toMatchObject({ verdict: "contradicted" });
    }
  });

  test.each(languages)(
    "in $language, a later answer that isn't a whole batch reads as before: nothing",
    async ({ words }) => {
      const first = answer(entry(1, "supported"), entry(2, "supported"));
      for (const later of [
        '{"verdicts":[{"number":1,"verdict":"supported"}]}',
        answer({ ...entry(1, "supported"), number: Number.NaN }),
        '{"sentences":[{"number":1,"kind":"fact","verdict":"supported"',
      ]) {
        expect((await readBatchReply(twice(first, words, later), 2)).size).toBe(0);
      }
    },
  );

  test.each(languages)(
    "in $language, a sentence the later answer leaves out stays unjudged",
    async ({ words }) => {
      const reply = twice(
        answer(entry(1, "supported"), entry(2, "supported")),
        words,
        answer(entry(1, "supported")),
      );

      const read = await readBatchReply(reply, 2);

      expect(read.get(1)).toMatchObject({ verdict: "supported" });
      expect(read.has(2)).toBe(false);
    },
  );

  test.each([
    { field: "kind", earlier: { kind: "opinion" } },
    { field: "verdict", earlier: { verdict: "unsupported" } },
    { field: "roles", earlier: { roles: "differs" } },
    { field: "time", earlier: { time: "differs" } },
    { field: "quoted", earlier: { quoted: "other" } },
  ])(
    "a pass whose earlier entry differs in $field alone stays unjudged, and one alike but for what it says is read",
    async ({ earlier }) => {
      for (const { words } of languages) {
        const reply = twice(
          answer(
            { ...entry(1, "supported"), ...earlier },
            { ...entry(2, "supported"), says: "So." },
          ),
          words,
          answer(entry(1, "supported"), entry(2, "supported")),
        );

        const read = await readBatchReply(reply, 2);

        expect(read.has(1)).toBe(false);
        expect(read.get(2)).toMatchObject({ verdict: "supported" });
      }
    },
  );

  test.each([
    {
      earlier: "an entry for sentence 1 that doesn't read whole",
      first: answer({ number: 1, kind: "fact", verdict: "contradicted" }, entry(2, "supported")),
      unjudged: [1],
    },
    {
      earlier: "a word for sentence 1 that isn't one of its verdicts",
      first: answer(entry(1, "partly"), entry(2, "supported")),
      unjudged: [1],
    },
    {
      earlier: "two entries for sentence 1",
      first: answer(entry(1, "supported"), entry(1, "supported"), entry(2, "supported")),
      unjudged: [1],
    },
    {
      earlier: 'an entry numbered "one", which might be any sentence',
      first: answer({ ...entry(1, "contradicted"), number: "one" }),
      unjudged: [1, 2],
    },
    {
      earlier: "a JSON object that isn't a batch",
      first: '{"verdict":"contradicted","sentence":1}',
      unjudged: [1, 2],
    },
  ])(
    "after $earlier, a later pass there stays unjudged, in English and Chinese",
    async ({ first, unjudged }) => {
      for (const { words } of languages) {
        const reply = twice(first, words, answer(entry(1, "supported"), entry(2, "supported")));

        const read = await readBatchReply(reply, 2);

        for (const number of [1, 2]) expect(read.has(number)).toBe(!unjudged.includes(number));
      }
    },
  );

  test("after an earlier answer that can't be placed, a verdict the later answer lowers still stands", async () => {
    const reply = twice(
      '{"verdict":"supported","sentence":1}',
      "等等，更正如下：",
      answer(entry(1, "unsupported"), entry(2, "contradicted")),
    );

    const read = await readBatchReply(reply, 2);

    expect(read.get(1)).toMatchObject({ verdict: "unsupported" });
    expect(read.get(2)).toMatchObject({ verdict: "contradicted" });
  });

  test("a first answer left open, then a whole one, reads nothing: what the first said can't be known", async () => {
    const reply = `{"sentences":[{"number":1,\n\nWait, both sentences:\n\n${answer(entry(1, "supported"), entry(2, "supported"))}`;

    expect((await readBatchReply(reply, 2)).size).toBe(0);
  });

  test("one answer, then words with a lone brace, reads nothing: another answer may have begun", async () => {
    const reply = `${answer(entry(1, "supported"))}\n\nAnd one more: {`;

    expect((await readBatchReply(reply, 1)).size).toBe(0);
  });

  test.each(languages)(
    "in $language, a verdict the later answer lowers stands, and one both give is read",
    async ({ words }) => {
      const reply = twice(
        answer(entry(1, "supported"), entry(2, "contradicted")),
        words,
        answer(entry(1, "unsupported"), entry(2, "contradicted")),
      );

      const read = await readBatchReply(reply, 2);

      expect(read.get(1)).toMatchObject({ verdict: "unsupported" });
      expect(read.get(2)).toMatchObject({ verdict: "contradicted" });
    },
  );

  test("a sentence the earlier answer gave no entry is read from the later one", async () => {
    const reply = twice(
      answer(entry(1, "unsupported")),
      "Wait, I need to include both sentences.",
      answer(entry(1, "unsupported"), entry(2, "supported")),
    );

    const read = await readBatchReply(reply, 2);

    expect(read.get(1)).toMatchObject({ verdict: "unsupported" });
    expect(read.get(2)).toMatchObject({ verdict: "supported" });
  });
});
