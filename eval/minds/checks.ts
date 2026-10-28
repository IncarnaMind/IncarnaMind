/**
 * What a run is held to (README.md). Every check is code over the Minds as
 * the core holds them; only the reply's claims are judged by a model.
 */
import type { ChangedMind } from "../../src/renderer/src/changedMinds";
import type { Expected, Facts, Rule } from "./cases";
import type { BlockState, MindState } from "./state";

export type MindsFailure =
  | { kind: "wrong-minds"; missing: string[]; extra: string[] }
  | { kind: "wrong-text"; mind: string; why: string }
  | { kind: "card"; why: string }
  | { kind: "unbacked"; sentences: string[]; flagged: boolean }
  | { kind: "unnamed"; name: string }
  | { kind: "accept"; why: string }
  | { kind: "reject"; why: string }
  | { kind: "undo"; why: string }
  /** The Minds it names have a close namesake, and the assistant didn't ask which (#1865). */
  | { kind: "not-asked" };

const squash = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim();
const plain = (text: string) => squash(text).toLowerCase();

const holds = (text: string, alternatives: readonly string[]) =>
  alternatives.some((each) => plain(text).includes(plain(each)));

const missingFacts = (text: string, facts: Facts) => facts.filter((each) => !holds(text, each));

/** Sentences, by their closing mark: a full stop inside a number ("4.2") is none. */
export function sentencesIn(text: string): number {
  const marks = text.match(/[。！？]|[.!?]+(?=\s|$|[”"')）])/g)?.length ?? 0;
  const tail = text.trim().replace(/[”"')）\s]+$/, "");
  return marks + (tail !== "" && !/[。！？.!?]$/.test(tail) ? 1 : 0);
}

const sameBlocks = (a: readonly BlockState[], b: readonly BlockState[]) =>
  a.length === b.length &&
  a.every((block, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      block.id === other.id &&
      block.type === other.type &&
      block.level === other.level &&
      squash(block.text) === squash(other.text)
    );
  });

function sectionOf(blocks: readonly BlockState[], name: string) {
  const at = blocks.findIndex(
    (block) => block.type === "heading" && plain(block.text) === plain(name),
  );
  if (at < 0) return null;
  const level = blocks[at]?.level ?? 1;
  let end = blocks.length;
  for (let index = at + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (block?.type === "heading" && (block.level ?? 1) <= level) {
      end = index;
      break;
    }
  }
  return { at, end, body: blocks.slice(at + 1, end) };
}

const textOf = (blocks: readonly BlockState[]) => blocks.map((block) => block.text).join("\n");

const outside = (blocks: readonly BlockState[], at: number, end: number) => [
  ...blocks.slice(0, at + 1),
  ...blocks.slice(end),
];

const swap = (text: string, from: string, to: string) =>
  text
    .split(from)
    .join(to)
    .split(from.charAt(0).toUpperCase() + from.slice(1))
    .join(to.charAt(0).toUpperCase() + to.slice(1));

function ruleFailure(rule: Rule, before: MindState, after: MindState): string | null {
  if (rule.kind === "replace") {
    if (before.blocks.length !== after.blocks.length) {
      return `it has ${after.blocks.length} Blocks, it had ${before.blocks.length}`;
    }
    for (const [index, block] of before.blocks.entries()) {
      const now = after.blocks[index];
      const wanted = swap(block.text, rule.from, rule.to);
      if (!now || now.id !== block.id || now.type !== block.type) {
        return `Block ${index + 1} is not the Block it was`;
      }
      if (squash(now.text) !== squash(wanted)) {
        return `Block ${index + 1} reads “${squash(now.text)}” instead of “${squash(wanted)}”`;
      }
    }
    return null;
  }
  const was = sectionOf(before.blocks, rule.section);
  const now = sectionOf(after.blocks, rule.section);
  if (!was) throw new Error(`The seed has no section “${rule.section}”.`);
  if (!now) return `its section “${rule.section}” is gone`;
  if (
    !sameBlocks(outside(before.blocks, was.at, was.end), outside(after.blocks, now.at, now.end))
  ) {
    return `text outside its section “${rule.section}” changed`;
  }
  const text = textOf(now.body);
  if (rule.kind === "shorten") {
    if (text.trim() === "") return `its section “${rule.section}” is empty`;
    const sentences = sentencesIn(text);
    if (sentences > rule.sentences) {
      return `its section “${rule.section}” has ${sentences} sentences, not ${rule.sentences} or fewer`;
    }
    const length = textOf(was.body).length;
    if (text.length >= length) {
      return `its section “${rule.section}” is not shorter (${text.length} characters, it had ${length})`;
    }
    if (!holds(text, rule.keeps)) {
      return `its section “${rule.section}” keeps none of ${rule.keeps.map((each) => `“${each}”`).join(", ")}`;
    }
    return null;
  }
  const lost = was.body.filter(
    (block) =>
      !now.body.some((other) => other.id === block.id && squash(other.text) === squash(block.text)),
  );
  const [first] = lost;
  if (first) {
    const current = now.body.find((other) => other.id === first.id);
    return `text already in “${rule.section}” changed: “${squash(first.text)}” now reads ${current ? `“${squash(current.text)}”` : "nothing"}`;
  }
  const absent = missingFacts(text, rule.facts);
  if (absent.length > 0) {
    return `“${rule.section}” does not hold ${absent.map((each) => `“${each[0]}”`).join(", ")}`;
  }
  return null;
}

const sameState = (a: MindState, b: MindState) => a.shown === b.shown;

function changedBetween(before: readonly MindState[], after: readonly MindState[]) {
  const was = new Map(before.map((mind) => [mind.id, mind]));
  const now = new Map(after.map((mind) => [mind.id, mind]));
  return {
    changed: after.filter((mind) => {
      const earlier = was.get(mind.id);
      return (
        earlier !== undefined &&
        (!sameBlocks(earlier.blocks, mind.blocks) || earlier.title !== mind.title)
      );
    }),
    made: after.filter((mind) => !was.has(mind.id)),
    gone: before.filter((mind) => !now.has(mind.id)),
  };
}

export function textFailures(
  expected: Expected,
  before: readonly MindState[],
  after: readonly MindState[],
): MindsFailure[] {
  const failures: MindsFailure[] = [];
  const { changed, made, gone } = changedBetween(before, after);
  const asked = Object.keys(expected.changed);
  const titleOf = (mind: MindState) => mind.title;
  const changedTitles = changed.map(titleOf);
  const missing = asked.filter((title) => !changedTitles.includes(title));
  const extra = [
    ...changedTitles.filter((title) => !asked.includes(title)),
    ...gone.map((mind) => `${mind.title} (gone)`),
    ...made.slice(expected.made ? 1 : 0).map((mind) => `${mind.title || "Untitled"} (new)`),
  ];
  if (expected.made && made.length === 0) missing.push("(a new Mind)");
  if (missing.length > 0 || extra.length > 0)
    failures.push({ kind: "wrong-minds", missing, extra });
  for (const [title, rule] of Object.entries(expected.changed)) {
    const was = before.find((mind) => mind.title === title);
    const now = after.find((mind) => mind.title === title);
    if (!was || !now || !changedTitles.includes(title)) continue;
    const why = ruleFailure(rule, was, now);
    if (why) failures.push({ kind: "wrong-text", mind: title, why });
  }
  const [first] = made;
  if (expected.made && first) {
    const text = textOf(first.blocks);
    if (!holds(first.title, expected.made.title)) {
      failures.push({
        kind: "wrong-text",
        mind: first.title || "Untitled",
        why: `its title is not “${expected.made.title[0]}”`,
      });
    }
    const absent = missingFacts(text, expected.made.facts);
    if (absent.length > 0) {
      failures.push({
        kind: "wrong-text",
        mind: first.title || "Untitled",
        why: `it does not hold ${absent.map((each) => `“${each[0]}”`).join(", ")}`,
      });
    }
  }
  return failures;
}

function unitCounts(before: MindState | undefined, after: MindState) {
  const was = new Map((before?.units ?? []).map((unit) => [unit.key, unit]));
  const now = new Map(after.units.map((unit) => [unit.key, unit]));
  let modified = 0;
  let removed = 0;
  let addedParagraphs = 0;
  let addedHeadings = 0;
  for (const [key, unit] of was) {
    const other = now.get(key);
    if (!other) removed++;
    else if (squash(other.text) !== squash(unit.text)) modified++;
  }
  for (const [key, unit] of now) {
    if (was.has(key)) continue;
    if (unit.type === "heading") addedHeadings++;
    else addedParagraphs++;
  }
  const low = modified + removed + addedParagraphs;
  return { low, high: low + addedHeadings };
}

export function cardFailures(
  rows: readonly ChangedMind[],
  before: readonly MindState[],
  after: readonly MindState[],
): MindsFailure[] {
  const failures: MindsFailure[] = [];
  const { changed, made } = changedBetween(before, after);
  const truth = [...changed, ...made];
  const named = (id: string) =>
    truth.find((mind) => mind.id === id)?.title ||
    after.find((mind) => mind.id === id)?.title ||
    id;
  const listed = rows.map((row) => row.mindId);
  const unlisted = truth
    .filter((mind) => !listed.includes(mind.id))
    .map((mind) => mind.title || "Untitled");
  const unreal = rows
    .filter((row) => !truth.some((mind) => mind.id === row.mindId))
    .map((row) => named(row.mindId));
  if (unlisted.length > 0)
    failures.push({ kind: "card", why: `it does not list ${unlisted.join(", ")}` });
  if (unreal.length > 0)
    failures.push({ kind: "card", why: `it lists ${unreal.join(", ")}, which did not change` });
  for (const row of rows) {
    const now = truth.find((mind) => mind.id === row.mindId);
    if (!now) continue;
    const isNew = made.some((mind) => mind.id === row.mindId);
    if (row.created !== isNew) {
      failures.push({
        kind: "card",
        why: `${named(row.mindId)} is ${isNew ? "new" : "not new"}, the card says ${row.created ? "new" : "not new"}`,
      });
    }
    const { low, high } = unitCounts(
      before.find((mind) => mind.id === row.mindId),
      now,
    );
    const said = row.changed + row.wrote;
    if (said < low || said > high) {
      failures.push({
        kind: "card",
        why: `${named(row.mindId)}: the card counts ${said}, the Mind has ${low === high ? low : `${low} to ${high}`}`,
      });
    }
  }
  return failures;
}

const byId = (minds: readonly MindState[]) => new Map(minds.map((mind) => [mind.id, mind]));

export function rejectFailures(
  before: readonly MindState[],
  after: readonly MindState[],
): MindsFailure[] {
  const { changed, made, gone } = changedBetween(before, after);
  const left = after.filter((mind) => mind.pending > 0);
  const why = [
    ...changed.map((mind) => `${mind.title} reads differently`),
    ...made.map((mind) => `${mind.title || "Untitled"} is still there`),
    ...gone.map((mind) => `${mind.title} is gone`),
    ...left.map((mind) => `${mind.title || "Untitled"} still has ${mind.pending} changes waiting`),
  ];
  return why.length === 0 ? [] : [{ kind: "reject", why: why.join("; ") }];
}

export function acceptFailures(after: readonly MindState[]): MindsFailure[] {
  const left = after.filter((mind) => mind.pending > 0);
  return left.length === 0
    ? []
    : [
        {
          kind: "accept",
          why: left
            .map((mind) => `${mind.title || "Untitled"} still has ${mind.pending} changes waiting`)
            .join("; "),
        },
      ];
}

export function undoFailures(
  step: "Accept all" | "Reject all",
  before: readonly MindState[],
  after: readonly MindState[],
): MindsFailure[] {
  const was = byId(before);
  const now = byId(after);
  const why = [
    ...before
      .filter((mind) => !now.has(mind.id))
      .map((mind) => `${mind.title || "Untitled"} is not back`),
    ...after
      .filter((mind) => !was.has(mind.id))
      .map((mind) => `${mind.title || "Untitled"} was not there before`),
    ...after.flatMap((mind) => {
      const earlier = was.get(mind.id);
      return earlier && !sameState(earlier, mind)
        ? [`${mind.title || "Untitled"} reads differently`]
        : [];
    }),
  ];
  return why.length === 0
    ? []
    : [{ kind: "undo", why: `after Undo of ${step}: ${why.join("; ")}` }];
}

export function unnamedFailure(expected: Expected, reply: string): MindsFailure[] {
  const name = expected.missing;
  return name !== undefined &&
    !plain(reply).replace(/\s/g, "").includes(plain(name).replace(/\s/g, ""))
    ? [{ kind: "unnamed", name }]
    : [];
}

export function failureLine(failure: MindsFailure): string {
  switch (failure.kind) {
    case "wrong-minds":
      return `wrong Minds changed${failure.missing.length > 0 ? `, not changed: ${failure.missing.join(", ")}` : ""}${failure.extra.length > 0 ? `, changed without being asked: ${failure.extra.join(", ")}` : ""}`;
    case "wrong-text":
      return `${failure.mind}: ${failure.why}`;
    case "card":
      return `card: ${failure.why}`;
    case "unbacked":
      return `claims a change no call made${failure.flagged ? " (flagged under the reply)" : ""}: ${failure.sentences.map((sentence) => `“${sentence}”`).join(" ")}`;
    case "unnamed":
      return `the reply never names “${failure.name}”`;
    case "accept":
      return `Accept all: ${failure.why}`;
    case "reject":
      return `Reject all: ${failure.why}`;
    case "undo":
      return failure.why;
    case "not-asked":
      return "it didn't ask which Mind";
  }
}
