/**
 * A reply that names a marker such as [1] in its words before its JSON, or after it, is read as
 * the JSON it gave (#2184). Claude Haiku 5.5 asked for a record answered "The request asks for
 * marker [1]…" first: the JSON was taken to start at that bracket, the reply could not be read, and
 * a sentence the Document states word for word came back Not checked. Through the core: a Note's
 * check, the model's sorting reply with words around its JSON, the sentence's result as the User
 * sees it. A reply that is cut off, or holds two answers, or only the marker, is never read as an
 * answer it didn't give.
 */
import { describe, expect, test } from "vitest";
import { readClaimDecisions } from "../../src/core/answers/checks/claims";
import { readBatchText } from "../../src/core/answers/checks/sentenceBatch";
import { replyJson } from "../../src/core/answers/judge";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { isRecord } from "../../src/shared/record";
import { checkGenerate, checkReply, listedSentences, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { editMind, readMind, writeMind } from "../helpers/minds";
import { scriptedModel } from "../helpers/models";

const CASES = [
  {
    language: "en",
    sentence:
      "Raising the barrier crest by 40 centimetres halves the expected annual damage in the northern estuary.",
    before: "The request asks for marker [1].",
    after: "Marker [1] is the only one.",
  },
  {
    language: "zh-CN",
    sentence: "将防波堤顶部抬高 40 厘米，可使北部河口的预期年损失减半。",
    before: "请求要求给出标记 [1]。",
    after: "只有标记 [1]。",
  },
] as const;

type Wording = (json: string, words: { before: string; after: string }) => string;

const WORDINGS: Record<string, Wording> = {
  "its JSON alone": (json) => json,
  "a marker in words before its JSON": (json, { before }) => `${before}\n${json}`,
  "a marker in words after its JSON": (json, { after }) => `${json}\n${after}`,
  "a marker before and after its JSON": (json, { before, after }) => `${before}\n${json}\n${after}`,
  "a marker before its JSON in a code fence": (json, { before }) =>
    `${before}\n\`\`\`json\n${json}\n\`\`\``,
};

async function checked(example: (typeof CASES)[number], wording: Wording) {
  const plans: Record<string, Plan> = {
    [example.sentence]: { verdict: "supported", quote: example.sentence },
  };
  const generate = checkGenerate(plans);
  const model = scriptedModel((call) => checkReply(call, plans), {
    generate(call) {
      if (call.question !== "find-claims") return generate(call);
      const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
        number,
        parts: [{ kind: "fact", text }],
      }));
      return { text: wording(JSON.stringify({ sentences }), example) };
    },
  });
  const { core, mind, client } = await setUpWithDocuments(model, [
    { name: "Field Report.md", contents: `# Results\n\n${example.sentence}\n` },
  ]);
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "sentence" },
      content: [{ type: "text", text: example.sentence }],
    },
  ]);
  await client.settled();
  await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
  await client.settled();
  return claimSpans(readMind(client)).map((span) => span.check.state);
}

describe.each(CASES)("a sorting reply with words around its JSON, in $language", (example) => {
  // protects=a sentence the Document states word for word is Supported whatever words the sorting reply puts beside its JSON, a marker such as [1] among them (#2184); fails_when=the JSON is taken to start at the marker's bracket and the reply can't be read, so the sentence comes back Not checked
  test.each(Object.entries(WORDINGS))("%s", async (_name, wording) => {
    expect(await checked(example, wording)).toEqual(["supported"]);
  });
});

describe("a reply's JSON is the whole object it wrote, or nothing", () => {
  const OBJECT = '{"sentences":[{"number":1,"parts":[]}]}';
  const READ = { sentences: [{ number: 1, parts: [] }] };

  test.each([
    ["words and a marker before it", `The request asks for marker [1]. ${OBJECT}`],
    ["a marker after it", `${OBJECT} See [1].`],
    ["a marker before and after it", `Marker [1]:\n${OBJECT}\nSee [2].`],
    ["a Chinese marker line before it", `请求要求给出标记 [1]。\n${OBJECT}`],
    ["a code fence and a marker before it", `Marker [1]:\n\`\`\`json\n${OBJECT}\n\`\`\``],
  ])("%s: read", (_name, reply) => {
    expect(replyJson(reply)).toEqual(READ);
  });

  // protects=a reply the model didn't finish, gave two answers in, or never wrote JSON in is never read as an answer it didn't give: no repair, no mix of two objects, no marker taken for a record (#2275, #3029); fails_when=a marker, a piece of a cut-off reply or a span of two answers is read as the reply
  test.each([
    ["only the marker", "The request asks for marker [1]."],
    ["a marker and nothing else", "[1]"],
    ["a cut-off object after a marker", 'Marker [1]: {"sentences":[{"number":1,"parts":['],
    ["a cut-off object", '{"sentences":[{"number":1,'],
    [
      "two answers around a marker",
      '{"sentences":[]} Marker [1] {"sentences":[{"number":1,"parts":[]}]}',
    ],
    ["a list that is no record", "Marker [1]: [1, 2, 3]"],
    ["a list holding one object", 'Marker [1]: [{"sentences":[]}]'],
    ["an object with a word in its braces' place", "Marker [1] {not json}"],
  ])("%s: no record is read", (_name, reply) => {
    expect(isRecord(replyJson(reply))).toBe(false);
  });
});

describe("the readers that take a reply's JSON from its text, with a marker in words around it", () => {
  const BATCH =
    '{"sentences":[{"number":1,"kind":"fact","verdict":"supported","roles":"same","time":"same","quoted":"states","says":"The lease says so."}]}';

  test.each([
    ["before it", `The request asks for marker [1].\n${BATCH}`],
    ["after it", `${BATCH}\nMarker [1] is the only one.`],
    ["before and after it", `Marker [1]:\n${BATCH}\nSee [2].`],
  ])("a batch of verdicts with a marker %s is read", (_name, reply) => {
    expect(readBatchText(reply, 1)?.get(1)?.verdict).toBe("supported");
  });

  // protects=a batch reply that is cut off, holds two answers around a marker, or is a record that gives no verdict is never read as a verdict (#3029, #2184); fails_when=a marker's bracket or a record that isn't the batch is taken for the batch's verdicts
  test.each([
    ["only the marker", "The request asks for marker [1]."],
    ["a cut-off batch after a marker", `Marker [1]: ${BATCH.slice(0, 60)}`],
    [
      "a record of citations after a marker",
      'Marker [1]: {"citations":[{"marker":1,"passage":"P1","quote":"x"}]}',
    ],
  ])("a batch of verdicts with %s is not read", (_name, reply) => {
    expect(readBatchText(reply, 1)).toBeNull();
  });

  test.each([
    ["before it", 'The request asks for marker [1].\n{"1":"claim","2":"no"}'],
    ["after it", '{"1":"claim","2":"no"}\nMarker [1] is the only one.'],
  ])("the claim decisions with a marker %s are read", (_name, reply) => {
    expect([...(readClaimDecisions(reply, [1, 2]) ?? [])]).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  test("a record that decides no sentence, after a marker, decides none", () => {
    expect(
      readClaimDecisions('Marker [1]: {"citations":[{"marker":1,"quote":"x"}]}', [1, 2]),
    ).toBeNull();
  });
});

describe("the sentence is checked again after an edit, still read from a reply with a marker", () => {
  test("an edited sentence is sorted by a reply with a marker before its JSON, and is Supported", async () => {
    const example = CASES[0];
    const plans: Record<string, Plan> = {
      [example.sentence]: { verdict: "supported", quote: example.sentence },
    };
    const generate = checkGenerate(plans);
    const model = scriptedModel((call) => checkReply(call, plans), {
      generate(call) {
        if (call.question !== "find-claims") return generate(call);
        const sentences = listedSentences(call.prompt).map(({ number, text }) => ({
          number,
          parts: [{ kind: "fact", text }],
        }));
        return { text: `${example.before}\n${JSON.stringify({ sentences })}` };
      },
    });
    const { core, mind, client } = await setUpWithDocuments(model, [
      { name: "Field Report.md", contents: `# Results\n\n${example.sentence}\n` },
    ]);
    writeMind(client, [
      {
        type: "paragraph",
        attrs: { id: "sentence" },
        content: [{ type: "text", text: "Costs rose." }],
      },
    ]);
    await client.settled();
    editMind(client, (blocks) =>
      blocks.map((block) => ({
        ...block,
        content: block.content?.map((node) =>
          node.type === "text" ? { ...node, text: example.sentence } : node,
        ),
      })),
    );
    await client.settled();
    await core.checkMind({ requestId: crypto.randomUUID(), mindId: mind.id, mode: "all" });
    await client.settled();

    expect(claimSpans(readMind(client)).map((span) => span.check.state)).toEqual(["supported"]);
  });
});
