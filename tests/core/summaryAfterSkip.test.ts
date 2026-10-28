import { describe, expect, test } from "vitest";
import { CITATION_NODE, type ConversationAnswer, type Core, type MindChange } from "../../src/core";
import { CITE_RETRY_INSTRUCTIONS } from "../../src/core/answers/prompt";
import { askAssistant, mindCalls } from "../helpers/assistant";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { connectToMind } from "../helpers/mindClient";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/*
 * #1415: a summary of the Documents written after the User skips the assistant's question carries
 * a Citation on each statement, in English and in Chinese, in the reply or in a Mind. The model is
 * shaped like Claude Haiku 5.5 in the hand check: it asks which Documents, is told the User
 * skipped, searches, then writes the summary without calling cite. The Documents are in English,
 * as the sample PDFs are.
 */

const FACTS = [
  {
    name: "Harbour lease.md",
    quote: "The tenant pays a monthly rent of 900 euros for the Harbour Street flat.",
    query: "Harbour Street rent",
    en: "The Harbour Street flat rents for 900 euros a month.",
    zh: "港口街公寓的月租是 900 欧元。",
  },
  {
    name: "Mill lease.md",
    quote: "The tenant pays a monthly rent of 700 euros for the Mill Lane house.",
    query: "Mill Lane rent",
    en: "The Mill Lane house rents for 700 euros a month.",
    zh: "米尔巷房屋的月租是 700 欧元。",
  },
  {
    name: "Board minutes.md",
    quote: "The board met in March and approved a new boiler for Mill Lane.",
    query: "board boiler",
    en: "In March the board approved a new boiler for Mill Lane.",
    zh: "董事会在三月批准为米尔巷更换新锅炉。",
  },
] as const;

const DOCUMENTS = FACTS.map((fact) => ({
  name: fact.name,
  contents: `# ${fact.name.replace(".md", "")}\n\n${fact.quote}\n`,
}));

const WHICH = {
  question: "Which Documents should I summarise?",
  options: [
    { label: "All 3", description: "Every Document", recommended: true },
    { label: "The two leases", description: "Harbour lease, Mill lease" },
  ],
};

type Language = "en" | "zh";

const REQUEST: Record<Language, string> = {
  en: "Summarise the main documents",
  zh: "总结主要文档",
};
const ASSUMED: Record<Language, string> = {
  en: "You skipped the question, so I went with all 3 Documents.",
  zh: "你跳过了问题，所以我按全部 3 个文档总结。",
};
const TITLE: Record<Language, string> = { en: "Summary", zh: "主要文档总结" };
const summaryIn = (language: Language) =>
  FACTS.map((fact) => fact[language]).join(language === "en" ? " " : "");

/** The one request for Citations, answered as a model does: each sentence with its Passage's words. */
function citationsAsked(call: ModelCall) {
  const passages = [...call.prompt.matchAll(/<passage id="(P\d+)">\n([\s\S]*?)\n<\/passage>/g)];
  return FACTS.flatMap((fact) => {
    const sentence = [fact.en, fact.zh].find((each) => call.prompt.includes(each));
    const passage = passages.find((each) => each[2]?.includes(fact.quote));
    return sentence && passage ? [{ sentence, passage: passage[1], quote: fact.quote }] : [];
  });
}

/** Whether the model's last Tool result is the refusal of a write with no Citation. */
const refusedUncited = (call: ModelCall) =>
  call.results.at(-1)?.text.includes("content has no Citation") ?? false;

/**
 * Haiku's shape after a skip: asks, searches each Document, then writes the summary uncited, in
 * the reply or with create_mind, its input streamed. Told its write has no Citation, it cites and
 * writes it again with markers, or (`insists`) writes it again as it was.
 */
function afterSkip(
  language: Language,
  into: "reply" | "mind",
  { insists = false, givesNone = false }: { insists?: boolean; givesNone?: boolean } = {},
) {
  const asked: ModelCall[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    if (call.json) {
      if (call.system === CITE_RETRY_INSTRUCTIONS) asked.push(call);
      return { text: JSON.stringify({ citations: givesNone ? [] : citationsAsked(call) }) };
    }
    const results = (tool: string) => call.results.filter((each) => each.tool === tool);
    if (results("ask_user").length === 0) return { calls: [{ tool: "ask_user", input: WHICH }] };
    if (results("search_documents").length === 0) {
      return {
        calls: FACTS.map((fact) => ({ tool: "search_documents", input: { query: fact.query } })),
      };
    }
    const summary = summaryIn(language);
    if (into === "reply") return { text: `${ASSUMED[language]} ${summary}` };
    const written = (content: string) => ({
      calls: [
        { tool: "create_mind", input: { title: TITLE[language], content }, streamInput: true },
      ],
    });
    const heading = `# ${TITLE[language]}\n\n`;
    const writes = results("create_mind");
    if (writes.length === 0) return written(`${heading}${summary}`);
    if (refusedUncited(call)) {
      if (insists) return written(`${heading}${summary}`);
      const passages = results("search_documents").flatMap((each) => shownPassages(each.text));
      return {
        calls: [
          {
            tool: "cite",
            input: {
              citations: FACTS.map((fact, index) => ({
                marker: index + 1,
                passage: passages.find((each) => each.text.includes(fact.quote))?.id,
                quote: fact.quote,
              })),
            },
          },
        ],
      };
    }
    if (call.results.at(-1)?.tool === "cite") {
      return written(
        `${heading}${FACTS.map((fact, index) => `${fact[language]}[^${index + 1}]`).join("\n\n")}`,
      );
    }
    return { text: ASSUMED[language] };
  });
  return { model, asked };
}

async function summarise(core: Core, language: Language): Promise<ConversationAnswer> {
  core.on("question.asked", (request) => {
    void core.answerUserQuestion(request.requestId, { skipped: true });
  });
  return askAssistant(core, { text: REQUEST[language], mindId: null });
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each fact's sentence in the reply, as its Citation is: its Document, and whether its quote is found. */
function citedInReply(answer: ConversationAnswer, language: Language) {
  return FACTS.map((fact) => {
    const claim = escaped(fact[language].replace(/[.。]$/, ""));
    const marker = new RegExp(`${claim}\\[\\^(\\d+)\\]`).exec(answer.text)?.[1];
    const citation = answer.citations.find((each) => each.marker === Number(marker));
    return citation ? { document: citation.documentName, check: citation.check } : null;
  });
}

const madeChanges = (answer: ConversationAnswer): MindChange[] =>
  mindCalls(answer).flatMap((call) => (call.mindChange ? [call.mindChange] : []));

describe("A summary written after a skipped question cites each Document (#1415)", {
  timeout: 60_000,
}, () => {
  for (const language of ["en", "zh"] as const) {
    // protects=a summary written in the reply with no cite call gets a Citation on each Document's sentence, found, also in Chinese over English Documents, whose words share none; fails_when=the Chinese summary stays uncited, the model isn't asked for its Citations, or a sentence is cited from the wrong Document; no_claim=what a real model replies to the request for Citations (the hand check).
    test(`in the reply, in ${language}`, async () => {
      const { model, asked } = afterSkip(language, "reply");
      const { core } = await setUpWithDocuments(model, DOCUMENTS);

      const answer = await summarise(core, language);

      expect(answer.toolCalls[0]?.asked?.answer).toEqual({ skipped: true });
      expect(citedInReply(answer, language)).toEqual(
        FACTS.map((fact) => ({ document: fact.name.replace(".md", ""), check: "found" })),
      );
      if (language === "zh") expect(asked).toHaveLength(1);
      expect(answer.steps?.citedAfterChecking).toBe(3);
      expect(answer.steps?.notCitedAfterAsking).toBeUndefined();
    });

    // protects=a summary written into a Mind with no Citation, once Passages were read, is refused once with what to do, and written again cited: every paragraph of the Mind has a Citation, and no line says it is uncited; fails_when=the uncited text goes in, stays in the Mind beside the cited one, or the write is refused again; no_claim=the words a real model writes.
    test(`into a Mind, in ${language}`, async () => {
      const { model } = afterSkip(language, "mind");
      const { core } = await setUpWithDocuments(model, DOCUMENTS);

      const answer = await summarise(core, language);

      const writes = mindCalls(answer).filter((call) => call.tool === "create_mind");
      expect(writes.map((call) => call.status)).toEqual(["failed", "done"]);
      expect(writes[0]?.mindProblem?.kind).toBe("uncited");
      const [made] = madeChanges(answer);
      expect(made).toMatchObject({ created: true, cited: 3 });
      expect(made?.uncited).toBeUndefined();
      const minds = await core.listMinds();
      expect(minds.filter((mind) => mind.title === TITLE[language])).toHaveLength(1);
      const client = await connectToMind(core, made?.mindId ?? "");
      const paragraphs = client.blocks.toArray().slice(1);
      expect(paragraphs).toHaveLength(FACTS.length);
      for (const paragraph of paragraphs) {
        expect(paragraph.toString()).toContain(`<${CITATION_NODE}`);
      }
    });
  }

  // protects=a model that writes the uncited summary again as it was is refused only once: the Mind gets it, and its change says it has no Citation, for the line under the Answer; fails_when=it is refused twice, lost, or not marked uncited; no_claim=how the line is drawn (tests/renderer/changeProblems.test.ts).
  test("written again as it was, it goes in, marked uncited", async () => {
    const { model } = afterSkip("zh", "mind", { insists: true });
    const { core } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await summarise(core, "zh");

    const writes = mindCalls(answer).filter((call) => call.tool === "create_mind");
    expect(writes.map((call) => call.status)).toEqual(["failed", "done"]);
    expect(madeChanges(answer)).toEqual([
      expect.objectContaining({ created: true, uncited: true }),
    ]);
  });

  // protects=a Chinese summary of English Documents whose request for Citations gives none keeps no Citation, and its steps say it was asked and none came, for the line under it; fails_when=the steps say nothing, or a Citation is made up; no_claim=how the line is drawn (tests/renderer/changeProblems.test.ts).
  test("asked for Citations and given none, the reply says so", async () => {
    const { model, asked } = afterSkip("zh", "reply", { givesNone: true });
    const { core } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await summarise(core, "zh");

    expect(asked).toHaveLength(1);
    expect(answer.citations).toEqual([]);
    expect(answer.steps?.notCitedAfterAsking).toBe(true);
  });

  // protects=a Chinese reply that states nothing from the English Documents isn't asked for Citations: a greeting with the Documents given whole, and "didn't find" after a search; fails_when=either pays a request for Citations; no_claim=what a real model writes (the replay in the pull request).
  test.each([
    ["a greeting, the Documents given whole", "你好！有什么可以帮你？", false],
    ["“didn't find”, after a search", "我在你的文档中没有找到关于停车位的内容。", true],
  ])("%s, in Chinese, isn't asked", async (_, reply, searches) => {
    const asked: ModelCall[] = [];
    const model = scriptedModel((call): ScriptedReply => {
      if (call.json) {
        if (call.system === CITE_RETRY_INSTRUCTIONS) asked.push(call);
        return { text: JSON.stringify({ citations: [] }) };
      }
      if (searches && !call.results.some((each) => each.tool === "search_documents")) {
        return { calls: [{ tool: "search_documents", input: { query: "parking space" } }] };
      }
      return { text: reply };
    });
    const { core } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await askAssistant(core, { text: "你好", mindId: null });

    expect(answer.text).toBe(reply);
    expect(asked).toHaveLength(0);
    expect(answer.steps?.notCitedAfterAsking).toBeUndefined();
  });

  // protects=text written with no search before it isn't refused or marked, even with a small Library given whole with the Question; fails_when=a packing list is refused for want of Citations; no_claim=none beyond protects.
  test("text written with no search isn't refused", async () => {
    const model = scriptedModel((call) =>
      call.results.some((each) => each.tool === "create_mind")
        ? { text: "Wrote the list." }
        : {
            calls: [
              {
                tool: "create_mind",
                input: { title: "Packing", content: "# Packing\n\nPassport, charger and boots." },
              },
            ],
          },
    );
    const { core } = await setUpWithDocuments(model, DOCUMENTS);

    const answer = await askAssistant(core, { text: "Write my packing list", mindId: null });

    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(madeChanges(answer)[0]?.uncited).toBeUndefined();
  });
});
