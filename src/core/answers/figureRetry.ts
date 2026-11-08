/**
 * Structured output's one second chance at calculated figures (ADR-0021), as
 * ./quoteRetry is at quotes. In the Tool loop, `calculate` tells the model in
 * one line why a figure can't be worked out, and it fixes it. A local model in
 * structured output gets no word back, so once its Answer is written, the
 * figures it gave that couldn't be worked out are asked for once more, in one
 * request: each figure as it was given, why, and the text of the Passages its
 * inputs name. Those it gives again are taken as `calculate` takes them; a
 * figure still in error is dropped, its marker left out of the text, and the
 * Answer's end says how many couldn't be calculated.
 *
 * Only for a local model (the engine passes a window budget), at most once per
 * Answer, and only when a figure is in error and its marker is in the text.
 */
import { jsonSchema } from "ai";
import { outputTokens } from "../providers/outputLimits";
import { givenList, whole } from "./calculations";
import { calculationsSchema } from "./calculationsSchema";
import type { AnswerEngineEvent, AnswerRequest } from "./engine";
import { byKey, fieldsOf, judge, structured } from "./judge";
import {
  FIGURE_RETRY_INSTRUCTIONS,
  type FigureToRetry,
  figureRetryParts,
  figureRetryPrompt,
  RETRY_TAGS,
  setAsideRowsMeaning,
} from "./prompt";
import { nearestExcerpt } from "./quoteRetry";
import type { WindowBudget } from "./window";

/** The most figures one request asks about: the first ones, by marker. */
export const MAX_RETRIED_FIGURES = 6;
/** The most of a Passage's text a figure gets, in the window's estimated tokens. */
const EXCERPT_TOKENS = 400;
/** Less than this of a Passage isn't worth asking with: no request is made. */
const MIN_EXCERPT_TOKENS = 96;

const figuresSchema = jsonSchema<{ calculations: unknown }>({
  type: "object",
  properties: { calculations: calculationsSchema },
  required: ["calculations"],
});

/** The request's reply, in structured output: the figures given again. */
export const FIGURES_REPLY = structured(figuresSchema, "calculations", (value) => {
  // A provider may give the list as JSON text, as the Answer's own figures may come.
  const reply = fieldsOf(value, {
    calculations: (given) =>
      Array.isArray(given) || typeof given === "string" ? givenList(given) : undefined,
  });
  return reply?.calculations ?? null;
});

/**
 * Once a local model's Answer in structured output is written (`answer`):
 * asks for the figures that couldn't be worked out, once, and takes those it
 * then can. Yields the "checking-figures" phase before the request and
 * "figures-retried" after it; nothing when every figure was worked out, or
 * the request couldn't fit the window. A failed request changes nothing.
 */
export async function* retryFigures(
  request: Pick<AnswerRequest, "model" | "documents" | "signal">,
  answer: string,
  temperature: number | undefined,
  budget: WindowBudget,
): AsyncGenerator<AnswerEngineEvent> {
  const { documents, signal } = request;
  if (!documents.figureProblems || !documents.calculate) return;
  const problems = documents
    .figureProblems()
    .filter((problem) => answer.includes(`[=${problem.marker}]`))
    .slice(0, MAX_RETRIED_FIGURES);
  if (problems.length === 0) return;
  const passages = problems.reduce((count, problem) => count + problem.passages.length, 0);
  const maxOutputTokens = outputTokens("figure-retry", problems.length);
  const framing = figureRetryPrompt(
    problems.map((problem) => ({
      ...problem,
      passages: problem.passages.map((passage) => ({ ...passage, text: "" })),
    })),
  );
  const meaning = setAsideRowsMeaning(
    problems.flatMap((problem) => problem.passages.map((passage) => passage.text)).join("\n"),
  );
  const room = budget.roomBeside([FIGURE_RETRY_INSTRUCTIONS, framing, meaning], maxOutputTokens);
  const perPassage = Math.min(EXCERPT_TOKENS, Math.floor(room / Math.max(1, passages)) - 1);
  if (perPassage < MIN_EXCERPT_TOKENS) return;
  const asked: FigureToRetry[] = problems.map((problem) => ({
    ...problem,
    passages: problem.passages.map((passage) => ({
      id: passage.id,
      text: nearestExcerpt(passage.text, problem.given, problem.given, perPassage, budget.tokens),
    })),
  }));

  yield { type: "phase", phase: "checking-figures" };
  const started = Date.now();
  const markers = new Set(asked.map((figure) => figure.marker));
  const judged = await judge({
    model: request.model,
    question: { id: "figure-retry", instructions: FIGURE_RETRY_INSTRUCTIONS },
    parts: figureRetryParts(asked),
    data: RETRY_TAGS,
    reply: FIGURES_REPLY,
    items: problems.length,
    // One request, never more: a failure leaves the figures out, as they were.
    retries: 0,
    signal,
    temperature,
    stream: true,
  });
  if (!judged.ok && judged.reason === "stopped") return;
  if (!judged.ok && judged.error)
    console.error(`The figures couldn't be asked for again: ${judged.error.message}`);
  // A figure given twice stays out, as it was.
  const fixed = [
    ...byKey(judged.ok ? judged.value : [], (figure) => {
      const marker = whole((figure as { marker?: unknown } | null)?.marker);
      return marker !== null && markers.has(marker) ? marker : undefined;
    }).values(),
  ];
  if (fixed.length > 0) {
    try {
      documents.calculate(fixed, { structured: true });
    } catch (error) {
      console.error(
        `The fixed figures couldn't be worked out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const unfixed = new Set(documents.figureProblems().map((problem) => problem.marker));
  yield {
    type: "figures-retried",
    retry: {
      figures: asked.length,
      recovered: asked.filter((figure) => !unfixed.has(figure.marker)).length,
      durationMs: Date.now() - started,
    },
  };
}
