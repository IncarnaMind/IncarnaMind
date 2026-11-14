/**
 * The language a typed question's reply is told to be written in (#2925): seven questions typed on
 * one English call, the first round's `en-typed-said` (its call, its Document and its button).
 * Four are English questions that name a Chinese Document or person; three are in French, German
 * and Japanese. Each reply is read by hand for the language of its own sentences, and for whether
 * it was written again for its language; there is no right answer to grade, so the set runs with
 * no judge (INCARNAMIND_EVAL_SPEED_JUDGE=none).
 */
import type { CallHelpCase } from "./callHelpCases";
import { CALL_HELP_TYPED } from "./callHelpTyped";

const CALL = CALL_HELP_TYPED.find((each) => each.id === "en-typed-said");
if (!CALL) throw new Error("The first round's en-typed-said case is gone.");

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
