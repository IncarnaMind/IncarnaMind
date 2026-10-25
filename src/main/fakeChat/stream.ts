/**
 * With Connectors: a Question that names one of their Tools (e.g. "book_boat")
 * gets it called once first, its required arguments set to the Question's
 * last word; the Answer then starts with what the call gave back.
 *
 * With Skill scripts: a Question that names a listed Skill and one of its
 * scripts by path (e.g. "greeter scripts/hello.js") gets it run once first
 * with run_skill_script, with the Question's last word as its one argument;
 * the Answer then starts with what the script printed (or why it didn't run).
 * A Question that names a script and a Connector Tool gets both, the script
 * first, and the Answer starts with what each said.
 *
 * With Find sources (a Question that names papers): it calls find_sources
 * once, for the words after "on" (and the year after "since"), then lists
 * the first three titles it found.
 *
 * With web search (#128): it searches the web for the Question, reads each
 * page found, one call each, then cites the first page it could read as it
 * cites a search's Passages. Asked to search with its provider's own tool,
 * it finds `FOUND_PAGES`, whatever the query.
 */

import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import type { ChatModelSpec } from "../../core";
import { answerReply, CITED_ANSWER, skillNamed } from "./answers";
import { asksReply } from "./asks";
import { CHECK_RUN, checkReply } from "./checks";
import { commandsReply } from "./commands";
import { fillReply } from "./meetingFill";
import { helpReply } from "./meetingHelp";
import { mindRead, mindsReply } from "./minds";
import { passagesIn, recordsFor } from "./passages";
import {
  allResults,
  lastQuestion,
  lastResult,
  type Prompt,
  type Reply,
  type StreamPart,
  systemOf,
  toolResults,
  USAGE,
} from "./prompt";

type OfferedTool = NonNullable<Parameters<MockLanguageModelV4["doStream"]>[0]["tools"]>[number];

/** The last word of a Question, without punctuation: what a scripted call passes on. */
function lastWordOf(question: string): string {
  return (
    question
      .split(/\s+/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/[^\p{L}\p{N}_-]/gu, "") ?? ""
  );
}

/**
 * A Connector Tool the Question names by its own name (after the Connector's
 * prefix, e.g. "book_boat" for "tides__book_boat"), with every required
 * argument set to the Question's last word.
 */
function connectorToolNamed(
  question: string,
  tools: readonly OfferedTool[],
): { tool: string; own: string; input: Record<string, string> } | null {
  const lastWord = lastWordOf(question);
  for (const each of tools) {
    if (each.type !== "function") continue;
    const own = each.name.split("__")[1];
    if (!own || !question.toLowerCase().includes(own.toLowerCase())) continue;
    const required = (each.inputSchema as { required?: unknown }).required;
    const names = Array.isArray(required)
      ? required.filter((name): name is string => typeof name === "string")
      : [];
    return {
      tool: each.name,
      own,
      input: Object.fromEntries(names.map((name) => [name, lastWord])),
    };
  }
  return null;
}

/**
 * What a Question asking for papers searches for: the words after "on", and
 * the year after "since" ("Find papers since 2021 on CRISPR off-target detection").
 */
function sourcesQuery(question: string): { query: string; from_year?: number } {
  const since = /\bsince (\d{4})\b/i.exec(question)?.[1];
  const topic = /\bon (.+?)[.?!]*$/i.exec(question)?.[1] ?? question;
  return { query: topic, ...(since && { from_year: Number(since) }) };
}

/** A Skill script the Question names, with a listed Skill: to run with run_skill_script. */
function scriptNamed(
  prompt: Prompt,
  question: string,
  tools: readonly string[],
): { skill: string; script: string; args: string[] } | null {
  if (!tools.includes("run_skill_script")) return null;
  const script = /(\S+\.(?:js|mjs|cjs|py|sh))(?=\s|$)/.exec(question)?.[1];
  const skill = skillNamed(prompt, question);
  return script && skill ? { skill, script, args: [lastWordOf(question)] } : null;
}

/**
 * What the model does next. A Question that names a Skill script, or a
 * Connector Tool, or both, gets each called once first (the script first),
 * and the Answer starts with what each said (e.g. that the User denied it).
 */
function nextReply(prompt: Prompt, tools: readonly OfferedTool[]): Reply {
  const names = tools.map((tool) => tool.name);
  if (CHECK_RUN.test(systemOf(prompt))) return checkReply(prompt, names);
  const help = helpReply(prompt, names);
  if (help) return help;
  const fill = fillReply(prompt, names);
  if (fill) return fill;
  const question = lastQuestion(prompt);
  if (/blank reply/i.test(question)) return { text: "" };
  /** What the calls made first said, in order. */
  const said: string[] = [];
  const asks = asksReply(prompt, question, names);
  if (asks) return asks;
  const commands = commandsReply(prompt, question, names);
  if (commands) return commands;
  const minds = mindsReply(prompt, question, names);
  if (minds) return minds;
  const run = scriptNamed(prompt, question, names);
  if (run) {
    const result = lastResult(prompt, "run_skill_script");
    if (result === undefined) return { tool: "run_skill_script", input: run };
    // What it printed, or the whole result when it didn't run.
    const printed = /<stdout>\n([\s\S]*?)\n?<\/stdout>/.exec(result)?.[1] ?? result;
    said.push(`${run.script} said: ${printed}`);
  }
  const named = connectorToolNamed(question, tools);
  if (named) {
    const result = lastResult(prompt, named.tool);
    if (result === undefined) return { tool: named.tool, input: named.input };
    said.push(`${named.own} said: ${result}`);
  }
  // As a real model does: only a Question that asks for papers searches for them.
  if (names.includes("find_sources") && /\bpapers?\b/i.test(question)) {
    const found = lastResult(prompt, "find_sources");
    if (found === undefined) return { tool: "find_sources", input: sourcesQuery(question) };
    const titles = [...found.matchAll(/^\d+\. "([^"]+)"/gm)].slice(0, 3).map((match) => match[1]);
    return {
      text:
        titles.length > 0
          ? ["I found these papers:", "", ...titles.map((title) => `- ${title}`)].join("\n")
          : "I found no papers.",
    };
  }
  const mindLine = mindRead(prompt);
  if (mindLine) said.unshift(mindLine);
  if (names.includes("search_web")) {
    const searched = lastResult(prompt, "search_web");
    if (searched === undefined) return { tool: "search_web", input: { query: question } };
    const found = [...searched.matchAll(/^\d+\. .*?: (https?:\/\/\S+)/gm)].map((match) => match[1]);
    const reads = allResults(prompt, "read_web_page");
    const next = found[reads.length];
    if (next) return { tool: "read_web_page", input: { url: next, query: question } };
    const read = reads.find((each) => passagesIn(each).length > 0);
    if (!read) return { text: "I couldn't save any of the pages I found." };
    if (toolResults(prompt, "cite").length === 0) {
      return { tool: "cite", input: { citations: recordsFor(read, question) } };
    }
    return { text: CITED_ANSWER };
  }
  const reply = answerReply(prompt, names);
  return "text" in reply && said.length > 0 ? { text: [...said, reply.text].join("\n\n") } : reply;
}

/** The Minds' Tools whose input the scripted provider streams. */
const STREAMED_INPUT: ReadonlySet<string> = new Set(["add_to_mind", "create_mind"]);

/** The scripted reply to a request, as it streams: its reasoning, then a Tool call or its Answer. */
export function replyParts(prompt: Prompt, tools: readonly OfferedTool[]): StreamPart[] {
  const reply = nextReply(prompt, tools);
  const parts: StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (reply.reasoning) {
    parts.push(
      { type: "reasoning-start", id: "thinking" },
      ...reply.reasoning
        .split(/(?<=\s)/)
        .map((word): StreamPart => ({ type: "reasoning-delta", id: "thinking", delta: word })),
      { type: "reasoning-end", id: "thinking" },
    );
  }
  if ("tool" in reply) {
    // Calls of one Tool after its first, such as a second page read, have ids of their own.
    const earlier = allResults(prompt, reply.tool).length;
    const toolCallId = earlier === 0 ? `fake-${reply.tool}` : `fake-${reply.tool}-${earlier + 1}`;
    const input = JSON.stringify(reply.input);
    // A Minds' Tool that writes new text gets its input word by word, as a provider streams it.
    if (STREAMED_INPUT.has(reply.tool)) {
      parts.push(
        { type: "tool-input-start", id: toolCallId, toolName: reply.tool },
        ...input
          .split(/(?<=\s)/)
          .map((delta): StreamPart => ({ type: "tool-input-delta", id: toolCallId, delta })),
        { type: "tool-input-end", id: toolCallId },
      );
    }
    parts.push(
      { type: "tool-call", toolCallId, toolName: reply.tool, input },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
    );
    return parts;
  }
  const words = reply.text.split(/(?<=\s)/);
  parts.push(
    { type: "text-start", id: "answer" },
    ...words.map((word): StreamPart => ({ type: "text-delta", id: "answer", delta: word })),
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  );
  return parts;
}

/** What a provider says of a wrong key, or of a model that can't use Tools or structured output. */
export function refusal(
  spec: ChatModelSpec,
  options: { tools?: unknown[]; responseFormat?: { type: string } },
) {
  if (spec.apiKey?.includes("refused")) {
    return new APICallError({
      message: "invalid x-api-key",
      url: "https://fake.invalid/chat",
      requestBodyValues: {},
      statusCode: 401,
    });
  }
  if (!spec.modelId.endsWith("-no-tools")) return null;
  const asked =
    (options.tools?.length ?? 0) > 0
      ? `registry.ollama.ai/library/${spec.modelId} does not support tools`
      : options.responseFormat?.type === "json"
        ? "response_format is not supported by this model"
        : null;
  return asked
    ? new APICallError({
        message: asked,
        url: "http://127.0.0.1/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
      })
    : null;
}
