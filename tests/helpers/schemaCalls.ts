import { generateText, Output } from "ai";
import { unbackedClaims } from "../../src/core/answers/claimedChanges";
import {
  type AnswerEngineEvent,
  type AnswerTools,
  createAiSdkAnswerEngine,
} from "../../src/core/answers/engine";
import { retryFigures } from "../../src/core/answers/figureRetry";
import { retryQuotes } from "../../src/core/answers/quoteRetry";
import { citeUnmarked } from "../../src/core/answers/unmarkedQuotes";
import { createWindowBudget } from "../../src/core/answers/window";
import { chatGroupClassifier } from "../../src/core/library/classifier";
import type { ChatLanguageModel } from "../../src/core/providers/models";
import { suggestionSchema } from "../../src/core/suggestions/prompt";
import { chatClassifier } from "../../src/core/tags/classify";

/** Every call under src/core that makes a model reply to a schema, and the names of the schemas it sends. */
export const SCHEMA_CALLS = {
  "answers/claimedChanges.ts": ["change-claims"],
  "answers/engine.ts": ["answer"],
  "answers/figureRetry.ts": ["calculations"],
  "answers/quoteRetry.ts": ["quotes"],
  "answers/unmarkedQuotes.ts": ["citations"],
  "library/classifier.ts": ["document_group", "folder_proposals"],
  "suggestions/index.ts": ["suggestion"],
  "tags/classify.ts": ["document_tags"],
} as const;

const PASSAGE = "Spring tides happen at new moon and at full moon.";
export const QUOTE = "Spring tides come at new and full moon";
export const FIGURE = {
  marker: 1,
  label: "Change in gross margin",
  formula: "gm2025 - gm2024",
  inputs: [{ name: "gm2025", label: "Gross margin 2025", citation: 1, number: "42.1%" }],
};

/** The Answer's text when the retries are asked: one Citation without a record, one figure. */
const ANSWER = `${QUOTE} [^1]. Gross margin rose [=1].`;

const WINDOW = { tokens: 8_192, outputTokens: 1_024 };

export const documents: AnswerTools = {
  documentCount: 1,
  async searchDocuments() {
    return {
      text: `<passage id="P1" document="Tides.md" pages="1">\n${PASSAGE}\n</passage>`,
      passageCount: 1,
    };
  },
  cite: () => "Recorded.",
  hasRecord: () => false,
  shownPassages: () => [{ id: "P1", text: PASSAGE }],
  quoteFound: () => false,
  unfoundQuotes: () => [{ marker: 1, passage: "P1", quote: QUOTE, text: PASSAGE }],
  correctQuote: () => false,
  calculate: () => "",
  figureProblems: () => [
    {
      marker: 1,
      given: JSON.stringify(FIGURE),
      problems: ['[=1] gm2025: the quote has no number "42.1%".'],
      passages: [{ id: "P1", text: PASSAGE }],
    },
  ],
};

async function finish(events: AsyncIterable<AnswerEngineEvent>) {
  const all: AnswerEngineEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** Sends one request of every call that makes a model reply to a schema, through its own entry point. */
export async function callEverySchema(model: ChatLanguageModel): Promise<AnswerEngineEvent[]> {
  const signal = new AbortController().signal;
  await unbackedClaims("Done, the summary is on the page.", [], [], null, {
    model,
    names: () => null,
    signal,
  });
  const tags = [{ id: "t-report", name: "Report", description: "A report of findings" }];
  const excerpt = { name: "QBR", kind: "pdf" as const, pageCount: 2, text: "Quarterly review." };
  await chatClassifier(model).decide({ tags, excerpt, signal });
  await chatGroupClassifier(model, false).organize(
    [
      {
        id: "g-reports",
        name: "Reports",
        description: "Reports",
        parentId: null,
        countsOwnFiles: false,
        keepInside: false,
        createdAt: "",
        updatedAt: "",
      },
    ],
    tags,
    excerpt,
    signal,
  );
  await chatGroupClassifier(model, false).proposeFolders?.(
    [{ name: "QBR", type: "PDF, 2 pages", text: "Quarterly review." }],
    [],
    "en",
    signal,
  );
  await generateText({
    model,
    prompt: "Continue the paragraph: Spring tides come at new moon.",
    output: Output.object({ schema: suggestionSchema, name: "suggestion" }),
    maxRetries: 0,
  });

  const window = WINDOW;
  const request = { model, documents, signal };
  await finish(retryQuotes(request, ANSWER, undefined, createWindowBudget(window)));
  await finish(citeUnmarked(request, ANSWER, undefined, createWindowBudget(window)));
  await finish(retryFigures(request, ANSWER, undefined, createWindowBudget(window)));
  return answerByStructuredOutput(model, documents);
}

/** An Answer written as one JSON object, for a model that can't call Tools. */
export function answerByStructuredOutput(model: ChatLanguageModel, tools: AnswerTools = documents) {
  return finish(
    createAiSdkAnswerEngine().generate({
      instructions: () => "Answer from the Passages.",
      messages: [{ role: "user", content: "When are spring tides?" }],
      question: "When are spring tides?",
      model,
      documents: tools,
      tools: [],
      support: "structured-output",
      window: WINDOW,
      signal: new AbortController().signal,
    }),
  );
}
