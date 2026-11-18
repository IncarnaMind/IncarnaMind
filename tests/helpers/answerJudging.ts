/**
 * A scripted model that answers in the assistant with Citations and judges the Answer's sentences
 * (#2311), for tests of what an Answer's check shows.
 */
import { checkGenerate, checkReply, isCheckRun, type Plan } from "./checks";
import { shownPassages } from "./citations";
import { type GenerateCall, type GeneratedReply, type ModelCall, scriptedModel } from "./models";

/**
 * A batch of an Answer's sentences judged as `plans` say (#2311): each its plan's verdict and what
 * it says, unsupported with no plan; those in `opinions` sorted all opinion.
 */
export function batchReply(
  call: GenerateCall,
  plans: Record<string, Plan>,
  opinions: readonly string[] = [],
): GeneratedReply {
  const sentences = [
    ...call.prompt.matchAll(/<sentence number="(\d+)">\n([\s\S]*?)\n<\/sentence>/g),
  ];
  return {
    text: JSON.stringify({
      sentences: sentences.map(([, number, sentence = ""]) => ({
        number: Number(number),
        kind: opinions.includes(sentence) ? "opinion" : "fact",
        verdict: plans[sentence]?.verdict ?? "unsupported",
        roles: "same",
        time: "same",
        quoted: "states",
        says: plans[sentence]?.says ?? null,
      })),
    }),
  };
}

const isBatch = (call: GenerateCall) => call.question === "sentence-batch";

/**
 * A model that searches for `query`, answers with `answer`, citing `quotes` as markers 1, 2…, and
 * judges its sentences as `plans` say, or as `judge` replies to each batch; every streamed request
 * it is sent is kept in `calls`.
 */
export function answeringModel(
  query: string,
  answer: string,
  quotes: readonly string[],
  plans: Record<string, Plan>,
  {
    calls = [],
    opinions = [],
    judge,
  }: {
    calls?: ModelCall[];
    opinions?: readonly string[];
    judge?: (call: GenerateCall) => GeneratedReply;
  } = {},
) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (isCheckRun(call)) return checkReply(call, plans);
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0) {
        return { calls: [{ tool: "search_documents", input: { query } }] };
      }
      if (!call.results.some((result) => result.tool === "cite")) {
        const passages = shownPassages(searches.at(-1)?.text ?? "");
        const citations = quotes.map((quote, index) => ({
          marker: index + 1,
          passage: passages.find((each) => each.text.includes(quote))?.id,
          quote,
        }));
        return { calls: [{ tool: "cite", input: { citations } }] };
      }
      return { text: answer };
    },
    {
      generate: (call) => {
        if (isBatch(call)) return judge?.(call) ?? batchReply(call, plans, opinions);
        return checkGenerate(plans)(call);
      },
    },
  );
}
