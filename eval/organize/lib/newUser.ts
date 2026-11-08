/**
 * The new-User mode's scores and report (README.md): what Organize proposed for a Library with no
 * Folders, before the User confirms anything. Pure: the unit tests
 * (tests/eval/organizeNewUser.test.ts) run it without a model.
 */
import { kindOfName } from "../../../src/core/tags/kinds";
import { decimal, f1, fraction, type Labelled, precision, ratio, recall } from "./scoring";
import { formatOf, type SetDocument } from "./set";

const normal = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** What `main`'s Notes preset Tag was named, which the labels' "notes" kind stands for. */
const NOTES = new Set(["notes", "note", "笔记"]);

/**
 * The labelled kind a Tag's name stands for, or null for a topic Tag: a kind of the app's list
 * (src/core/tags/kinds.ts) by its name in either language, Meeting notes standing for the labels'
 * "notes", or `main`'s Notes preset. A kind the labels don't have (Statement, Letter) is itself.
 */
export function kindOf(tagName: string): string | null {
  const kind = kindOfName(tagName);
  if (kind === "meeting-notes") return "notes";
  if (kind) return kind;
  return NOTES.has(normal(tagName)) ? "notes" : null;
}

/** The gold kinds that are in the app's kind list: "notes" only for a meeting's (2026-11-08). */
export const listedKinds = (doc: Pick<Labelled, "folder" | "tags">): string[] =>
  doc.tags.filter((kind) => kind !== "notes" || doc.folder === "meetings");

/**
 * Which kind Tag F1 gates (`INCARNAMIND_ORGANIZE_KIND_SCORE`): "one-kind", the rule settled on
 * 2026-11-08 for one kind a Document from a list without Notes, by default; or "as-written", the
 * labels as they are. Both are always reported.
 */
export type KindScore = "one-kind" | "as-written";

export interface ProposedFolder {
  id: string;
  name: string;
  description: string;
}

/** What Organize left for one Document of the set. */
export interface Outcome<D extends Labelled = Labelled> {
  doc: D;
  /** Processing found its text. */
  readable: boolean;
  /** The Folder it was placed in, a Suggested Folder included; null for none. */
  folder: string | null;
  /** The names of the Tags applied to it. */
  tags: string[];
  /** Organize's state for it, and why when it didn't finish. */
  status: string;
  error: string | null;
}

/** The judge's answer to whether a Document is about a topic Tag; null when it said neither. */
export interface TopicVerdict {
  id: string;
  tag: string;
  about: boolean | null;
}

export interface NewUserScores {
  readable: number;
  filed: number;
  /** Every Folder there is, with how many of the Documents it holds. */
  folderSizes: { folder: ProposedFolder; size: number }[];
  samePairs: number;
  sameShared: number;
  /** Same-label pairs together, counting a split by area (`splitByArea`) as together. */
  sameTogether: number;
  differentPairs: number;
  differentShared: number;
  /** Kind Tags against the labels as written: every labelled kind a pair. */
  kinds: { tp: number; fp: number; fn: number };
  /**
   * Kind Tags by the rule settled on 2026-11-08 (#2339): a Document with a labelled kind in the app's list
   * is one pair, a hit when its kind Tag is any of them and else one miss; one with none in the
   * list has no pair, and any kind Tag on it is a false positive; every other kind Tag is too.
   */
  oneKind: { tp: number; fp: number; fn: number };
  /** Readable Documents with no kind Tag, and how many the labels expect (none of their kinds listed). */
  noKind: number;
  noKindExpected: number;
  /** Topic Tags judged, those judged not about the Document, and those with no clear answer. */
  topic: number;
  offTopic: number;
  unanswered: number;
  /** Distinct names among the Tags applied to the Documents. */
  names: number;
  /** Distinct kinds in the readable Documents' labels. */
  labelledKinds: number;
}

const kindsOf = (tags: readonly string[]) => new Set(tags.flatMap((tag) => kindOf(tag) ?? []));

/** The bar's allowance for a label split in two: each part this big and this much the label. */
const SPLIT_SIZE = 3;
const SPLIT_PURITY = 0.9;
/** A kind carried by this share of a part's Documents is that part's kind. */
const PART_KIND = 0.8;

/**
 * The labels whose filed Documents the proposal split by area, which the same-label bar counts as
 * together. A label's readable Documents in a Folder lie in exactly two Folders, each holding at
 * least `SPLIT_SIZE` readable Documents of which at least `SPLIT_PURITY` carry the label, and the
 * split isn't by kind. It is by kind when, in each part, the kinds that at least `PART_KIND` of
 * its Documents carry by their labels make a set that isn't empty, and the two sets differ: kind
 * is a Tag, never a Folder.
 */
export function splitByArea(outcomes: readonly Outcome[]): Set<string> {
  const readable = outcomes.filter((each) => each.readable);
  const allowed = new Set<string>();
  const labels = new Set(
    readable.flatMap((each) => (each.doc.folder === null ? [] : [each.doc.folder])),
  );
  for (const label of labels) {
    const parts = [
      ...new Set(
        readable.flatMap((each) =>
          each.doc.folder === label && each.folder !== null ? [each.folder] : [],
        ),
      ),
    ];
    if (parts.length !== 2) continue;
    const members = parts.map((folder) => readable.filter((each) => each.folder === folder));
    const fits = members.every(
      (held) =>
        held.length >= SPLIT_SIZE &&
        held.filter((each) => each.doc.folder === label).length >= SPLIT_PURITY * held.length,
    );
    if (!fits) continue;
    const kindsOfPart = members.map((held) => {
      const all = [...new Set(held.flatMap((each) => each.doc.tags))];
      return all
        .filter(
          (kind) =>
            held.filter((each) => each.doc.tags.includes(kind)).length >= PART_KIND * held.length,
        )
        .sort()
        .join("+");
    });
    const [first, second] = kindsOfPart;
    const byKind = first !== "" && second !== "" && first !== second;
    if (!byKind) allowed.add(label);
  }
  return allowed;
}

/** Readable Documents with a labelled Folder, in pairs: whether they share a label, and a Folder. */
function pairs(outcomes: readonly Outcome[]) {
  const labelled = outcomes.filter((each) => each.readable && each.doc.folder !== null);
  const allowed = splitByArea(outcomes);
  return labelled.flatMap((a, at) =>
    labelled.slice(at + 1).map((b) => {
      const shared = a.folder !== null && a.folder === b.folder;
      const sameLabel = a.doc.folder === b.doc.folder;
      return {
        sameLabel,
        shared,
        together:
          shared ||
          (sameLabel &&
            a.folder !== null &&
            b.folder !== null &&
            allowed.has(a.doc.folder as string)),
      };
    }),
  );
}

export function scoreNewUser(
  outcomes: readonly Outcome[],
  folders: readonly ProposedFolder[],
  verdicts: readonly TopicVerdict[],
): NewUserScores {
  const readable = outcomes.filter((each) => each.readable);
  const kinds = { tp: 0, fp: 0, fn: 0 };
  const oneKind = { tp: 0, fp: 0, fn: 0 };
  let noKind = 0;
  let noKindExpected = 0;
  for (const each of readable) {
    const applied = kindsOf(each.tags);
    const labelled = new Set(each.doc.tags);
    const hits = [...applied].filter((kind) => labelled.has(kind)).length;
    kinds.tp += hits;
    kinds.fp += applied.size - hits;
    kinds.fn += labelled.size - hits;
    const listed = new Set(listedKinds(each.doc));
    const hit = [...applied].some((kind) => listed.has(kind));
    if (listed.size > 0) {
      if (hit) oneKind.tp += 1;
      else oneKind.fn += 1;
    }
    oneKind.fp += applied.size - (hit ? 1 : 0);
    if (applied.size === 0) noKind += 1;
    if (listed.size === 0) noKindExpected += 1;
  }
  const all = pairs(outcomes);
  const same = all.filter((pair) => pair.sameLabel);
  const different = all.filter((pair) => !pair.sameLabel);
  return {
    readable: readable.length,
    filed: readable.filter((each) => each.folder !== null).length,
    folderSizes: folders.map((folder) => ({
      folder,
      size: outcomes.filter((each) => each.folder === folder.id).length,
    })),
    samePairs: same.length,
    sameShared: same.filter((pair) => pair.shared).length,
    sameTogether: same.filter((pair) => pair.together).length,
    differentPairs: different.length,
    differentShared: different.filter((pair) => pair.shared).length,
    kinds,
    oneKind,
    noKind,
    noKindExpected,
    topic: verdicts.length,
    offTopic: verdicts.filter((each) => each.about === false).length,
    unanswered: verdicts.filter((each) => each.about === null).length,
    names: new Set(outcomes.flatMap((each) => each.tags.map(normal))).size,
    labelledKinds: new Set(readable.flatMap((each) => each.doc.tags)).size,
  };
}

export interface Bar {
  name: string;
  value: string;
  bar: string;
  pass: boolean;
  /** Reported beside the bars, never gating. */
  reported?: true;
}

const kindValue = (counts: NewUserScores["kinds"]) =>
  `${decimal(f1(counts))} (P ${decimal(precision(counts))}, R ${decimal(recall(counts))})`;

export function bars(s: NewUserScores, kindScore: KindScore = "one-kind"): Bar[] {
  const kindBar = (counts: NewUserScores["kinds"], gates: boolean, name: string): Bar => ({
    name,
    value: kindValue(counts),
    bar: "≥ 0.80",
    pass: f1(counts) >= 0.8,
    ...(!gates && { reported: true as const }),
  });
  const sizes = s.folderSizes.map((each) => each.size);
  const smallest = sizes.length ? Math.min(...sizes) : null;
  const answered = s.topic - s.unanswered;
  return [
    {
      name: "Filed: readable Documents in a Folder",
      value: fraction(s.filed, s.readable),
      bar: "≥ 80%",
      pass: ratio(s.filed, s.readable) >= 0.8,
    },
    {
      name: "Smallest Folder",
      value: smallest === null ? "no Folders" : `${smallest} (sizes ${sizes.join(", ")})`,
      bar: "every Folder ≥ 3",
      pass: smallest !== null && smallest >= 3,
    },
    {
      name: "Same-label pairs together, a split by area allowed",
      value: fraction(s.sameTogether, s.samePairs),
      bar: "≥ 90%",
      pass: ratio(s.sameTogether, s.samePairs) >= 0.9,
    },
    {
      name: "Same-label pairs sharing one Folder, no allowance",
      value: fraction(s.sameShared, s.samePairs),
      bar: "≥ 90%",
      pass: ratio(s.sameShared, s.samePairs) >= 0.9,
    },
    {
      name: "Different-label pairs sharing a Folder",
      value: fraction(s.differentShared, s.differentPairs),
      bar: "≤ 10%",
      pass: ratio(s.differentShared, s.differentPairs) <= 0.1,
    },
    kindBar(s.oneKind, kindScore === "one-kind", "Kind Tag F1, one kind a Document"),
    kindBar(s.kinds, kindScore === "as-written", "Kind Tag F1, the labels as written"),
    {
      name: "Documents with no kind Tag",
      value: String(s.noKind),
      bar: `${s.noKindExpected} expected`,
      pass: s.noKind <= s.noKindExpected,
      reported: true,
    },
    {
      name: "Topic Tags off-topic",
      value: `${fraction(s.offTopic, answered)}${s.unanswered ? `, ${s.unanswered} unanswered` : ""}`,
      bar: "≤ 5%",
      pass: ratio(s.offTopic, answered) <= 0.05,
    },
    {
      name: "Distinct Tag names",
      value: String(s.names),
      bar: `≤ ${s.labelledKinds + 3} (${s.labelledKinds} labelled kinds + 3)`,
      pass: s.names <= s.labelledKinds + 3,
    },
  ];
}

/** The labels the Folder's readable, labelled Documents carry most. */
function mostlyHolds(outcomes: readonly Outcome[], folder: string): string[] {
  const counts = new Map<string, number>();
  for (const each of outcomes)
    if (each.readable && each.folder === folder && each.doc.folder !== null)
      counts.set(each.doc.folder, (counts.get(each.doc.folder) ?? 0) + 1);
  const most = Math.max(0, ...counts.values());
  return [...counts].filter(([, count]) => count === most).map(([label]) => label);
}

/** What is wrong with each readable Document's outcome, by the labels; none when it is right. */
export function problemsOf(
  outcome: Outcome,
  outcomes: readonly Outcome[],
  verdicts: readonly TopicVerdict[],
): string[] {
  if (!outcome.readable) return [];
  const problems: string[] = [];
  const label = outcome.doc.folder;
  if (label !== null && outcome.folder === null) problems.push("not filed");
  if (label !== null && outcome.folder !== null) {
    const most = mostlyHolds(outcomes, outcome.folder);
    if (!most.includes(label)) problems.push(`in a Folder mostly of ${most.join(" and ")}`);
  }
  const applied = kindsOf(outcome.tags);
  const missing = outcome.doc.tags.filter((kind) => !applied.has(kind));
  const extra = [...applied].filter((kind) => !outcome.doc.tags.includes(kind));
  if (missing.length) problems.push(`kind missing: ${missing.join(", ")}`);
  if (extra.length) problems.push(`kind not labelled: ${extra.join(", ")}`);
  const offTopic = verdicts
    .filter((each) => each.id === outcome.doc.id && each.about === false)
    .map((each) => each.tag);
  if (offTopic.length) problems.push(`off-topic: ${offTopic.join(", ")}`);
  return problems;
}

export interface NewUserRun {
  startedAt: string;
  commit: string;
  language: string;
  /** The User's chat model, and the model Organize ran on. */
  chatModel: string;
  organizeModel: string;
  judge: string;
  /** Held-out mistakes are listed only when asked for. */
  listMistakes: boolean;
  /** Which kind Tag F1 gates. */
  kindScore: KindScore;
  /** Each tagging request's input tokens, as the meter counted them, and the Documents tagged (#2339). */
  tagging?: { inputPerRequest: number[]; documents: number };
  /** From the press to the Folders made, to the first Document placed, and to the last settled. */
  proposedMs: number;
  firstPlacementMs: number | null;
  totalMs: number;
  /** The app's model requests as its meter counted them, and the judge's. */
  spend: {
    who: string;
    requests: number;
    input: number;
    output: number;
    cost: number | null;
  }[];
  /**
   * "plan": the Library's Organize as the Review gets it (`organizeLibrary`); "classic": Folders
   * proposed, then each Document sorted on its own, as before the Review.
   */
  route: "plan" | "classic";
  /** The plan's own counts, on its route. */
  plan?: {
    requests: number;
    /** Documents asked of the model one by one, past the sample. */
    placedByModel: number;
    /** Each request's input tokens, as the meter counted them. */
    inputPerRequest: number[];
    subfolders: Subfolder[];
  };
}

/** A proposed subfolder, with how many Documents it holds and how many share its commonest `sub` label. */
export interface Subfolder {
  parent: string;
  name: string;
  size: number;
  sameSub: number;
}

const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const kindList = (tags: readonly string[]) =>
  tags.map((tag) => `${tag}${kindOf(tag) ? "" : " (topic)"}`).join(", ") || "–";

function planLines(plan: NonNullable<NewUserRun["plan"]>): string[] {
  const inputs = plan.inputPerRequest;
  const mean = inputs.length ? inputs.reduce((sum, each) => sum + each, 0) / inputs.length : 0;
  const lines = [
    "",
    `The plan: ${plan.requests} requests; ${plan.placedByModel} Documents asked of the model past the sample; input tokens a request ${Math.round(mean).toLocaleString("en")} on average, ${Math.max(0, ...inputs).toLocaleString("en")} at most.`,
  ];
  if (plan.subfolders.length === 0) return lines;
  const smallest = Math.min(...plan.subfolders.map((each) => each.size));
  const same = plan.subfolders.reduce((sum, each) => sum + each.sameSub, 0);
  const held = plan.subfolders.reduce((sum, each) => sum + each.size, 0);
  lines.push(
    "",
    `Subfolders: ${plan.subfolders.length}, the smallest holding ${smallest} (bar ≥ 5); ${held ? Math.round((100 * same) / held) : 0}% of their Documents share their subfolder's commonest template. Pairs are scored by the top-level Folder.`,
    "",
    "| Folder › subfolder | Documents | Of its commonest template |",
    "|---|---:|---:|",
    ...plan.subfolders.map(
      (each) => `| ${each.parent} › ${each.name} | ${each.size} | ${each.sameSub} |`,
    ),
  );
  return lines;
}

/** The tagging requests' size: a request's input tokens, and a Document's share of them. */
function taggingLines({
  inputPerRequest,
  documents,
}: NonNullable<NewUserRun["tagging"]>): string[] {
  const input = inputPerRequest.reduce((sum, each) => sum + each, 0);
  return [
    "",
    `Tagging: ${inputPerRequest.length} requests for ${documents} Documents; input tokens a request ${Math.round(input / inputPerRequest.length).toLocaleString("en")} on average, ${Math.max(...inputPerRequest).toLocaleString("en")} at most; ${documents ? Math.round(input / documents).toLocaleString("en") : 0} a Document.`,
  ];
}

export function newUserReport(
  run: NewUserRun,
  outcomes: readonly Outcome<SetDocument>[],
  folders: readonly ProposedFolder[],
  verdicts: readonly TopicVerdict[],
): string {
  const scores = scoreNewUser(outcomes, folders, verdicts);
  const folderName = (id: string | null) =>
    id === null ? "–" : (folders.find((folder) => folder.id === id)?.name ?? id);
  const unread = outcomes.filter((each) => !each.readable);
  const lines = [
    `# Organize as a new User meets it, ${run.startedAt.slice(0, 10)}`,
    "",
    `Commit \`${run.commit}\` · interface in ${run.language} · the User's model ${run.chatModel}, Organize on ${run.organizeModel} · topic Tags judged by ${run.judge}`,
    "",
    `${outcomes.length} Documents, ${scores.readable} readable${unread.length ? ` (no text: ${unread.map((each) => each.doc.id).join(", ")})` : ""}. No Folders at the start; the proposal is scored before the User confirms anything, a Suggested Folder counting as placed.`,
    "",
    "## Bars",
    "",
    "| Bar | Measured | Bar | |",
    "|---|---|---|---|",
    ...bars(scores, run.kindScore).map(
      (each) =>
        `| ${each.name} | ${each.value} | ${each.bar} | ${each.reported ? "reported" : each.pass ? "PASS" : "FAIL"} |`,
    ),
    "",
    run.route === "plan"
      ? `Time from the press to the Review: ${seconds(run.totalMs)}.`
      : `Time from the press: Folders made ${seconds(run.proposedMs)}, first Document placed ${seconds(run.firstPlacementMs)}, all settled ${seconds(run.totalMs)}.`,
    ...(run.plan ? planLines(run.plan) : []),
    ...(run.tagging?.inputPerRequest.length ? taggingLines(run.tagging) : []),
    "",
    "| Requests | Count | Input tokens | Output tokens | Cost |",
    "|---|---:|---:|---:|---:|",
    ...run.spend.map(
      (each) =>
        `| ${each.who} | ${each.requests} | ${each.input.toLocaleString("en")} | ${each.output.toLocaleString("en")} | ${each.cost === null ? "–" : `$${each.cost.toFixed(4)}`} |`,
    ),
    "",
    "## Folders proposed",
    "",
    "| Folder | Documents | Labels of its Documents | Description |",
    "|---|---:|---|---|",
    ...scores.folderSizes.map(({ folder, size }) => {
      const labels = new Map<string, number>();
      for (const each of outcomes)
        if (each.folder === folder.id) {
          const label = each.doc.folder ?? "none";
          labels.set(label, (labels.get(label) ?? 0) + 1);
        }
      return `| ${folder.name} | ${size} | ${[...labels].map(([label, count]) => `${label} ${count}`).join(", ") || "–"} | ${folder.description} |`;
    }),
    "",
    `Tag names applied: ${[...new Set(outcomes.flatMap((each) => each.tags))].sort().join(", ") || "none"}.`,
  ];
  if (!run.listMistakes) {
    lines.push(
      "",
      "Held-out mistakes are not listed (set INCARNAMIND_ORGANIZE_SHOW_HELDOUT=1 for the final run).",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "",
    "## Mistakes",
    "",
    'Labelled Folder "none" means it fits none of the five. (topic) marks a Tag that names no kind.',
    "",
    "| Document | Labelled: Folder; kinds | Proposed: Folder; Tags | What is wrong |",
    "|---|---|---|---|",
  );
  for (const outcome of outcomes) {
    const problems = problemsOf(outcome, outcomes, verdicts);
    if (!outcome.readable) problems.push(`no text, not measured (Organize: ${outcome.status})`);
    else if (outcome.error) problems.push(`${outcome.status}: ${outcome.error.slice(0, 80)}`);
    if (problems.length === 0) continue;
    const { doc } = outcome;
    lines.push(
      `| ${doc.id} (${doc.language}, ${formatOf(doc)}) | ${doc.folder ?? "none"}; ${doc.tags.join(", ")} | ${folderName(outcome.folder)}; ${kindList(outcome.tags)} | ${problems.join("; ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
