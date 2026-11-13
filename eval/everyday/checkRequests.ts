/**
 * What a cited sentence's check asked its model and was told, read from the requests it made
 * (#3019): each quote the model gave the cite Tool with the Citation check's answer, and each
 * run's replies. A sentence the check splits into parts has a run for each part.
 */
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import {
  COVERED_EVIDENCE_INSTRUCTIONS,
  EVIDENCE_INSTRUCTIONS,
} from "../../src/core/answers/checks/prompt";
import { writtenRecords } from "../../src/core/answers/checks/writtenRecords";
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
  /** The run's replies with text, in order: its verdict, and any ask after it; none kept for a Supported sentence. */
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

function byClaim(requests: readonly HeardRequest[]): Map<string | null, HeardRequest[]> {
  const runs = new Map<string | null, HeardRequest[]>();
  for (const request of requests) {
    const claim = claimOf(request.prompt);
    runs.set(claim, [...(runs.get(claim) ?? []), request]);
  }
  return runs;
}

/** How many of the requests were sent word for word as an earlier one: a look asked anew. */
export function askedAnew(requests: readonly HeardRequest[]): number {
  const seen = new Set<string>();
  let again = 0;
  for (const { prompt } of requests) {
    const key = JSON.stringify(prompt);
    if (seen.has(key)) again++;
    seen.add(key);
  }
  return again;
}

const loose = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const asksForEvidence = ({ prompt }: HeardRequest) => {
  const system = prompt
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n");
  return [EVIDENCE_INSTRUCTIONS, COVERED_EVIDENCE_INSTRUCTIONS].some((instructions) =>
    system.includes(instructions),
  );
};

/**
 * The quotes a check took from the records its replies wrote into their text (#3032): a run's
 * record that no cite call of it typed. A run that asked for evidence is left out, since that
 * ask's reply may give the same quote.
 */
export function quotesTakenFromReplies(requests: readonly HeardRequest[]): Set<string> {
  const taken = new Set<string>();
  for (const asked of byClaim(requests).values()) {
    if (asked.some(asksForEvidence)) continue;
    const typed = new Set(
      quotesIn(asked.map((request) => request.prompt)).map(({ quote }) => loose(quote)),
    );
    for (const { text } of asked)
      for (const { quote } of writtenRecords(text))
        if (!typed.has(loose(quote))) taken.add(loose(quote));
  }
  return taken;
}

/** Whether `quote` is one of `taken` (`quotesTakenFromReplies`). */
export const takenQuote = (taken: ReadonlySet<string>, quote: string) => taken.has(loose(quote));

/** The check's runs in the order each was first asked, from the requests a check made. */
export function heardChecks(requests: readonly HeardRequest[]): HeardCheck[] {
  return [...byClaim(requests)].map(([claim, asked]) => ({
    claim,
    quotes: quotesIn(asked.map((request) => request.prompt)),
    replies: asked.flatMap(({ text }) => (text.trim() === "" ? [] : [text.slice(0, MOST_REPLY)])),
  }));
}
