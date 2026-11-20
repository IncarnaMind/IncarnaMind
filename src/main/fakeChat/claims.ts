import {
  CLAIM_CHECK_INSTRUCTIONS,
  REQUEST_DONE_INSTRUCTIONS,
} from "../../core/answers/claimedChanges";
import { REMOVAL_ASKED_INSTRUCTIONS } from "../../core/edits/removalAsked";
import { isClaim } from "../../shared/sentences";
import { type GenerateOptions, lastUserText, systemOf } from "./prompt";

/** Finding the claims of a verified document (#97) or of the User's own draft (#737), src/core/answers/checks/claims.ts. */
const FIND_CLAIMS =
  /^You sort the sentences of (?:a document someone else wrote|the User's own draft)/m;

/** Whether a request is one to find the claims among numbered sentences. */
/** The words by which the fake model takes a sentence for its writer's own view. */
export const SAYS_A_VIEW = /\b(?:we|I) (?:think|believe)\b|我们认为|我认为/i;

/** The words by which it takes a sentence to be about the note it is in, which no check reads. */
const ABOUT_THE_NOTE = /^This note\b|^这份笔记/;

/**
 * A heading, a lone number or a cell's address states nothing; a line as short with a word and a
 * figure ("Total £8.68m.") states one.
 */
const statesNothing = (text: string): boolean =>
  !isClaim(text) && !(/\p{L}{2}/u.test(text) && /\p{N}/u.test(text));

export const findsClaims = (options: GenerateOptions): boolean =>
  FIND_CLAIMS.test(systemOf(options.prompt));

/** The brief of a verified document (#3277), src/core/answers/checks/verifyBrief.ts. */
const WRITE_BRIEF = /^You write a short brief for someone who reviews a document/m;

/**
 * The brief a scripted model writes: each of the first three claims is a conclusion, in the
 * claim's own words, and the first three claims with a figure in them are the ones the conclusions
 * rest on.
 */
export function fakeBrief(options: GenerateOptions): string | null {
  if (!WRITE_BRIEF.test(systemOf(options.prompt))) return null;
  let input: unknown;
  try {
    input = JSON.parse(lastUserText(options.prompt));
  } catch {
    return null;
  }
  const claims =
    typeof input === "object" && input !== null && "claims" in input && Array.isArray(input.claims)
      ? (input.claims as { number: number; text: string }[])
      : [];
  return JSON.stringify({
    conclusions: claims.slice(0, 3).map(({ number, text }) => ({ line: text, claim: number })),
    figures: claims
      .filter(({ text }) => /\d/.test(text))
      .slice(0, 3)
      .map(({ number }) => number),
  });
}

/** `undecidedLast` leaves the last listed sentence out of the reply, as a model that skips one does. */
export function fakeClaims(
  options: GenerateOptions,
  { undecidedLast = false }: { undecidedLast?: boolean } = {},
): string | null {
  if (!findsClaims(options)) return null;
  let input: unknown;
  try {
    input = JSON.parse(lastUserText(options.prompt));
  } catch {
    return null;
  }
  if (
    typeof input !== "object" ||
    input === null ||
    !("sentences" in input) ||
    !Array.isArray(input.sentences)
  )
    return null;
  const words: [number, "claim" | "note" | "no"][] = [];
  for (const sentence of input.sentences as unknown[]) {
    if (
      typeof sentence !== "object" ||
      sentence === null ||
      !("number" in sentence) ||
      !("text" in sentence) ||
      typeof sentence.number !== "number" ||
      typeof sentence.text !== "string"
    )
      return null;
    const { number, text } = sentence;
    words.push([
      number,
      /[?？]$|thank|谢/i.test(text) || statesNothing(text)
        ? "no"
        : ABOUT_THE_NOTE.test(text)
          ? "note"
          : "claim",
    ]);
  }
  return JSON.stringify(Object.fromEntries(undecidedLast ? words.slice(0, -1) : words));
}

export const checksChangeClaims = (options: GenerateOptions): boolean =>
  systemOf(options.prompt).includes(CLAIM_CHECK_INSTRUCTIONS);

/** Whether a reply says its request is done: the fake never reads one as saying so. */
export const fakeRequestDone = (options: GenerateOptions): string | null =>
  systemOf(options.prompt).includes(REQUEST_DONE_INSTRUCTIONS)
    ? JSON.stringify({ asks_change: "no", request: "none" })
    : null;

/** Whether a request's words ask to take text out: the fake reads "delete", "remove", "drop", "cut", 删, 去掉, 拿掉 and 砍 as asking. */
export function fakeRemovalAsked(options: GenerateOptions): string | null {
  if (!systemOf(options.prompt).includes(REMOVAL_ASKED_INSTRUCTIONS)) return null;
  const request =
    /<question>\n?([\s\S]*?)\n?<\/question>/.exec(lastUserText(options.prompt))?.[1] ?? "";
  return JSON.stringify({
    asks_for_all: /\b(?:delete|remove|drop|cut)\b|删|去掉|拿掉|砍/i.test(request) ? "yes" : "no",
  });
}

export function fakeChangeClaims(options: GenerateOptions): string | null {
  if (!checksChangeClaims(options)) return null;
  const reply = /<reply>\n([\s\S]*)\n<\/reply>/.exec(lastUserText(options.prompt))?.[1] ?? "";
  const unmade = /I've added a risks section|我已经把风险部分/.test(reply);
  const localMode = /I've turned on Local mode|我已经打开了本地模式/.test(reply);
  return JSON.stringify({
    claims: unmade
      ? [{ sentence: reply, kind: "added", about: "mind", backed: false }]
      : localMode
        ? [{ sentence: reply, kind: "changed", about: "local_mode", backed: false }]
        : [],
  });
}
