/**
 * The bars of the gate for the ask for a check's missing records (`gates/records-ask.md`, bars 1
 * to 4 and the plan's changes), read from both arms' records with no request. It prints what each
 * cell counted first; a cell with nothing in it is an error, never a bar that holds.
 */
import { createHash } from "node:crypto";
import type { EvidenceAsk } from "./checkRequests";
import { UNREAD_BY_JUDGE } from "./judge";
import {
  ARMS,
  type Arm,
  type ItemRecord,
  type Language,
  PAIR_RUNS,
  PAIRS,
  pilotItems,
  RESEARCH_IDS,
  RESEARCH_RUNS,
} from "./recordsAsk";
import { countedVerdict, type SentenceSupport } from "./support";

export const LANGUAGES: readonly Language[] = ["en", "zh-CN"];
export type CaseSet = "research" | "pairs";
const SETS: readonly CaseSet[] = ["research", "pairs"];

/** Bars 1 and 2 aren't settled when `main` shows the fault fewer times than this. */
export const SETTLED_AT = 4;
/** Bar 1: the branch's asks answered with a Document's own references, at most, in all. */
const REFERENCES_ALLOWED = 2;
/** Bar 4: the most the branch's Not checked share may rise over `main`'s in a language (#3042). */
const NOT_CHECKED_MARGIN = 0.12;

/** How an arm ran, as it wrote it beside its records. */
export interface ArmInfo {
  arm: Arm;
  /** The commit of the folder it ran from, as `commitOf` names it. */
  commit: string;
  /** The SHA-256 of its `src` folder's files, so two arms are known to run different source. */
  source: string;
  model: string;
  judge: string;
  dry: boolean;
  /** In the dry run, how often anything called `fetch`: it throws, so this must stay 0. */
  fetchCalls: number;
  items: string[];
  startedAt: string;
  endedAt: string | null;
}

export interface JudgedSentence {
  key: string;
  sentence: string;
  cites: { documentName: string | null; quote: string | null }[];
  /** The words its Citations' quotes don't state; null when they state it all. */
  unstated: string | null;
}

export interface Judged {
  model: string;
  sentences: JudgedSentence[];
  failedTries: string[];
}

/** What the sentence shows the User: ✓ only when the check reads it Supported on its own Citations. */
export const tick = (sentence: Pick<SentenceSupport, "verdict">) =>
  sentence.verdict === "supported";

export const asksOf = (sentence: Pick<SentenceSupport, "checks">): EvidenceAsk[] =>
  (sentence.checks ?? []).flatMap((run) => run.asks ?? []);

const QUOTE_FIELD = /"quote"\s*:\s*("(?:[^"\\]|\\.)*")/gu;
const BRACKETED = /\[\^?(\d{1,3})\]/gu;

/** The quotes a reply to the ask gives, from its JSON, fenced or not. */
export function quotesInReply(reply: string): string[] {
  return [...reply.matchAll(QUOTE_FIELD)].flatMap((match) => {
    try {
      const quote: unknown = JSON.parse(match[1] ?? "");
      return typeof quote === "string" ? [quote] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Bar 1's count: the ask's reply records a quote holding a bracketed number, a Document's own
 * reference such as "[1]", that the sentence doesn't hold.
 */
export function answeredWithReferences(ask: Pick<EvidenceAsk, "reply">, sentence: string): boolean {
  return quotesInReply(ask.reply).some((quote) =>
    [...quote.matchAll(BRACKETED)].some((match) => !sentence.includes(`[${match[1]}]`)),
  );
}

/** The two ways bar 2 counts a check that doesn't end on the sentence's own rows. */
export const OFF_ROWS = ["no evidence", "found elsewhere"] as const;
export type OffRows = (typeof OFF_ROWS)[number];

/**
 * Bar 2's count (the plan's changes): the check ended Not checked for want of evidence, or found
 * elsewhere, its evidence not on the sentence's own rows, in the sentence or one of its parts; a
 * check that holds both is no evidence. Null when it ended otherwise.
 */
export function offItsRows(
  sentence: Pick<SentenceSupport, "verdict" | "reason" | "parts">,
): OffRows | null {
  if (sentence.verdict !== "not-checked") return null;
  const reasons = [sentence.reason, ...sentence.parts.map((part) => part.reason)];
  if (reasons.includes("no-evidence")) return "no evidence";
  return reasons.includes("found-elsewhere") ? "found elsewhere" : null;
}

/**
 * The rule for a research Answer's table-row sentence (bar 2's count beside it): the sentence or
 * one of its quotes holds "O(", or a quote reads as a table row, here a quote with no sentence end
 * whose words hold at least three figures, such as "220 B 210 B 2,740".
 */
export function isTableRowSentence(sentence: Pick<SentenceSupport, "sentence" | "cites">): boolean {
  const quotes = sentence.cites.flatMap((cited) => (cited.quote === null ? [] : [cited.quote]));
  if ([sentence.sentence, ...quotes].some((text) => text.includes("O("))) return true;
  return quotes.some(
    (quote) =>
      !/[.!?。！？]\s*$/u.test(quote.trim()) &&
      quote.split(/\s+/u).filter((word) => /\d/u.test(word)).length >= 3,
  );
}

const LABEL =
  /\[\^(\d{1,3})\]\s*[:：]?|\[(\d{1,3})\](?=\s*(?:passage\s+)?P\d)|\b(?:marker|cite|citation)\s+(\d{1,3})\b\s*[:：]?/giu;
const QUOTED = /“[^”]+”|"[^"]+"/gu;
const LOCATION = /\blocation\s*[:=]?\s*(?:“[^”]*”|"[^"]*")/giu;

/**
 * Whether a check's reply puts two quotes under one marker on one record line, as "[^1]: Weighted
 * Keys, p. 4 — “…” and “…”": a line that starts with a marker, where one marker is followed by two
 * quotes or more before the next. A record holds one quote, so such a line is no record.
 */
export function twoQuotesUnderOneMarker(reply: string): boolean {
  return reply.split("\n").some((line) => {
    const text = line
      .replace(/^[\s>*_#`•-]*/u, "")
      .replace(/^(?:citations?|cite|records?)[^:：]{0,20}[:：]\s*/iu, "");
    const labels = [...text.matchAll(LABEL)];
    if (labels.length === 0 || labels[0]?.index !== 0) return false;
    return labels.some((label, index) => {
      const body = text
        .slice((label.index ?? 0) + label[0].length, labels[index + 1]?.index ?? text.length)
        .replace(LOCATION, "");
      return (body.match(QUOTED) ?? []).length >= 2;
    });
  });
}

/** A key for a sentence and what it cites, the same on both arms; it names no arm. */
export const judgeKey = (sentence: Pick<SentenceSupport, "sentence" | "cites">): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        sentence.sentence,
        sentence.cites.map((each) => [each.documentName, each.quote]),
      ]),
    )
    .digest("hex")
    .slice(0, 16);

export interface Scored {
  /** Each try struck as void, with why. */
  struck: { arm: Arm; key: string; attempt: number; reasons: string[] }[];
  /** Items void twice on an arm: left out on both arms. */
  leftOut: string[];
  /** Items an arm holds and the other doesn't, though neither left them out. */
  unmatched: string[];
  /** The try of each item that is read, by arm. */
  read: Record<Arm, ItemRecord[]>;
}

/** The tries read and those struck: a void try is struck, and the same list leaves it out of the score. */
export function scoreOf(records: readonly ItemRecord[]): Scored {
  const struck = records
    .filter((record) => record.void.length > 0)
    .map(({ arm, key, attempt, void: reasons }) => ({ arm, key, attempt, reasons }));
  const isStruck = (record: ItemRecord) =>
    struck.some(
      (each) =>
        each.arm === record.arm && each.key === record.key && each.attempt === record.attempt,
    );
  const keys = [...new Set(records.map((record) => record.key))];
  const kept = (arm: Arm, key: string) =>
    records.find((record) => record.arm === arm && record.key === key && !isStruck(record));
  const tried = (arm: Arm, key: string) =>
    records.some((record) => record.arm === arm && record.key === key);
  const leftOut = keys.filter((key) => ARMS.some((arm) => tried(arm, key) && !kept(arm, key)));
  const unmatched = keys.filter(
    (key) => !leftOut.includes(key) && ARMS.some((arm) => !kept(arm, key)),
  );
  const readOn = (arm: Arm) =>
    keys.flatMap((key) => {
      const record = leftOut.includes(key) || unmatched.includes(key) ? undefined : kept(arm, key);
      return record ? [record] : [];
    });
  return { struck, leftOut, unmatched, read: { main: readOn("main"), branch: readOn("branch") } };
}

const setOf = (record: ItemRecord): CaseSet => (record.kind === "research" ? "research" : "pairs");

export interface Cell {
  arm: Arm;
  language: Language;
  set: CaseSet;
  /** Research Answers, or the pairs' checks. */
  items: number;
  /** The cited sentences checked. */
  sentences: number;
  asks: number;
}

/** What each cell counted, by arm, language and case set, in the language keys the record writes. */
export function cellsOf(read: Scored["read"]): Cell[] {
  return ARMS.flatMap((arm) =>
    LANGUAGES.flatMap((language) =>
      SETS.map((set) => {
        const records = read[arm].filter(
          (record) => record.language === language && setOf(record) === set,
        );
        const sentences = records.flatMap((record) => record.sentences);
        return {
          arm,
          language,
          set,
          items: records.length,
          sentences: sentences.length,
          asks: sentences.reduce((total, sentence) => total + asksOf(sentence).length, 0),
        };
      }),
    ),
  );
}

/** Each cell with nothing in it, named: an error, never a bar that holds. */
export const emptyCells = (cells: readonly Cell[]): string[] =>
  cells
    .filter((cell) => cell.items === 0 || cell.sentences === 0)
    .map((cell) => `${cell.arm}, ${cell.language}, ${cell.set}`);

export type Reading = "holds" | "fails" | "not settled";

export interface CountBar {
  main: number;
  branch: number;
  reading: Reading;
}

/** Bars 1 and 2: not settled under `SETTLED_AT` on main; else the branch at most half of main's. */
export function halfOfMain(
  main: number,
  branch: number,
  most = Number.POSITIVE_INFINITY,
): CountBar {
  if (main < SETTLED_AT) return { main, branch, reading: "not settled" };
  return { main, branch, reading: branch <= main / 2 && branch <= most ? "holds" : "fails" };
}

const sentencesOf = (records: readonly ItemRecord[]) =>
  records.flatMap((record) => record.sentences.map((sentence) => ({ record, sentence })));

/** Bar 1: the asks, in both case sets, answered with a Document's own reference numbers. */
export function referenceAsks(records: readonly ItemRecord[]) {
  return sentencesOf(records).flatMap(({ record, sentence }) =>
    asksOf(sentence)
      .filter((ask) => answeredWithReferences(ask, sentence.sentence))
      .map((ask) => ({ record, sentence, ask })),
  );
}

export const bar1 = (read: Scored["read"]): CountBar =>
  halfOfMain(
    referenceAsks(read.main).length,
    referenceAsks(read.branch).length,
    REFERENCES_ALLOWED,
  );

const rightChecks = (records: readonly ItemRecord[]) =>
  records.filter((record) => record.kind === "pair" && record.twin === "right");

/** Bar 2: the right sentences' checks that end with no evidence or found elsewhere, each with its kind. */
export const offRows = (records: readonly ItemRecord[]) =>
  rightChecks(records).flatMap((record) => {
    const kinds = record.sentences.map(offItsRows);
    const kind = OFF_ROWS.find((each) => kinds.includes(each));
    return kind ? [{ record, kind }] : [];
  });

export const bar2 = (read: Scored["read"]): CountBar =>
  halfOfMain(offRows(read.main).length, offRows(read.branch).length);

export interface WrongTick {
  record: ItemRecord;
  sentence: SentenceSupport;
  /** An evidence ask was sent for it: such a ✓ counts against the change; one with none is listed only. */
  asked: boolean;
}

/** Each ✓ on a wrong twin, with whether an evidence ask was sent for it. */
export const wrongTicks = (records: readonly ItemRecord[]): WrongTick[] =>
  records
    .filter((record) => record.kind === "pair" && record.twin === "wrong")
    .flatMap((record) =>
      record.sentences
        .filter(tick)
        .map((sentence) => ({ record, sentence, asked: asksOf(sentence).length > 0 })),
    );

export interface Bar3Pairs {
  main: number;
  branch: number;
  /** Wrong twins the branch gave a ✓ through an ask that `main` gave none through an ask. */
  newTwins: number[];
  reading: Reading;
}

/**
 * Bar 3 on the wrong twins: of the ✓ reached through an ask, the branch gives no wrong twin one
 * that `main` didn't give it, and no more in all.
 */
export function bar3Pairs(read: Scored["read"]): Bar3Pairs {
  const counted = (arm: Arm) => wrongTicks(read[arm]).filter((each) => each.asked);
  const main = counted("main");
  const branch = counted("branch");
  const mainTwins = new Set(main.map((each) => each.record.pair));
  const newTwins = [
    ...new Set(
      branch.flatMap((each) =>
        each.record.pair !== null && !mainTwins.has(each.record.pair) ? [each.record.pair] : [],
      ),
    ),
  ];
  return {
    main: main.length,
    branch: branch.length,
    newTwins,
    reading: newTwins.length === 0 && branch.length <= main.length ? "holds" : "fails",
  };
}

const researchTicks = (records: readonly ItemRecord[]) =>
  sentencesOf(records.filter((record) => record.kind === "research")).filter(({ sentence }) =>
    tick(sentence),
  );

/** The research Answers' ✓ sentences the judge reads, each once, in an order that names no arm. */
export function toJudge(records: readonly ItemRecord[]): Omit<JudgedSentence, "unstated">[] {
  const unique = new Map<string, Omit<JudgedSentence, "unstated">>();
  for (const { sentence } of researchTicks(records)) {
    const key = judgeKey(sentence);
    unique.set(key, {
      key,
      sentence: sentence.sentence,
      cites: sentence.cites.map(({ documentName, quote }) => ({ documentName, quote })),
    });
  }
  return [...unique.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface Bar3Research {
  main: number;
  branch: number;
  /**
   * ✓ sentences the judge's record has no line for, or whose line the judge's reply didn't give:
   * the bar isn't read while there is one.
   */
  unjudged: number;
  reading: Reading | "not judged";
}

/** What the judge said of a sentence: the words it found unstated, null for stated, or unread. */
function judgementOf(
  lines: ReadonlyMap<string, string | null>,
  sentence: SentenceSupport,
): string | null | "unread" {
  const line = lines.get(judgeKey(sentence));
  if (line === undefined || line?.startsWith(UNREAD_BY_JUDGE)) return "unread";
  return line;
}

/** Bar 3 on the research Answers: the branch has no more ✓ the judge finds unstated than `main`. */
export function bar3Research(read: Scored["read"], judged: Judged | null): Bar3Research {
  const lines = new Map((judged?.sentences ?? []).map((each) => [each.key, each.unstated]));
  const unstated = (arm: Arm) =>
    researchTicks(read[arm]).filter(({ sentence }) => {
      const said = judgementOf(lines, sentence);
      return said !== null && said !== "unread";
    }).length;
  const unjudged = ARMS.flatMap((arm) => researchTicks(read[arm])).filter(
    ({ sentence }) => judgementOf(lines, sentence) === "unread",
  ).length;
  const main = unstated("main");
  const branch = unstated("branch");
  return {
    main,
    branch,
    unjudged,
    reading: judged === null || unjudged > 0 ? "not judged" : branch <= main ? "holds" : "fails",
  };
}

export interface NotCheckedShare {
  arm: Arm;
  language: Language;
  notChecked: number;
  cited: number;
}

/** Bar 4's shares: the research Answers' cited sentences Not checked, by arm and language. */
export function notCheckedShares(read: Scored["read"]): NotCheckedShare[] {
  return ARMS.flatMap((arm) =>
    LANGUAGES.map((language) => {
      const sentences = read[arm]
        .filter((record) => record.kind === "research" && record.language === language)
        .flatMap((record) => record.sentences);
      return {
        arm,
        language,
        notChecked: sentences.filter((each) => countedVerdict(each) === "not-checked").length,
        cited: sentences.length,
      };
    }),
  );
}

const share = (each: NotCheckedShare | undefined) =>
  each && each.cited > 0 ? each.notChecked / each.cited : 0;

/** Bar 4: in neither language is the branch's share more than 12 points above `main`'s. */
export function bar4(
  read: Scored["read"],
): { language: Language; rise: number; reading: Reading }[] {
  const shares = notCheckedShares(read);
  const of = (arm: Arm, language: Language) =>
    share(shares.find((each) => each.arm === arm && each.language === language));
  return LANGUAGES.map((language) => {
    const rise = of("branch", language) - of("main", language);
    return { language, rise, reading: rise <= NOT_CHECKED_MARGIN + 1e-9 ? "holds" : "fails" };
  });
}

/** The count with no bar: check replies that put two quotes under one marker, by arm and language. */
export function twoQuoteReplies(read: Scored["read"]) {
  return ARMS.flatMap((arm) =>
    LANGUAGES.map((language) => {
      const replies = read[arm]
        .filter((record) => record.language === language)
        .flatMap((record) => record.sentences)
        .flatMap((sentence) => (sentence.checks ?? []).flatMap((run) => run.replies));
      return {
        arm,
        language,
        replies: replies.length,
        twoQuotes: replies.filter(twoQuotesUnderOneMarker).length,
      };
    }),
  );
}

const percent = (part: number, whole: number) =>
  whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "none";
const dollars = (amount: number | null) =>
  amount === null ? "unknown" : `US$${amount.toFixed(4)}`;
const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
const quoted = (text: string | null) => (text === null ? "(no quote)" : `“${oneLine(text)}”`);

/** What the tries cost; null when a request had no price. */
function spent(records: readonly ItemRecord[]): number | null {
  let total = 0;
  for (const record of records) {
    if (record.requests.dollars === null) return null;
    total += record.requests.dollars;
  }
  return total;
}

/** The run's planned size: Answers and checks on each arm. */
const PLANNED = {
  research: RESEARCH_IDS.length * RESEARCH_RUNS,
  pairs: PAIRS.length * 2 * PAIR_RUNS,
};

function spendLines(
  records: readonly ItemRecord[],
  judged: Judged | null,
  judgeDollars: number | null,
): string[] {
  const rows = ARMS.flatMap((arm) =>
    SETS.map((set) => {
      const some = records.filter((record) => record.arm === arm && setOf(record) === set);
      const cost = spent(some);
      return {
        arm,
        set,
        tries: some.length,
        requests: some.reduce((total, each) => total + each.requests.answered, 0),
        cost,
      };
    }),
  );
  const mean = (set: CaseSet) => {
    const some = rows.filter((row) => row.set === set && row.tries > 0);
    if (some.some((row) => row.cost === null)) return null;
    const tries = some.reduce((total, row) => total + row.tries, 0);
    return tries > 0 ? some.reduce((total, row) => total + (row.cost ?? 0), 0) / tries : null;
  };
  const research = mean("research");
  const pairs = mean("pairs");
  const projected =
    research === null || pairs === null
      ? null
      : 2 * (research * PLANNED.research + pairs * PLANNED.pairs) + (judgeDollars ?? 0);
  const tries = spent(records);
  const total =
    tries === null || (judged !== null && judgeDollars === null)
      ? null
      : tries + (judgeDollars ?? 0);
  return [
    "## Spend",
    "",
    "Every try, struck ones included, at the catalog's prices.",
    "",
    "| Arm | Case set | Tries | Requests answered | Cost |",
    "|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.arm} | ${row.set} | ${row.tries} | ${row.requests} | ${dollars(row.cost)} |`,
    ),
    "",
    `In all: ${dollars(total)}${judged ? `, the judge's ${dollars(judgeDollars)} included` : ", no judge yet"}.`,
    "",
    `At these means (${dollars(research)} a research Answer, ${dollars(pairs)} a pair's check), the whole run of ${PLANNED.research} Answers and ${PLANNED.pairs} checks on each arm comes to ${dollars(projected)}. The stop is US$2.50, the pilot and one rerun included.`,
    "",
  ];
}

export interface BarsReading {
  lines: string[];
  /** What keeps the bars from being read: empty cells, unmatched arms, arms on the same source. */
  errors: string[];
  failed: string[];
  notSettled: string[];
}

const isPilot = (records: readonly ItemRecord[]) => {
  const pilot = new Set(pilotItems().map((item) => item.key));
  return records.length > 0 && records.every((record) => pilot.has(record.key));
};

/** Every bar of the plan, the branch read against `main`, with what each cell counted first. */
export function readBars(input: {
  arms: readonly ArmInfo[];
  records: readonly ItemRecord[];
  judged: Judged | null;
  judgeDollars: number | null;
  /** The run's `main` commit, and the SHA-256 of its `src` as `sourceOf` takes it. */
  runMain: { commit: string; source: string };
}): BarsReading {
  const { arms, records, judged, judgeDollars, runMain } = input;
  const errors: string[] = [];
  const failed: string[] = [];
  const notSettled: string[] = [];
  const armOf = (arm: Arm) => arms.find((each) => each.arm === arm);
  for (const arm of ARMS) if (!armOf(arm)) errors.push(`No record of how the ${arm} arm ran.`);
  const [main, branch] = [armOf("main"), armOf("branch")];
  if (main && branch && main.source === branch.source)
    errors.push("Both arms ran the same source: the main arm must run main's src.");
  if (main && main.source !== runMain.source)
    errors.push(`The main arm didn't run the src of the run's main, ${runMain.commit}.`);
  for (const each of arms) {
    if (each.dry && each.fetchCalls > 0)
      errors.push(`The ${each.arm} arm called fetch ${each.fetchCalls} times in a dry run.`);
    if (each.endedAt === null) errors.push(`The ${each.arm} arm didn't finish.`);
  }
  const scored = scoreOf(records);
  if (scored.unmatched.length > 0)
    errors.push(`The arms don't hold the same items: ${scored.unmatched.join(", ")}.`);
  const cells = cellsOf(scored.read);
  const head = [
    "# The ask for a check's missing records: the bars",
    "",
    `The run's main: ${runMain.commit}, its src ${runMain.source.slice(0, 12)}.`,
    "",
    ...arms.map(
      (each) =>
        `- **${each.arm}**: ${each.commit}, source ${each.source.slice(0, 12)}; ${each.model}, judge ${each.judge}${each.dry ? `; dry run on the scripted chat model, fetch called ${each.fetchCalls} times` : ""}; ${each.items.length} items, ${each.startedAt} to ${each.endedAt ?? "not finished"}.`,
    ),
    "",
    ...spendLines(records, judged, judgeDollars),
    "## Struck as void",
    "",
    ...(scored.struck.length === 0
      ? ["None.", ""]
      : [
          ...scored.struck.map(
            (each) => `- ${each.arm}, ${each.key}, try ${each.attempt}: ${each.reasons.join("; ")}`,
          ),
          "",
          `Left out on both arms, void twice: ${scored.leftOut.length === 0 ? "none" : scored.leftOut.join(", ")}.`,
          "",
        ]),
    "## What each cell counted",
    "",
    "| Arm | Language | Case set | Items | Cited sentences | Evidence asks |",
    "|---|---|---|---|---|---|",
    ...cells.map(
      (cell) =>
        `| ${cell.arm} | ${cell.language} | ${cell.set} | ${cell.items} | ${cell.sentences} | ${cell.asks} |`,
    ),
    "",
  ];
  if (isPilot(records)) {
    return {
      lines: [...head, "The pilot: no bar is read from it.", ""],
      errors,
      failed,
      notSettled,
    };
  }
  const empty = emptyCells(cells);
  if (empty.length > 0) errors.push(`Empty cells, which no bar reads: ${empty.join("; ")}.`);
  if (errors.length > 0)
    return {
      lines: [...head, "## Not read", "", ...errors.map((each) => `- ${each}`), ""],
      errors,
      failed,
      notSettled,
    };

  const reading = (name: string, value: Reading | "not judged") => {
    if (value === "fails") failed.push(name);
    if (value === "not settled") notSettled.push(name);
    if (value === "not judged") errors.push(`${name}: not judged`);
    return value === "fails" ? "**fails**" : value;
  };
  const one = bar1(scored.read);
  const two = bar2(scored.read);
  const threePairs = bar3Pairs(scored.read);
  const threeResearch = bar3Research(scored.read, judged);
  const four = bar4(scored.read);
  const shares = notCheckedShares(scored.read);
  const byLanguage = (count: (records: readonly ItemRecord[]) => number | string) =>
    ARMS.map(
      (arm) =>
        `${arm}: ${LANGUAGES.map((language) => `${language} ${count(scored.read[arm].filter((record) => record.language === language))}`).join(", ")}`,
    ).join("; ");
  const byKind = (kinds: readonly OffRows[]) =>
    OFF_ROWS.map((kind) => `${kinds.filter((each) => each === kind).length} ${kind}`).join(" and ");
  const tableRows = (records: readonly ItemRecord[]) =>
    byKind(
      sentencesOf(records.filter((record) => record.kind === "research")).flatMap(
        ({ sentence }) => {
          const kind = isTableRowSentence(sentence) ? offItsRows(sentence) : null;
          return kind ? [kind] : [];
        },
      ),
    );
  const kindsOn = (arm: Arm, language: Language) =>
    offRows(scored.read[arm].filter((record) => record.language === language)).map(
      (each) => each.kind,
    );
  const bySet = (arm: Arm) =>
    SETS.map(
      (set) =>
        `${set} ${referenceAsks(scored.read[arm].filter((record) => setOf(record) === set)).length}`,
    ).join(", ");
  const lines = [
    ...head,
    "## 1. Asks answered with a Document's own reference numbers",
    "",
    `main ${one.main} (${bySet("main")}), branch ${one.branch} (${bySet("branch")}). By language: ${byLanguage((some) => referenceAsks(some).length)}.`,
    "",
    `The branch at most half of main's and at most ${REFERENCES_ALLOWED} in all; not settled under ${SETTLED_AT} on main: ${reading("1. Asks answered with references", one.reading)}.`,
    "",
    ...ARMS.flatMap((arm) =>
      referenceAsks(scored.read[arm]).map(
        ({ record, sentence, ask }) =>
          `- ${arm}, ${record.key}: ${oneLine(sentence.sentence)} — the reply: ${oneLine(ask.reply).slice(0, 300)}`,
      ),
    ),
    "",
    "## 2. The right sentences' checks with no evidence or found elsewhere",
    "",
    `Of ${rightChecks(scored.read.main).length} checks on main and ${rightChecks(scored.read.branch).length} on the branch, those that end with no evidence or found elsewhere: main ${two.main}, branch ${two.branch}.`,
    "",
    "| Arm | Language | No evidence | Found elsewhere |",
    "|---|---|---|---|",
    ...ARMS.flatMap((arm) =>
      LANGUAGES.map((language) => {
        const kinds = kindsOn(arm, language);
        return `| ${arm} | ${language} | ${OFF_ROWS.map((kind) => kinds.filter((each) => each === kind).length).join(" | ")} |`;
      }),
    ),
    "",
    `The branch at most half of main's; not settled under ${SETTLED_AT} on main, its two kinds together: ${reading("2. No evidence or found elsewhere on the right sentences", two.reading)}.`,
    "",
    ...ARMS.flatMap((arm) =>
      offRows(scored.read[arm]).map(
        ({ record, kind }) =>
          `- ${arm}, ${record.key}, ${kind}: ${oneLine(record.sentences[0]?.sentence ?? record.name)}`,
      ),
    ),
    "",
    `Beside it, with no bar: the research Answers' table-row sentences that end so, by the same two kinds. A table-row sentence holds "O(", or cites one, or cites a quote with no sentence end whose words hold three figures or more. ${byLanguage(tableRows)}.`,
    "",
    "## 3. ✓ on wrong sentences",
    "",
    `The wrong twins' ✓ reached through an ask: main ${threePairs.main}, branch ${threePairs.branch}; twins the branch gave one that main didn't: ${threePairs.newTwins.length === 0 ? "none" : threePairs.newTwins.map((pair) => `pair ${pair}`).join(", ")}: ${reading("3. Wrong twins", threePairs.reading)}.`,
    "",
    "Each ✓ on a wrong twin; one with no ask is the same request on both arms, listed and not counted:",
    "",
    ...ARMS.flatMap((arm) =>
      wrongTicks(scored.read[arm]).map(
        (each) =>
          `- ${arm}, ${each.record.key}, ${each.asked ? "through an ask" : "no ask"}: ${oneLine(each.sentence.sentence)}`,
      ),
    ),
    "",
    `The research Answers' ✓ the judge (${judged?.model ?? "none"}) finds unstated: main ${threeResearch.main}, branch ${threeResearch.branch}${threeResearch.unjudged > 0 ? `; ${threeResearch.unjudged} ✓ not judged` : ""}: ${reading("3. Unstated ✓ in the research Answers", threeResearch.reading)}.`,
    "",
    ...(judged?.failedTries.length
      ? [`The judge's failed tries: ${judged.failedTries.join("; ")}.`, ""]
      : []),
    ...ARMS.flatMap((arm) => {
      const lines = new Map((judged?.sentences ?? []).map((each) => [each.key, each.unstated]));
      return researchTicks(scored.read[arm]).flatMap(({ record, sentence }) => {
        const said = judgementOf(lines, sentence);
        return said === null
          ? []
          : [
              `- ${arm}, ${record.key}: ${oneLine(sentence.sentence)} — ${said === "unread" ? "not judged" : `unstated: ${said}`}`,
            ];
      });
    }),
    "",
    "Every ✓ reached through an ask, on each arm, to read by hand (only an ask's reply can differ between the arms); a pair's check on the branch says whether main's check of the same item gave a ✓ too:",
    "",
    ...ARMS.flatMap((arm) =>
      sentencesOf(scored.read[arm])
        .filter(({ sentence }) => tick(sentence) && asksOf(sentence).length > 0)
        .map(({ record, sentence }) => {
          const onMain = scored.read.main.find((each) => each.key === record.key);
          const beside =
            arm === "branch" && record.kind === "pair"
              ? onMain?.sentences.some(tick)
                ? " (main ✓ too)"
                : " (**new**: main gave none)"
              : "";
          return `- ${arm}, ${record.key}${beside}: ${oneLine(sentence.sentence)} — cites ${sentence.cites.map((each) => quoted(each.quote)).join(" · ")}`;
        }),
    ),
    "",
    "## 4. Not checked, by language",
    "",
    "| Arm | Language | Not checked | Cited sentences | Share |",
    "|---|---|---|---|---|",
    ...shares.map(
      (each) =>
        `| ${each.arm} | ${each.language} | ${each.notChecked} | ${each.cited} | ${percent(each.notChecked, each.cited)} |`,
    ),
    "",
    ...ARMS.map((arm) => {
      const of = (language: Language) =>
        share(shares.find((each) => each.arm === arm && each.language === language));
      return `The gap on ${arm}, Chinese less English: ${(100 * (of("zh-CN") - of("en"))).toFixed(1)} points.`;
    }),
    "",
    ...four.map(
      (each) =>
        `${each.language}: the branch's share ${each.rise >= 0 ? "above" : "below"} main's by ${(100 * Math.abs(each.rise)).toFixed(1)} points, at most 12 above: ${reading(`4. Not checked, ${each.language}`, each.reading)}.`,
    ),
    "",
    "## Two quotes under one marker (no bar)",
    "",
    "| Arm | Language | Check replies | With a record line holding two quotes under one marker |",
    "|---|---|---|---|",
    ...twoQuoteReplies(scored.read).map(
      (each) => `| ${each.arm} | ${each.language} | ${each.replies} | ${each.twoQuotes} |`,
    ),
    "",
    "## Verdict",
    "",
    errors.length > 0
      ? `Not read: ${errors.join("; ")}.`
      : failed.length > 0
        ? `A bar failed, so nothing ships from this run: ${failed.join("; ")}.`
        : notSettled.length > 0
          ? `Not settled, so nothing ships from this run: ${notSettled.join("; ")}.`
          : "Every bar holds.",
    "",
  ];
  return { lines, errors, failed, notSettled };
}

/** The reader's list of every try: each check's result, its asks and their replies, and its requests. */
export function reportLines(records: readonly ItemRecord[]): string[] {
  return [
    "# The ask for a check's missing records: every try",
    "",
    ...records.flatMap((record) => [
      `## ${record.arm}, ${record.key}, try ${record.attempt}${record.void.length > 0 ? " (struck as void)" : ""}`,
      "",
      `${record.name}, ${record.language}. ${record.requests.answered} requests answered, ${record.requests.failed.length} failed tries; ${dollars(record.requests.dollars)}; ${record.seconds.toFixed(0)} s.`,
      ...(record.void.length > 0 ? ["", `Void: ${record.void.join("; ")}`] : []),
      ...(record.answer
        ? ["", "The Answer:", "", ...record.answer.reply.split("\n").map((line) => `> ${line}`)]
        : []),
      "",
      ...record.sentences.flatMap((sentence) => [
        `- ${oneLine(sentence.sentence)}`,
        `  - ${sentence.verdict}${sentence.reason ? `, ${sentence.reason}` : ""}; cites ${sentence.cites.map((each) => quoted(each.quote)).join(" · ")}`,
        `  - evidence asked: ${asksOf(sentence).length > 0 ? "yes" : "no"}`,
        ...asksOf(sentence).flatMap((ask) => [
          "  - the ask, its Passages by id only (the record keeps them whole):",
          "",
          "    ```text",
          ...askShown(ask.text).map((line) => `    ${line}`),
          "    ```",
          "",
          `  - its reply: ${oneLine(ask.reply)}`,
        ]),
      ]),
      "",
    ]),
  ];
}

/** An ask's own lines, and its Passages by id. */
function askShown(text: string): string[] {
  const at = text.indexOf("The Passages:");
  const ids = [...text.matchAll(/<passage id="([^"]+)"/gu)].map((match) => match[1]);
  return [
    ...(at < 0 ? text : text.slice(0, at)).trimEnd().split("\n"),
    `The Passages: ${ids.length === 0 ? "none" : ids.join(", ")}`,
  ];
}

/**
 * The sheet two readers mark blind to the arm, for the conclusion inside a fact part: every
 * research sentence the part-by-part check counts ✓, on either arm, in an order that names none,
 * and the key that names each one's arm and the record's facts, kept apart until both have marked.
 */
export function kindBSheet(read: Scored["read"]) {
  const rows = ARMS.flatMap((arm) =>
    sentencesOf(read[arm].filter((record) => record.kind === "research"))
      .filter(({ sentence }) => countedVerdict(sentence) === "supported")
      .map(({ record, sentence }) => {
        const verdictReply = (sentence.checks ?? [])
          .flatMap((run) => run.replies)
          .find((reply) => /verdict\s*:\s*supported/iu.test(reply));
        const notCovered = verdictReply
          ? (/^\s*not covered\s*:\s*(.*)$/imu.exec(verdictReply)?.[1]?.trim() ?? null)
          : null;
        return {
          order: createHash("sha256")
            .update(`${arm}\n${record.key}\n${sentence.sentence}`)
            .digest("hex"),
          arm,
          key: record.key,
          sentence: sentence.sentence,
          cites: sentence.cites.map((each) => each.quote),
          panelShown: sentence.panel?.shown.check ?? null,
          notCovered: notCovered === "" || notCovered?.toLowerCase() === "none" ? null : notCovered,
        };
      }),
  ).sort((a, b) => a.order.localeCompare(b.order));
  return {
    sheet: [
      "# Sentences counted ✓: is a conclusion, judgement or comparison inside a fact part that its Passage doesn't state?",
      "",
      "Mark each B or not. The arm of each is in the key, read only after both readers have marked.",
      "",
      ...rows.flatMap((row, index) => [
        `${index + 1}. ${oneLine(row.sentence)}`,
        ...row.cites.map((quote) => `   - cites ${quoted(quote)}`),
      ]),
      "",
    ],
    key: rows.map(({ order: _order, ...row }, index) => ({ number: index + 1, ...row })),
  };
}

/** Each field a reader needs that a try left empty: the dry run fails on any. */
export function emptyFields(records: readonly ItemRecord[]): string[] {
  return records.flatMap((record) => {
    const where = `${record.arm}, ${record.key}, try ${record.attempt}`;
    // A struck try needs only its name and why it is void.
    if (record.void.length > 0) return record.name.trim() === "" ? [`${where}: its name`] : [];
    const missing = [
      ...(record.name.trim() === "" ? ["its name"] : []),
      ...(record.sentences.length === 0 ? ["its cited sentences"] : []),
      ...(record.requests.answered === 0 ? ["its requests"] : []),
      ...(record.kind === "pair" && (record.pair === null || record.twin === null)
        ? ["its pair"]
        : []),
      ...(record.kind === "research" && (record.answer?.reply ?? "").trim() === ""
        ? ["its Answer"]
        : []),
      ...record.sentences.flatMap((sentence) => [
        ...(sentence.sentence.trim() === "" ? ["a sentence"] : []),
        ...(sentence.cites.length === 0 ? [`what “${sentence.sentence}” cites`] : []),
        ...(sentence.checks === undefined || sentence.checks.length === 0
          ? [`the check's requests for “${sentence.sentence}”`]
          : []),
        ...(sentence.verdict === "not-checked" && sentence.reason === null
          ? [`the reason “${sentence.sentence}” is Not checked`]
          : []),
        ...asksOf(sentence).flatMap((ask) => [
          ...(ask.text.trim() === "" ? [`an ask's text for “${sentence.sentence}”`] : []),
          ...(ask.reply.trim() === "" ? [`an ask's reply for “${sentence.sentence}”`] : []),
        ]),
      ]),
    ];
    return missing.map((field) => `${where}: ${field}`);
  });
}
