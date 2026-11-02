/**
 * What a whole-Note check's sort asked a real model and how it decided each table cell (#2447),
 * for the live tests' reports.
 */
import type { LanguageModelMiddleware } from "ai";
import { readClaimParts } from "../../src/core/answers/checks/claims";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import type { MindClient } from "./mindClient";
import { readMind } from "./minds";

export interface SortCall {
  asked: { number: number; text: string; row?: string; column?: string }[];
  reply: string;
}

/**
 * Keeps each sort request and its reply until the first check streams: the Note's own sort, and
 * not a sentence a check sorts alone, which numbers its one sentence 1 again.
 */
export function sortRecorder(onCall?: (call: SortCall) => Promise<void>) {
  const calls: SortCall[] = [];
  let checking = false;
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const [system, user] = params.prompt;
      if (
        !checking &&
        system?.role === "system" &&
        system.content.startsWith("You sort the sentences") &&
        user?.role === "user"
      ) {
        const prompt = user.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        const reply = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
        const { sentences } = JSON.parse(prompt.join("")) as { sentences: SortCall["asked"] };
        const call = { asked: sentences, reply: reply.join("") };
        calls.push(call);
        await onCall?.(call);
      }
      return result;
    },
    wrapStream: async ({ doStream }) => {
      checking = true;
      return doStream();
    },
  };
  return { calls, middleware };
}

/**
 * How the sort decided each sentence it was shown whose words are among `cells`, read as the core
 * reads its replies: a later ask decides what the earlier left unsaid.
 */
export function sortedCells(calls: readonly SortCall[], cells: ReadonlySet<string>) {
  const decided = new Map<number, "claim" | "none">();
  const asked = new Map<number, string>();
  for (const call of calls) {
    for (const each of call.asked) asked.set(each.number, each.text);
    for (const [number, parts] of readClaimParts(call.reply, call.asked) ?? []) {
      if (!decided.has(number))
        decided.set(number, parts.some((part) => part.kind === "fact") ? "claim" : "none");
    }
  }
  const counts = { cells: 0, claim: 0, none: 0, undecided: 0 };
  const notClaims: string[] = [];
  for (const [number, words] of asked) {
    if (!cells.has(words.trim())) continue;
    counts.cells++;
    const how = decided.get(number) ?? "undecided";
    counts[how]++;
    if (how !== "claim") notClaims.push(words);
  }
  return { ...counts, notClaims };
}

/** What each check made of a sentence whose words are among `words`, such as a row's label. */
export const checksOn = (client: Pick<MindClient, "blocks">, words: ReadonlySet<string>) =>
  claimSpans(readMind(client))
    .filter((span) => words.has(span.sentence.text.trim()))
    .map((span) => ({
      text: span.sentence.text.trim(),
      state: span.check.state,
      reason: span.check.reason,
    }));
