/**
 * Where a name stands in a line of the notes written after a call (#3013), for the fill check's
 * count of facts said by someone unnamed whose line carries another person's name. The count is
 * the bar; this splits it in two and labels the lines a person should read.
 *
 * The name opens the line when the line's first words are the people it is about and the name is
 * one of them: after any list mark, number, bracket, quote or emphasis, the name, or a run of the
 * call's people joined by "and", "&", a comma, 和, 与, 及 or 、 that holds it. A person is a name of the
 * call (an owner or notBy mark of any of its facts) or the User in the first person. Everything
 * else stands later: a label, a role or any other word before the name, and a name as the owner
 * of what the line is about (Ana's team, 安娜的团队, 安娜那边), since only a reading can tell
 * whether such a line puts the fact on the person or on someone of theirs.
 */

export interface NamedCall {
  turns: readonly { side: "me" | "them" }[];
  facts: readonly { said: readonly number[]; owner?: RegExp; notBy?: RegExp }[];
}

/**
 * Why a counted line goes on the list people read: its name stands later; the name opens it but a
 * clause break comes before the fact's own words; or the name opens it on a call with one named
 * person alone across.
 */
export type ReadKind = "later" | "afterBreak" | "aloneAcross";

export interface NamePlace {
  where: "opens" | "later";
  read: ReadKind[];
}

const MARKS = /(?:\s+|[-*•·–—_]+|\d{1,2}[.)](?=\s)|[(（]\d{1,2}[)）]|[①-⑳]|[[(（【「『《“"'‘])+/uy;
const USER = /(?:I|[Ww]e)\b|我们|我方|我/uy;
const JOINER = /\s*(?:,\s*(?:and\s+)?|&\s*|and\s+|[，、和与及]\s*)/uy;
// Chinese writes a person's side or group straight after the name, with no 的.
const POSSESSIVE = /['’](?:s\b|(?=\s))|\s*(?:的|那边|这边|方面|一方|团队|小组|工作室)/uy;
// A bracket holds an aside inside the clause, a date or a role, so it is not a break.
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

/** The fill's prompt gives every line from across to the one named person there, by name. */
function aloneAcross(call: NamedCall): boolean {
  const across = call.facts.filter((fact) =>
    fact.said.every((turn) => call.turns[turn]?.side === "them"),
  );
  const owners = across.flatMap((fact) => (fact.owner ? [fact.owner] : []));
  return (
    owners.length > 0 &&
    new Set(owners.map((owner) => owner.source)).size === 1 &&
    !owners.some(unnamed) &&
    across.every((fact) => fact.notBy === undefined)
  );
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
  const rest = line.text.slice(end);
  const starts = (line.pattern instanceof RegExp ? [line.pattern] : line.pattern)
    .map((part) => rest.search(part))
    .filter((start) => start >= 0);
  const afterBreak = starts.length > 0 && CLAUSE_BREAK.test(rest.slice(0, Math.min(...starts)));
  return {
    where: "opens",
    read: [
      ...(afterBreak ? (["afterBreak"] as const) : []),
      ...(aloneAcross(call) ? (["aloneAcross"] as const) : []),
    ],
  };
}
