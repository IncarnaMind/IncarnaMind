/**
 * What a cited sentence's check asked its model and was told, read from the requests it made
 * (#3019): each quote the model gave the cite Tool with the Citation check's answer, and each
 * run's replies. A sentence the check splits into parts has a run for each part.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { DOCUMENT_TOOLS } from "../../src/core/tools";
import type { HeardRequest } from "../lib/tokens";

export interface TypedQuote {
  marker: number | null;
  passage: string | null;
  quote: string;
  /** The cite Tool recorded its marker and named no problem for it. */
  found: boolean;
  /** What the cite Tool told the model for the call that gave it. */
  answer: string;
}

export interface HeardCheck {
  /** What the run was asked to check, the sentence or one of its parts; null for a request that names none. */
  claim: string | null;
  quotes: TypedQuote[];
  /** The run's replies with text, in order: its verdict, and any ask after it. */
  replies: string[];
}

const MOST_ANSWER = 800;
const MOST_REPLY = 3000;

const SENTENCE = /<sentence>\n([\s\S]*?)\n<\/sentence>/;

function claimOf(prompt: LanguageModelV4Prompt): string | null {
  const first = prompt.find((message) => message.role === "user");
  if (!first) return null;
  const text = first.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return SENTENCE.exec(text)?.[1]?.trim() ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function inputOf(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function outputText(output: unknown): string {
  const { value } = asRecord(output);
  return typeof value === "string" ? value : JSON.stringify(value ?? output);
}

/** Whether the cite Tool's answer recorded `marker` and named no problem for it. */
function recorded(answer: string, marker: number | null): boolean {
  if (marker === null) return false;
  const done = /^(Recorded [^.]*)\./.exec(answer)?.[1] ?? "";
  return done.includes(`[^${marker}]`) && !answer.includes(`[^${marker}]: `);
}

function quotesIn(prompts: readonly LanguageModelV4Prompt[]): TypedQuote[] {
  const calls = new Map<string, unknown>();
  const results = new Map<string, string>();
  for (const message of prompts.flat()) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.toolName === DOCUMENT_TOOLS.cite)
          calls.set(part.toolCallId, inputOf(part.input));
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result" && part.toolName === DOCUMENT_TOOLS.cite)
          results.set(part.toolCallId, outputText(part.output));
      }
    }
  }
  return [...calls].flatMap(([id, input]) => {
    const answer = results.get(id) ?? "";
    const { citations } = asRecord(input);
    return (Array.isArray(citations) ? citations : []).map((each): TypedQuote => {
      const { marker, passage, quote } = asRecord(each);
      const number = typeof marker === "number" ? marker : Number(marker);
      const known = Number.isInteger(number) ? number : null;
      return {
        marker: known,
        passage: typeof passage === "string" ? passage : null,
        quote: typeof quote === "string" ? quote : JSON.stringify(quote ?? null),
        found: recorded(answer, known),
        answer: answer.slice(0, MOST_ANSWER),
      };
    });
  });
}

/** The check's runs in the order each was first asked, from the requests a check made. */
export function heardChecks(requests: readonly HeardRequest[]): HeardCheck[] {
  const runs = new Map<string | null, HeardRequest[]>();
  for (const request of requests) {
    const claim = claimOf(request.prompt);
    runs.set(claim, [...(runs.get(claim) ?? []), request]);
  }
  return [...runs].map(([claim, asked]) => ({
    claim,
    quotes: quotesIn(asked.map((request) => request.prompt)),
    replies: asked.flatMap(({ text }) => (text.trim() === "" ? [] : [text.slice(0, MOST_REPLY)])),
  }));
}
