/**
 * In a sentence that cites a Document and writes its whole name, the name's number is no figure
 * (#3093): "Unit 2 (Lease 2): 1100 euros a month" is checked for 1100 euros, and the sentence takes
 * the verdict of its other parts. A number with a unit or a counted noun of its own, a number
 * outside the name or differing from it, a name the sentence doesn't cite and a Document named only
 * by a number keep their figures, so a wrong one is still caught.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  checkGenerate,
  checkReply,
  isCheckRun,
  listedSentences,
  type Plan,
  requestedFigures,
  sentenceOf,
} from "../helpers/checks";
import {
  answerEnded,
  answerJudged,
  citationOf,
  setUpWithDocuments,
  shownPassages,
} from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  scriptedModel,
} from "../helpers/models";

interface Case {
  /** The sentence, the Document its Citation is of, and the line it quotes. */
  text: string;
  cites: string;
  quote: string;
  /** The figures its check is asked to bind, as the sentence writes them. */
  figures: readonly string[];
}

const LANGUAGES = [
  {
    language: "en",
    documents: [
      { name: "Lease 2.txt", contents: "The rent for unit 2 is 1100 euros a month.\n" },
      { name: "Invoice 1043.txt", contents: "Unit 2 pays 1100 euros a month.\n" },
      { name: "Batch 4.txt", contents: "3 tonnes were delivered.\n" },
      { name: "8806.txt", contents: "The deposit is 8807.\n" },
    ],
    /** Right sentences whose cited name holds a number: checked for their other figures. */
    named: [
      {
        text: "Unit 2 (Lease 2): 1100 euros a month",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
        figures: ["2", "1100 euros"],
      },
      {
        text: "Unit 2 pays 1100 euros a month (Invoice 1043).",
        cites: "Invoice 1043",
        quote: "Unit 2 pays 1100 euros a month.",
        figures: ["2", "1100 euros"],
      },
    ],
    /** Wrong sentences whose number is a figure: caught. */
    kept: [
      {
        text: "Unit 2 pays 1100 euros a month (Invoice 1044).",
        cites: "Invoice 1043",
        quote: "Unit 2 pays 1100 euros a month.",
        figures: ["2", "1100 euros", "1044"],
      },
      {
        text: "Lease 3 sets the rent at 1100 euros.",
        cites: "Lease 2",
        quote: "The rent for unit 2 is 1100 euros a month.",
        figures: ["3", "1100 euros"],
      },
      {
        text: "Batch 4 tonnes were delivered.",
        cites: "Batch 4",
        quote: "3 tonnes were delivered.",
        figures: ["4 tonnes"],
      },
      {
        text: "The deposit is 8806.",
        cites: "8806",
        quote: "The deposit is 8807.",
        figures: ["8806"],
      },
    ],
    answer: {
      text: "Unit 2 pays 1100 euros a month (Invoice 1043).",
      quote: "Unit 2 pays 1100 euros a month.",
    },
  },
  {
    language: "zh-CN",
    documents: [
      { name: "附件3.txt", contents: "二号铺月租金为1100元。\n" },
      { name: "合同2.txt", contents: "合同1份已签署。\n" },
      { name: "8806.txt", contents: "押金编号为8807。\n" },
    ],
    named: [
      {
        text: "二号铺月租金为1100元（附件3）。",
        cites: "附件3",
        quote: "二号铺月租金为1100元。",
        figures: ["1100元"],
      },
    ],
    kept: [
      {
        text: "二号铺月租金为1100元（附件31）。",
        cites: "附件3",
        quote: "二号铺月租金为1100元。",
        figures: ["1100元", "31"],
      },
      {
        text: "二号铺月租金为1100元（附件4）。",
        cites: "附件3",
        quote: "二号铺月租金为1100元。",
        figures: ["1100元", "4"],
      },
      {
        text: "合同2份已签署。",
        cites: "合同2",
        quote: "合同1份已签署。",
        figures: ["2份"],
      },
      {
        text: "押金编号为8806。",
        cites: "8806",
        quote: "押金编号为8807。",
        figures: ["8806"],
      },
    ],
    answer: { text: "二号铺月租金为1100元（附件3）。", quote: "二号铺月租金为1100元。" },
  },
] as const;

type Example = (typeof LANGUAGES)[number];

/** Each case Supported by the model on its quote: whether it stands is the figures' to decide. */
const plansOf = (example: Example): Record<string, Plan> =>
  Object.fromEntries(
    [
      ...example.named,
      ...example.kept,
      { text: example.answer.text, quote: example.answer.quote },
    ].map((each): [string, Plan] => [each.text, { verdict: "supported", quote: each.quote }]),
  );

function batchReply(call: GenerateCall, plans: Record<string, Plan>): GeneratedReply {
  const sentences = [
    ...call.prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/g),
  ];
  return {
    text: JSON.stringify({
      sentences: sentences.map(([, number, sentence = ""]) => ({
        number: Number(number),
        kind: "fact",
        verdict: plans[sentence]?.verdict ?? "unsupported",
        roles: "same",
        time: "same",
        quoted: "states",
        says: null,
      })),
    }),
  };
}

async function setUp(example: Example, answer?: { text: string; quote: string }) {
  const calls: ModelCall[] = [];
  const plans = plansOf(example);
  const generate = checkGenerate(plans);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call) || !answer) return checkReply(call, plans);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return { calls: [{ tool: "search_documents", input: { query: answer.quote } }] };
      if (!call.results.some((result) => result.tool === "cite")) {
        const passage = shownPassages(searches.at(-1)?.text ?? "").find((each) =>
          each.text.includes(answer.quote),
        );
        const citations = [{ marker: 1, passage: passage?.id, quote: answer.quote }];
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: `${answer.text} [^1]\n` };
    },
    {
      generate(call) {
        if (call.question === "sentence-batch") return batchReply(call, plans);
        if (call.question === "find-claims")
          return {
            text: JSON.stringify({
              sentences: listedSentences(call.prompt).map(({ number, text }) => ({
                number,
                parts: [{ kind: "fact", text }],
              })),
            }),
          };
        return generate(call);
      },
    },
  );
  const setup = await setUpWithDocuments(model, example.documents);
  const byName = (name: string) => {
    const document = setup.documents.find((each) => each.name === name);
    if (!document) throw new Error(`No Document named ${name}.`);
    return document;
  };
  return { ...setup, calls, byName };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

/** A Note of `cases`, each a line with its Citation, checked by Check this note or by Check against Documents on all of it. */
async function checkedNote(
  setup: Setup,
  cases: readonly Case[],
  by: "note" | "selection" = "note",
) {
  writeMind(
    setup.client,
    await Promise.all(
      cases.map(async (each, index) => ({
        type: "paragraph",
        attrs: { id: `line-${index}` },
        content: [
          { type: "text", text: each.text },
          await citationOf(setup.core, setup.byName(each.cites), each.quote),
        ],
      })),
    ),
  );
  await setup.client.settled();
  if (by === "note")
    await setup.core.checkMind({ requestId: randomUUID(), mindId: setup.mind.id, mode: "all" });
  else
    await setup.core.checkSentences({
      requestId: randomUUID(),
      mindId: setup.mind.id,
      action: "check-against-documents",
      from: { blockId: "line-0", offset: 0 },
      to: { blockId: `line-${cases.length - 1}`, offset: (cases.at(-1)?.text.length ?? 0) + 1 },
      allDocuments: true,
    });
  await setup.client.settled();
  const asked = new Map(
    setup.calls
      .filter((call) => isCheckRun(call) && call.results.length === 0)
      .map((call) => [sentenceOf(call), requestedFigures(call).map((figure) => figure.shown)]),
  );
  const states = new Map(
    claimSpans(readMind(setup.client)).map(({ sentence, check }) => [sentence.text, check.state]),
  );
  return { asked, states };
}

describe.each(LANGUAGES)("the number in a cited Document's name ($language)", (example) => {
  // protects=a sentence that writes the whole name of the Document it cites is checked for its other figures only, and takes their verdict: Supported where they are (#3093); fails_when=the name's number is asked for as a figure, or the sentence is marked for it; no_claim=the "2" of "Unit 2", which is #3081's.
  test.each(["note", "selection"] as const)(
    "is no figure, and the sentence takes the verdict of its other parts (%s)",
    async (by) => {
      const setup = await setUp(example);
      const [wrong] = example.kept;
      const { asked, states } = await checkedNote(setup, [...example.named, wrong], by);
      for (const each of example.named) {
        expect(asked.get(each.text), each.text).toEqual(each.figures);
        expect(states.get(each.text), each.text).toBe("supported");
      }
      expect(asked.get(wrong.text)).toEqual(wrong.figures);
      expect(states.get(wrong.text)).not.toBe("supported");
      expect(states.has(wrong.text)).toBe(true);
      setup.core.close();
    },
  );

  // protects=a number that differs from the name's, a name the sentence doesn't cite, a number with its own unit or counted noun after the name, and a Document named only by a number are figures as before, so each wrong sentence is caught (#3093); fails_when=such a number isn't asked for, or the wrong sentence reads Supported; no_claim=whether it reads Contradicted or Unsupported.
  test("keeps every other number, so a wrong one is caught", async () => {
    const setup = await setUp(example);
    const [right] = example.named;
    const { asked, states } = await checkedNote(setup, [right, ...example.kept]);
    for (const each of example.kept) {
      expect(asked.get(each.text), each.text).toEqual(each.figures);
      expect(states.get(each.text), each.text).not.toBe("supported");
      expect(states.has(each.text), each.text).toBe(true);
    }
    expect(states.get(right.text)).toBe("supported");
    setup.core.close();
  });

  // protects=an Answer's sentence that writes the whole name of the Document it cites is judged on its other numbers and passes, its Citation drawing the ✓ (#3093); fails_when=the name's number holds the sentence back as a number no quote states; no_claim=the Answer's own wording.
  test("in an Answer, is no number its quote must state", async () => {
    const setup = await setUp(example, example.answer);
    const asked = await setup.core.askInConversation({ text: "What is the rent?" });
    if (!asked.asked) throw new Error("Not asked.");
    expect((await answerEnded(setup.core, asked.answerId)).event).toBe("finished");
    const answer = await answerJudged(setup.core, asked.conversation.id, asked.answerId);
    const [cited] = answer.citations;
    expect(cited?.check).toBe("found");
    expect(cited?.passedAt).toEqual([0]);
    setup.core.close();
  });
});
