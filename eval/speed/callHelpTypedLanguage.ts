/**
 * The language a typed question's reply is told to be written in (#2925): seven questions typed on
 * one English call, the first round's `en-typed-said` (its call, its Document and its button).
 * Four are English questions that name a Chinese Document or person; three are in French, German
 * and Japanese. Each reply is read by hand for the language of its own sentences, and for whether
 * it was written again for its language; there is no right answer to grade, so the set runs with
 * no judge (INCARNAMIND_EVAL_SPEED_JUDGE=none).
 *
 * `CALL_HELP_TYPED_MIXED`: six questions in both scripts that the reader of a Question's language
 * can't tell, typed on that English call and on its Chinese twin (`zh-typed-said`): three Chinese
 * sentences carrying English names and three English sentences naming a Chinese person or thing.
 * Each reply is read by hand for whether it is in its sentence's language.
 */
import type { CallHelpCase } from "./callHelpCases";
import { CALL_HELP_TYPED } from "./callHelpTyped";

const callOf = (id: string) => {
  const found = CALL_HELP_TYPED.find((each) => each.id === id);
  if (!found) throw new Error(`The first round's ${id} case is gone.`);
  return found;
};
const CALL = callOf("en-typed-said");

const QUESTIONS = [
  ["en-language-terms", "What does 合同条款 say?"],
  ["en-language-person", "What did 王总 ask about the deposit?"],
  ["en-language-short", "Does 合同 mention a deposit?"],
  ["en-language-title", "Which clause of 《租赁合同》 covers late rent?"],
  ["fr-language", "Quel est le loyer mensuel du bail ?"],
  ["de-language", "Wie hoch ist die monatliche Miete?"],
  ["ja-language", "毎月の家賃はいくらですか？"],
] as const;

export const CALL_HELP_TYPED_LANGUAGE: readonly CallHelpCase[] = QUESTIONS.map(
  ([id, question]) => ({ ...CALL, id, typed: { question, form: "short" } }),
);

const MIXED = [
  ["zh-sentence-terms", "Enterprise plan 的 single sign-on 和 audit log 包含吗？"],
  ["zh-sentence-leases", "Lease 2 和 Lease 3 的 monthly rent 一样吗？"],
  ["zh-sentence-price", "Price sheet 里 Enterprise plan per seat 多少钱？"],
  ["en-sentence-invoices", "Does 王总 want monthly invoices?"],
  ["en-sentence-signing", "Is 李经理 signing before Friday?"],
  ["en-sentence-pickups", "Will 张总 need weekend pickups?"],
] as const;

const CALLS: readonly (readonly [string, CallHelpCase])[] = [
  ["en-call", CALL],
  ["zh-call", callOf("zh-typed-said")],
];

export const CALL_HELP_TYPED_MIXED: readonly CallHelpCase[] = CALLS.flatMap(([call, each]) =>
  MIXED.map(([id, question]) => ({
    ...each,
    id: `${call}-${id}`,
    typed: { question, form: "short" as const },
  })),
);
