/**
 * Where a name stands in a line of the notes written after a call (#3013), for the fill check's
 * count of facts said by someone unnamed whose line carries another person's name. The count is
 * the bar; this splits it in two and labels the lines a person should read.
 *
 * The name opens the line when the line's first words are the people it is about and the name is
 * one of them: after any list mark, number, bracket, quote or emphasis, the name, or a run of the
 * call's people joined by "and", "&", a half-width comma, 及 or 、 that holds it. A person is a
 * name of the call (an owner or notBy mark of any of its facts) or the User in the first person.
 * Everything else stands later: a label, a role or any other word before the name; a name after
 * 和 or 与, which can mean "with" or "to" as well as "and", or after "，", which can be a pause as
 * well as a list; and a name as the owner of what the line is about (Ana's team, 安娜的团队,
 * 安娜那边), since only a reading can tell whether such a line puts the fact on the person or on
 * someone of theirs.
 */

export interface NamedCall {
  turns: readonly { side: "me" | "them" }[];
  facts: readonly { said: readonly number[]; owner?: RegExp; notBy?: RegExp }[];
}

/**
 * Why a counted line goes on the list people read: its name stands later; the name opens it but a
 * clause break comes before the fact's own words; the name opens it and it holds none of the
 * fact's words, so it was counted for citing the unnamed person's turn; or the name opens it on a
 * call with one named person alone across, or on a call whose marks can't tell.
 */
export type ReadKind =
  | "later"
  | "afterBreak"
  | "citesTurnOnly"
  | "aloneAcross"
  | "aloneAcrossNotKnown";

export interface NamePlace {
  where: "opens" | "later";
  read: ReadKind[];
}

const MARKS = /(?:\s+|[-*•·–—_]+|\d{1,2}[.)](?=\s)|[(（]\d{1,2}[)）]|[①-⑳]|[[(（【「『《“"'‘])+/uy;
const USER = /(?:I|[Ww]e)\b|我们|我方|我/uy;
const JOINER = /\s*(?:,\s*(?:and\s+)?|&\s*|and\s+|[、及]\s*)/uy;
// After the name, a side or group of theirs, with or without 的: 那边, 这边, 方面, 一方, 团队, 小组,
// 工作室. 的确 is "indeed", not a possessive.
const POSSESSIVE = /['’](?:s\b|(?=\s))|\s*(?:的(?!确)|那边|这边|方面|一方|团队|小组|工作室)/uy;
// A colon straight after the name labels what follows as theirs, so it is not a break.
const SPEAKER_COLON = /\s*[:：]\s*/uy;
// A bracket holds an aside inside the clause, a date or a role, so it is not a break. A comma
// after a short word stays one: code can't tell "said," from "was late,".
const CLAUSE_BREAK = /[;；，。！？：—]|,(?!\d)|:(?=\s)|[.!?](?=\s)|\s[-–]\s/u;

/** Where `pattern` ends when it matches `text` right at `index`, or null. */
function endOfMatch(pattern: RegExp, text: string, index: number): number | null {
  const sticky = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}y`);
  sticky.lastIndex = index;
  const found = sticky.exec(text);
  return found && found[0].length > 0 ? index + found[0].length : null;
}

/** The end of the name where it opens the line, or null where it stands later. */
function opening(text: string, name: RegExp, people: readonly RegExp[]): number | null {
  let index = endOfMatch(MARKS, text, 0) ?? 0;
  for (;;) {
    const own = endOfMatch(name, text, index);
    if (own !== null) return endOfMatch(POSSESSIVE, text, own) === null ? own : null;
    const other = [...people, USER].flatMap((person) => endOfMatch(person, text, index) ?? [])[0];
    if (other === undefined || endOfMatch(POSSESSIVE, text, other) !== null) return null;
    const next = endOfMatch(JOINER, text, other);
    if (next === null) return null;
    index = next;
  }
}

// The fixtures mark the facts of a person never named with the words the notes must use for them.
const unnamed = (owner: RegExp) => owner.test("the other side") || owner.test("对方");

/**
 * Whether the call has one named person alone across, to whom the fill's prompt gives every line
 * from across by name. Yes and not known both put a line on the read list and only "no" takes it
 * off, so every "no" must rest on a mark; a not-by mark is one, since whoever said it across is
 * not that named person, so across is never one named person alone.
 */
export function aloneAcross(call: NamedCall): "yes" | "no" | "not known" {
  const across = call.facts.filter((fact) =>
    fact.said.every((turn) => call.turns[turn]?.side === "them"),
  );
  if (across.some((fact) => fact.notBy !== undefined)) return "no";
  const owners = across.flatMap((fact) => (fact.owner ? [fact.owner] : []));
  if (owners.length === 0) return "not known";
  return new Set(owners.map((owner) => owner.source)).size === 1 && !owners.some(unnamed)
    ? "yes"
    : "no";
}

/**
 * Where `name` stands in `text`, a line counted for a fact whose words are `pattern`, and why a
 * person should read it.
 */
export function placeName(
  call: NamedCall,
  line: { text: string; name: RegExp; pattern: RegExp | RegExp[] },
): NamePlace {
  const people = call.facts.flatMap((fact) => [
    ...(fact.owner ? [fact.owner] : []),
    ...(fact.notBy ? [fact.notBy] : []),
  ]);
  const end = opening(line.text, line.name, people);
  if (end === null) return { where: "later", read: ["later"] };
  const parts = line.pattern instanceof RegExp ? [line.pattern] : line.pattern;
  const rest = line.text.slice(endOfMatch(SPEAKER_COLON, line.text, end) ?? end);
  const starts = parts.map((part) => rest.search(part)).filter((start) => start >= 0);
  const afterBreak = starts.length > 0 && CLAUSE_BREAK.test(rest.slice(0, Math.min(...starts)));
  const across = aloneAcross(call);
  return {
    where: "opens",
    read: [
      ...(afterBreak ? (["afterBreak"] as const) : []),
      ...(parts.every((part) => line.text.search(part) < 0) ? (["citesTurnOnly"] as const) : []),
      ...(across === "yes" ? (["aloneAcross"] as const) : []),
      ...(across === "not known" ? (["aloneAcrossNotKnown"] as const) : []),
    ],
  };
}
