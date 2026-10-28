/**
 * A scripted chat model for the smoke tests: no network and no keys. Only
 * test builds (`electron-vite build --mode test`) contain this file, and only
 * `INCARNAMIND_FAKE_CHAT=1` turns it on.
 *
 * A Question with "blank reply" in it gets a reply with no text at all. One with "refused request"
 * in it is refused as a provider refuses a request it can't take (HTTP 400), quoting it; one with
 * "overloaded" in it fails the first time it is asked, as its reply begins, as Anthropic's
 * "Overloaded" does. One with "out of credit", "wrong key", "too many requests" or "no connection"
 * in it fails as OpenAI answers an account with no credit (HTTP 429), a key it doesn't know (401)
 * and a rate limit (429) do, and as a request that never reaches the provider does. A model whose id ends
 * "-not-found" fails as one its provider doesn't know when it answers; one ending "-claims-not-found"
 * does when it finds or checks claims; one ending "-claims-offline" can't reach its provider the
 * first time it finds claims. A key with "refused" in it is refused,
 * as a provider refuses a wrong key (HTTP 401); one with "no-credit" in it
 * as a provider refuses an account with nothing left (HTTP 402). A model whose id ends "-no-tools" refuses
 * Tools and structured output, as a small server model does, so its Answers have no Citations.
 * A Document whose text says "slowly" takes a moment to tag or organize; one whose text says "unreachable"
 * can't reach the model the first time it is tagged or organized (nor on the retry that follows; one that
 * says "stays unreachable" never can), and one that says
 * "rate-limited" meets its rate limit.
 */

import { APICallError, StreamProviderError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { ChatModelFactory } from "../../core";
import { searchParts } from "./answers";
import { isCell } from "./cells";
import { fakeClaims, findsClaims } from "./claims";
import { fakeConfirm } from "./confirm";
import { editParts, fakeEdit } from "./edit";
import { asksForPlan, fakePlan } from "./plan";
import {
  type GenerateOptions,
  lastQuestion,
  lastUserText,
  SLOWLY,
  type StreamPart,
  USAGE,
} from "./prompt";
import { fakeResearchTags } from "./researchTags";
import { fakeSkillDraft } from "./skillDraft";
import { refusal, replyParts } from "./stream";
import {
  fakeStructuredOutput,
  SLOW_TAGGING_MS,
  tagsRateLimited,
  tagsSlowly,
  tagsUnreachable,
} from "./structured";

/** Time between two streamed words: slow enough for a test to watch the Answer grow. */
const WORD_DELAY_MS = 60;
/** For a Question asked "slowly": the wait before each step, and between two words of the Answer. */
const SLOW_STEP_MS = 1200;
const SLOW_WORD_MS = 250;
/** A scripted request asked "forever" writes nothing until it is stopped, or this long. */
const HOLD_MS = 120_000;
/** Between two words of Edit with AI's new text: a passage takes a moment, not seconds. */
const EDIT_WORD_MS = 10;

const QUESTION_FAILURES: readonly {
  when: RegExp;
  status?: number;
  message: string;
  type?: string;
}[] = [
  {
    when: /\bout of credit\b/i,
    status: 429,
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
  },
  { when: /\bwrong key\b/i, status: 401, message: "Incorrect API key provided." },
  { when: /\btoo many requests\b/i, status: 429, message: "Rate limit reached for requests" },
  { when: /\bno connection\b/i, message: "Cannot connect to API: fetch failed" },
];

/** The cells whose provider has refused them once already ("busy" in the Question). */
const refusedOnce = new Set<string>();
const offline = new Set<string>();
const overloadedOnce = new Set<string>();

/**
 * The scripted replies to a request that doesn't ask for JSON, in order: the first that
 * doesn't return null answers it.
 */
const GENERATE_HANDLERS: readonly ((options: GenerateOptions) => string | null)[] = [
  fakePlan,
  fakeResearchTags,
  fakeClaims,
  fakeConfirm,
  fakeSkillDraft,
  (options) => fakeEdit(options.prompt)?.text ?? null,
];

function generatedText(options: GenerateOptions): string {
  for (const handler of GENERATE_HANDLERS) {
    const text = handler(options);
    if (text !== null) return text;
  }
  return "OK";
}

export const createFakeChatModel: ChatModelFactory = (spec) =>
  new MockLanguageModelV4({
    provider: "incarnamind-fake",
    modelId: spec.modelId,
    // Structured output (automatic tagging) gets its Tags as JSON; Edit with AI its new text;
    // anything else (a connection test) gets "OK".
    doGenerate: async (options) => {
      const refused = refusal(spec, options);
      if (refused) throw refused;
      // A model id ending "-claims-not-found" is one its provider doesn't know when it checks or finds claims (#764).
      if (spec.modelId.endsWith("-claims-not-found")) {
        throw new APICallError({
          message: `The model ${spec.modelId} does not exist`,
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          statusCode: 404,
        });
      }
      // A model id ending "-claims-offline" can't reach its provider the first time it finds claims (#973).
      if (
        spec.modelId.endsWith("-claims-offline") &&
        findsClaims(options) &&
        !offline.has(spec.modelId)
      ) {
        offline.add(spec.modelId);
        throw new APICallError({
          message: "Cannot connect to API: fetch failed",
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          isRetryable: false,
        });
      }
      if (tagsSlowly(options)) await new Promise((resolve) => setTimeout(resolve, SLOW_TAGGING_MS));
      if (tagsUnreachable(options)) {
        throw new APICallError({
          message: "Cannot connect to API: fetch failed",
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          isRetryable: false,
        });
      }
      if (tagsRateLimited(options)) {
        throw new APICallError({
          message: "Rate limit reached for requests",
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "600" },
          isRetryable: true,
        });
      }
      // A model id ending "-always-thinks" thinks through its whole reply to a plan, as one with no off switch may (#1369).
      if (spec.modelId.endsWith("-always-thinks") && asksForPlan(options)) {
        return {
          content: [{ type: "text", text: "" }],
          finishReason: { unified: "length", raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              options.responseFormat?.type === "json"
                ? fakeStructuredOutput(options)
                : generatedText(options),
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },
    doStream: async ({ prompt, tools, abortSignal, responseFormat }) => {
      const refused = refusal(spec, {
        ...(tools && { tools }),
        ...(responseFormat && { responseFormat }),
      });
      if (refused) throw refused;
      // A model id ending "-not-found" is one its provider doesn't know, for a test of that Problem.
      if (spec.modelId.endsWith("-not-found")) {
        throw new APICallError({
          message: `The model ${spec.modelId} does not exist`,
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          statusCode: 404,
        });
      }
      // A busy provider refuses each "busy" cell's first request once, as an HTTP 429.
      const cell =
        isCell(prompt) && /\bbusy\b/i.test(lastQuestion(prompt)) ? lastUserText(prompt) : null;
      if (cell && !refusedOnce.has(cell)) {
        refusedOnce.add(cell);
        throw new APICallError({
          message: "Too Many Requests",
          url: "http://127.0.0.1/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: false,
        });
      }
      const question = lastQuestion(prompt);
      if (/refused request/i.test(question)) {
        throw new APICallError({
          message: `messages.0.content: "${question}" can't be taken`,
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          statusCode: 400,
        });
      }
      const scripted = QUESTION_FAILURES.find(({ when }) => when.test(question));
      if (scripted) {
        const { status, message, type } = scripted;
        throw new APICallError({
          message,
          url: "https://fake.invalid/chat",
          requestBodyValues: {},
          ...(status && { statusCode: status }),
          ...(type && { responseBody: JSON.stringify({ error: { message, type, code: type } }) }),
          isRetryable: false,
        });
      }
      if (/\boverloaded\b/i.test(question) && !overloadedOnce.has(question)) {
        overloadedOnce.add(question);
        const overloaded = new StreamProviderError({
          message: "Overloaded",
          type: "overloaded_error",
          statusCode: 529,
        });
        return {
          stream: new ReadableStream<StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "error", error: overloaded });
              controller.close();
            },
          }),
        };
      }
      const search = tools?.find((each) => each.type === "provider");
      const edit = search ? null : fakeEdit(prompt);
      const parts = search
        ? searchParts(search.name, lastQuestion(prompt))
        : edit
          ? editParts(edit.text)
          : replyParts(prompt, tools ?? []);
      // A check of a sentence that says "slowly" reports slowly too, as a Question asked slowly
      // does, so a spec can open its card while the check still runs.
      const checked = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(lastUserText(prompt))?.[1] ?? "";
      const slow = edit ? edit.slow : !search && SLOWLY.test(`${lastQuestion(prompt)} ${checked}`);
      const holds = edit?.holds || (!search && /\bforever\b/i.test(checked));
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const stream = new ReadableStream<StreamPart>({
        async pull(controller) {
          const part = parts.shift();
          if (!part) {
            controller.close();
            return;
          }
          if (holds && part.type === "stream-start") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, HOLD_MS);
              abortSignal?.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          if (slow && part.type === "stream-start") await wait(SLOW_STEP_MS);
          // A slow cell's words stand a moment before its Answer ends, for a test to see them.
          if (
            slow &&
            part.type === "finish" &&
            part.finishReason.unified === "stop" &&
            isCell(prompt)
          ) {
            await wait(SLOW_STEP_MS);
          }
          if (part.type === "text-delta" || part.type === "tool-input-delta") {
            await wait(slow ? SLOW_WORD_MS : edit ? EDIT_WORD_MS : WORD_DELAY_MS);
          }
          if (slow && part.type === "reasoning-delta") await wait(WORD_DELAY_MS);
          if (abortSignal?.aborted) {
            controller.error(new DOMException("The request was aborted.", "AbortError"));
            return;
          }
          controller.enqueue(part);
        },
      });
      return { stream };
    },
  });
