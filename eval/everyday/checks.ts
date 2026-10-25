/**
 * The guards every everyday request in the assistant is held to, read from
 * what the core stored, as a User would see it:
 *
 * - **Asked to write, the Mind changed**, the empty one it was asked from or
 *   a new one when the request says which (#1559).
 * - **Asked a Question, no Mind changed** (#1559), unless the request names
 *   nothing to produce and may go either way ("Summarise these papers").
 * - **Every claimed change is real**, as a model judges the reply against the
 *   record of what the calls did (./judge), never the app's own net.
 * - **Citations are there**: in the reply, or, for text written into a Mind,
 *   in the Mind, and no source there is written as text, like
 *   "[Deck, slide 3]" (#1075).
 * - **No marker without a Citation**: every Citation marker the Answer's text
 *   shows has its Citation, whatever the request.
 * - **No tool-call text**: nothing in the Answer's text is a Tool's call
 *   written as words, such as a `<cite>` block.
 * - **Every Document is covered**: asked about all the Documents in scope,
 *   each is cited, or named in a sentence saying it wasn't covered.
 * - **Only what was asked changes**: asked about one paragraph, the others
 *   read as they did.
 * - **Changed in place**: asked to make text in the Mind longer, it changes
 *   that text, not adding a second version beside it, nor leaving it as it
 *   was (#1061).
 * - **About the Question asked**: after the example's Answer, the reply
 *   says nothing of an earlier Answer.
 * - **Nothing lost on the way into a page**: a sentence left out of the reply
 *   as Add to note puts it, or of what a call gave to write into a Mind, is
 *   only a pointer to an earlier Answer ("covered in my earlier answer",
 *   "见上一条回答"); the pointers left there are counted.
 * - **No word of the example unasked**: asked about the User's own Documents
 *   after the example's Answer, nothing it wrote mentions the example's.
 * - **No word of an attempt the User never saw**: when the app asks the model
 *   again inside a turn, the reply says nothing of the earlier try (#1226); a
 *   reply that was not asked again may speak of a message the User did read.
 * - **Only the text's dates**: every date the reply gives is one the
 *   Documents' text writes, or is named as a file's (./dates).
 * - **A figure the numbers give is calculated**: asked for a difference of
 *   figures it cites, the Answer has a Calculated figure with the result, and
 *   never says it couldn't calculate it (#1444).
 * - **"This" is the one Document meant** (#1334): only the Documents a request
 *   points at are cited or named, a short piece is short, and with two on
 *   screen and nothing to tell which, it asks.
 * - **"Add this to my notes" adds the last Answer** (#1734), as it is, while a
 *   request for notes on the Documents writes new ones.
 */
import { changeLogOf } from "../../src/core/answers/claimedChanges";
import { forPage, withoutPointersBack } from "../../src/core/answers/pointersBack";
import { withoutSearchTalk } from "../../src/core/answers/searchTalk";
import { toolTextIn } from "../../src/core/answers/toolText";
import type {
  AskedQuote,
  ConversationAnswer,
  MarkedCitation,
  MarkedFigure,
} from "../../src/core/api";
import { markersWithoutCitation } from "../../src/shared/answerBlocks";
import { datesNotInText } from "./dates";
import type { ClaimVerdict } from "./judge";

/** What a request expects of its Answer. */
export interface Expected {
  /** It asks for text in a Mind: writing, adding, changing, making one. */
  write: boolean;
  /**
   * Where a piece asked for lands (#1559): in the Mind it was asked from, or in a new Mind.
   * Absent: either.
   */
  into?: "asked-from" | "new";
  /**
   * It names nothing to produce ("Summarise these papers", "总结一下这两篇论文"): answered in the
   * panel or written into a Mind, either passes. Without it, a request that doesn't ask to write
   * changes no Mind.
   */
  either?: true;
  /** Its Answer must cite the Documents in scope. */
  cite: boolean;
  /** It asks about every Document in scope ("summarise these papers"). */
  coverAll: boolean;
  /** Only this top-level Block of the Mind it is asked from (from 0) may change. */
  only?: number;
  /** It asks to change text already in the Mind: adding a new version beside it fails. */
  inPlace?: true;
  /** Asked after the example's Answer: its reply, in the panel, says nothing of an earlier Answer. */
  noEarlier?: true;
  /** The report counts the pointers to an earlier Answer left in its reply as Add to note puts it, and in what it writes into a Mind. */
  standsAlone?: true;
  /** Asked about the User's own Documents after the example's Answer: nothing it writes mentions the example's. */
  noExample?: true;
  /** Every date its reply gives is one the Documents' text writes (`RequestOutcome.texts`), or a file's named as such. */
  textDates?: boolean;
  /** Its reply is in the Question's language, whatever language the Documents are in (#892, #1273); quoted words don't count. */
  language?: "en" | "zh-CN";
  /** It asks for a figure the Documents' numbers give: a Calculated figure shows a result matching this, and the reply never says it couldn't calculate (#1444). */
  figure?: RegExp;
  /**
   * The words what it writes into a Mind must use for a thing, and must not: a translation's own
   * term ("spring tides" is 大潮, never 春潮), which Kimi K2.6 lost with thinking off (#1635).
   */
  terms?: readonly { want: string; not: readonly string[] }[];
  /** The only Documents, by name, it may cite, or name in what it writes; empty: none (#1334). */
  documents?: readonly string[];
  /** What it writes into a Mind, else its reply, holds at most this many lines (`linesOf`, #1334). */
  atMostLines?: number;
  /** It must ask the User which (ask_user) before changing anything, or it may; absent: asking fails. */
  asks?: "must" | "may";
  /**
   * True: it puts the last Answer into a Mind as it is (`answer: true`) and writes nothing new;
   * false: it writes new text, not only a copy of the last Answer (#1734).
   */
  addsAnswer?: boolean;
}

export interface RequestOutcome {
  expected: Expected;
  answer: Pick<ConversationAnswer, "text" | "toolCalls" | "steps"> & {
    citations: readonly (Pick<MarkedCitation, "documentId" | "marker"> &
      Partial<Pick<MarkedCitation, "documentName" | "pageFrom" | "pageTo" | "check">>)[];
    figures?: readonly Pick<MarkedFigure, "shown">[];
  };
  verdict: ClaimVerdict;
  /** The Mind it was asked from, by id; null or absent: none was in focus. */
  askedFrom?: string | null;
  /** The Documents the Citations it wrote into Minds quote, by id. */
  citedInMinds: readonly string[];
  /** The top-level Blocks of the Mind it was asked from (from 0) that read otherwise once its changes are accepted. */
  changedBlocks: readonly number[];
  /** The top-level Blocks Add to note put in before the request (from 0): what `inPlace` must change. */
  addedBlocks?: readonly number[];
  /** Sources the Minds it wrote hold as text, in brackets, as written. */
  sourcesAsText?: readonly string[];
  /** The text of the Blocks it wrote or changed in Minds, once its changes are accepted. */
  writtenInMinds?: readonly string[];
  /** Its reply as Add to note puts it in a page; the reply as written when not given. */
  addedToPage?: string;
  /** What its calls of add_to_mind, create_mind and edit_mind gave to write (`givenToMindsOf`). */
  givenToMinds?: readonly GivenToMind[];
  /** The app asked the model again inside the turn, so the User never read its first try. */
  askedAgain?: boolean;
  scoped: readonly { id: string; name: string }[];
  /** The text of the Documents in scope, for `textDates`. */
  texts?: readonly string[];
  /** It asked the User which (ask_user), and the Answer stopped there, waiting for them. */
  stoppedAtAsk?: boolean;
  /** The words it was asked about (#101): its first Citation must be them, found where they were selected. */
  quoted?: AskedQuote;
}

export type RequestFailure =
  | { kind: "no-change" }
  /** Asked a Question, it changed a Mind. */
  | { kind: "changed-unasked" }
  /** The piece went elsewhere than `Expected.into`. */
  | { kind: "wrong-place"; wanted: "asked-from" | "new" }
  /** `flagged`: the app's own net said so under the reply. */
  | { kind: "unbacked"; sentences: string[]; flagged: boolean }
  | { kind: "no-citations" }
  | { kind: "dead-markers"; markers: number[] }
  | { kind: "tool-text"; blocks: string[] }
  | { kind: "uncovered"; documents: string[] }
  | { kind: "outside"; blocks: number[] }
  | { kind: "beside" }
  | { kind: "untouched" }
  | { kind: "as-text"; sources: string[] }
  | { kind: "earlier"; said: string }
  | { kind: "example"; said: string }
  | { kind: "content-lost"; sentences: string[] }
  | { kind: "unseen-attempt"; said: string }
  | { kind: "date-not-in-text"; dates: string[] }
  | { kind: "wrong-language"; wanted: "en" | "zh-CN"; share: number }
  | { kind: "no-figure"; wanted: string; shown: string[] }
  | { kind: "gave-up"; said: string }
  | { kind: "term"; want: string; found: string[] }
  | { kind: "other-documents"; documents: string[] }
  | { kind: "too-long"; lines: number; most: number }
  | { kind: "no-ask" }
  | { kind: "asked" }
  | { kind: "not-the-answer" }
  | { kind: "only-a-copy" }
  /** Its first Citation, as "document, pages, check", or null for none. */
  | { kind: "not-quoted"; first: string | null };

const QUOTED = /“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』/g;
const CITATION_MARKER = /\[\^\d+\]/g;
const CJK = /[\u3400-\u9fff]/g;
const LATIN_LETTER = /[A-Za-z]/g;
/** An English reply may name a Chinese party; a Chinese one may name a company: past this, the other language is written. */
const ENGLISH_CJK_AT_MOST = 0.2;
const CHINESE_CJK_AT_LEAST = 0.5;

/** The share of a reply's letters, outside quoted words and Citation markers, that are Chinese characters. */
export function chineseShare(reply: string): number {
  const own = reply.replace(QUOTED, " ").replace(CITATION_MARKER, " ");
  const chinese = own.match(CJK)?.length ?? 0;
  const latin = own.match(LATIN_LETTER)?.length ?? 0;
  return chinese + latin === 0 ? 0 : chinese / (chinese + latin);
}

/** Whether the reply is in `language`, by the share of Chinese characters in its own words. */
export function inLanguage(reply: string, language: "en" | "zh-CN"): boolean {
  const share = chineseShare(reply);
  return language === "en" ? share <= ENGLISH_CJK_AT_MOST : share >= CHINESE_CJK_AT_LEAST;
}

const key = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();

const POINTS_BACK = new RegExp(
  [
    String.raw`\b(?:earlier|previous|first|last|prior|above|preceding) (?:answer|response|reply|message)s?\b`,
    String.raw`\b(?:disregard|ignore) (?:my|the|that|this) (?:earlier|previous|first|last|prior|answer|response|reply|figure|limit)`,
    String.raw`\bas (?:I )?(?:said|mentioned|noted|explained|described|covered|discussed) (?:earlier|before|above|previously)\b`,
    String.raw`\bearlier in (?:this|our|the) (?:conversation|chat)\b`,
    String.raw`\b(?:as|see|covered|described|explained|discussed|listed|noted|mentioned|set out|shown) above\b`,
    "(?:上一条|上条|前一条|上一个|上一次|之前|先前|前面|刚才|上面|第一个)的?(?:回答|回复|答复|答案)",
    "(?:见|参见|详见|请见|如|参阅|参考)(?:上文|前文)|(?:上文|前文)(?:已|所述|提到|说明)|如上所述|如前所述|同上",
    "(?:请|应)?(?:忽略|无视)(?:我|之前|先前|上一)",
  ].join("|"),
  "i",
);

/** Whether text points to an earlier Answer, as `noEarlier` and `standsAlone` read it. */
export const pointsBack = (text: string): boolean => POINTS_BACK.test(text);

function proseSentences(text: string): string[] {
  let fenced = false;
  return text.split("\n").flatMap((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      return [];
    }
    if (fenced || /^\s*\|/.test(line)) return [];
    return (
      line
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)]|#{1,6}|>)\s+/, "")
        // A sentence never starts with a digit, a small letter or a comma: "1.5", "e.g., Theft".
        .split(/(?<=[.!?。！？]["”’)」』]*(?:\[\^\d{1,4}\])*)(?![\d\p{Ll},;:])\s*/u)
        .map((sentence) => sentence.trim())
        .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
    );
  });
}

const lettersOf = (text: string) =>
  text
    .replace(/\[[\^=]?\d{1,4}\]/g, "")
    .replace(/\[[^\]\n]{1,200}\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase();

function leftOut(given: string, written: string): string[] {
  const there = lettersOf(written);
  return proseSentences(given).filter((sentence) => !there.includes(lettersOf(sentence)));
}

function blocksIn(text: string): string[] {
  const blocks: string[] = [];
  let block: string[] = [];
  let fenced = false;
  for (const line of [...text.split("\n"), ""]) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || line.trim() !== "") block.push(line);
    else if (block.length > 0) {
      blocks.push(block.join("\n"));
      block = [];
    }
  }
  return blocks;
}

/**
 * How the guard's `output` differs from its `input`, Block by Block: the
 * Blocks it took out, and those of its output that aren't an input Block
 * kept word for word and in order.
 */
export function guardTook(input: string, output: string): { removed: string[]; changed: string[] } {
  const kept = blocksIn(output);
  const removed: string[] = [];
  const changed: string[] = [];
  let at = 0;
  for (const block of blocksIn(input)) {
    const found = kept.indexOf(block, at);
    if (found < 0) {
      removed.push(block);
      continue;
    }
    changed.push(...kept.slice(at, found));
    at = found + 1;
  }
  return { removed, changed: [...changed, ...kept.slice(at)] };
}

// The words a pointer is made of, so what a sentence says besides is what's left.
const POINTER_WORDS = new Set(
  (
    "see refer to check for the a an my in is are was were be been has have i i've already as like " +
    "covered set out described explained discussed listed given summarised summarized detailed " +
    "addressed answered outlined shown showed noted mentioned included dealt with stated said " +
    "above earlier previous prior last first original answer answers reply response conversation " +
    "chat this that these those it they all both and or also please more further full rest other " +
    "details detail information list breakdown same which of on"
  ).split(" "),
);
const POINTER_ZH =
  /上一条|上条|前一条|上一个|上一次|之前|先前|前面|刚才|上面|回答|回复|答复|上文|前文|参见|详见|请见|参阅|参考|查看|具体|更多|信息|详情|内容|其余|其他|正如|所述|所说|已经|说明|介绍|列出|提到|一致|[的请可见如已在中里我同与，。]/gu;

function onlyAPointer(sentence: string): boolean {
  if (!POINTS_BACK.test(sentence) || /[\d"“”「」『』]/.test(sentence)) return false;
  const words = sentence.toLocaleLowerCase().match(/[a-z]+(?:['’][a-z]+)?/g) ?? [];
  const han = sentence.replace(POINTER_ZH, "").match(/\p{Script=Han}/gu) ?? [];
  return words.filter((word) => !POINTER_WORDS.has(word)).length <= 4 && han.length <= 10;
}

const NOT_A_PARAGRAPH = /^\s*(?:#|[-*+]\s|\d{1,3}[.)]\s|\||>|```|~~~)|^ {4}/;

/**
 * Whether the guard may take out a Block, by this evaluation's own reading
 * rather than the app's: a paragraph of one line and one sentence, which is
 * only a pointer to an earlier Answer (it names one, holds no figure, marker
 * or quote, and says at most four words, or ten Chinese characters, besides).
 */
const aPointerParagraph = (block: string) =>
  !block.includes("\n") &&
  !NOT_A_PARAGRAPH.test(block) &&
  proseSentences(block).length === 1 &&
  onlyAPointer(block.trim());

/** What the guard lost going from `input` to `output`: each Block it took that it may not take, and each Block it changed. */
export function guardLosses(input: string, output: string): string[] {
  const { removed, changed } = guardTook(input, output);
  return [...removed.filter((block) => !aPointerParagraph(block)), ...changed];
}

/** The sentences of what goes into a page that point to an earlier Answer. */
export const pointersIn = (text: string): string[] =>
  proseSentences(text).filter((sentence) => POINTS_BACK.test(sentence));

/** The default example's Documents, figures and words (src/core/exampleSets.ts), in English and Chinese. */
const EXAMPLE =
  /Northwind|facilities agreement|credit committee|leverage (?:limit|covenant)|\b3\.[15] ?(?:x|times)\b|\b3\.5:1|贷款协议|杠杆率|授信委员会/i;

const UNSEEN_ATTEMPT = new RegExp(
  [
    String.raw`\b(?:sorry|apolog(?:y|ies|ise|ize)|my (?:mistake|bad))\b[^.!?\n]*\b(?:previous|earlier|prior|a moment ago|just now|last (?:reply|response|answer|message|time|attempt))\b`,
    String.raw`\b(?:my|the|that|your) (?:previous|earlier|prior|last) (?:reply|response|answer|message|attempt)\b`,
    String.raw`\bas I (?:said|mentioned|noted|stated) (?:before|earlier|previously|above)\b`,
    String.raw`\b(?:let me|I'll|I will) (?:try again|redo|correct (?:that|this|myself))\b`,
    "(?:抱歉|对不起|不好意思|很抱歉|道歉)[^。！？\\n]*(?:上一|前一|之前|先前|刚才|上次|前面)",
    "(?:上一|前一|之前|先前|刚才|上次|前面)(?:条|次|个)?的?(?:回复|回答|答复|答案|消息|尝试)",
    "如我(?:之前|刚才|前面|上面)所说",
  ].join("|"),
  "iu",
);

/** The first sentence that apologises for, or refers to, an earlier reply or try of the model's. */
export function aboutAnUnseenAttempt(reply: string): string | null {
  return (
    reply
      .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
      .map((sentence) => sentence.trim())
      .find((sentence) => UNSEEN_ATTEMPT.test(sentence)) ?? null
  );
}

const COULDNT_CALCULATE =
  /\b(?:couldn't|could not|can't|cannot|unable to|wasn't able to) (?:calculate|compute|work out)\b|没能算出|没有算出|无法计算|未能计算|不能计算|没法计算/i;

export function givesUpOnCalculating(reply: string): string | null {
  return (
    reply
      .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
      .map((sentence) => sentence.trim())
      .find((sentence) => COULDNT_CALCULATE.test(sentence)) ?? null
  );
}

const NOT_COVERED =
  /\b(?:couldn't|could not|can't|cannot|didn't|did not|wasn't|weren't|isn't|aren't|not|no|unable|left out|missing|skipped)\b|没有|未能|未|无法|不能|缺少|略去/i;

function namedAsUncovered(reply: string, name: string): boolean {
  return reply
    .split(/(?<=[.!?])\s+|(?<=[。！？])|\n+/)
    .some((sentence) => key(sentence).includes(key(name)) && NOT_COVERED.test(sentence));
}

/**
 * What a call of add_to_mind, create_mind or edit_mind gave to write: its
 * `content`; or, given `answer: true`, the earlier Answer it copied, which
 * the guard reads as Add to note does, with that Answer's Question. `landed`:
 * it went into a Mind.
 */
export interface GivenToMind {
  content: string;
  question?: string;
  landed: boolean;
}

export function givenToMindsOf(
  calls: ConversationAnswer["toolCalls"],
  earlier: { text: string; question: string } | null,
): GivenToMind[] {
  return calls.flatMap((call) => {
    if (!["add_to_mind", "create_mind", "edit_mind"].includes(call.tool)) return [];
    const landed = call.status === "done" && !call.mindProblem;
    // The app takes the earlier Answer and leaves `content` aside when `answer` is true.
    if (call.input.answer === true && call.tool !== "edit_mind") {
      return earlier ? [{ content: earlier.text, question: earlier.question, landed }] : [];
    }
    return typeof call.input.content === "string" ? [{ content: call.input.content, landed }] : [];
  });
}

const guarded = ({ content, question }: GivenToMind) =>
  question === undefined ? withoutPointersBack(content).markdown : forPage(content, question);

/**
 * What the guard took out on the way into a page, Block by Block: of the
 * reply, by Add to note, and of what the calls gave to write into Minds; and
 * what of it was lost: a Block it may not take, or a Block it changed.
 */
export function takenOut(outcome: RequestOutcome): { removed: string[]; lost: string[] } {
  const pairs: [string, string][] = [
    ...(outcome.addedToPage === undefined
      ? []
      : [[outcome.answer.text, outcome.addedToPage] as [string, string]]),
    ...(outcome.givenToMinds ?? []).map((given): [string, string] => [
      given.content,
      guarded(given),
    ]),
  ];
  return {
    removed: pairs.flatMap(([input, output]) => guardTook(input, output).removed),
    lost: pairs.flatMap(([input, output]) => guardLosses(input, output)),
  };
}

const wordsOf = (text: string) =>
  new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}|\p{Script=Han}/gu) ?? []);

const wordList = (text: string): string[] =>
  text
    .replace(/\[[\^=]?\d{1,4}\]/g, "")
    .toLocaleLowerCase()
    .match(/\p{Script=Han}|[\p{L}\p{N}]+/gu) ?? [];

/** Whether `now` is `given` with some of its words taken out and none changed, as the check's cut leaves a sentence (#1397). */
function onlyTakenOut(given: string, now: string): boolean {
  const words = wordList(given);
  const left = wordList(now);
  let at = 0;
  for (const word of left) {
    at = words.indexOf(word, at) + 1;
    if (at === 0) return false;
  }
  return left.length >= 3 && left.length < words.length;
}

/**
 * The sentences the guard and search-talk filtering left in what the calls
 * gave that the Mind no longer holds as written: the model's edit_mind, or
 * the app's check of the sentences written, changed them after the guard.
 * Each is beside the Mind's sentence that is it with words only taken out
 * (`cut`), else the Block of the Mind that shares most of its words.
 */
export function rewrittenLater(
  outcome: RequestOutcome,
): { given: string; now: string | null; cut: boolean }[] {
  const written = outcome.writtenInMinds ?? [];
  const given = (outcome.givenToMinds ?? [])
    .filter(({ landed }) => landed)
    .map((given) => withoutSearchTalk(guarded(given)).markdown)
    .join("\n\n");
  return leftOut(given, written.join("\n\n")).map((sentence) => {
    const cut = written
      .flatMap((block) => proseSentences(block))
      .find((each) => onlyTakenOut(sentence, each));
    if (cut) return { given: sentence, now: cut, cut: true };
    const words = wordsOf(sentence);
    const shared = (block: string) => [...wordsOf(block)].filter((word) => words.has(word)).length;
    const now = written.reduce<string | null>(
      (best, block) => (shared(block) > (best === null ? 0 : shared(best)) ? block : best),
      null,
    );
    return { given: sentence, now, cut: false };
  });
}

/** The ways one request failed its guards; none when it passed. */
export function requestFailures(outcome: RequestOutcome): RequestFailure[] {
  const { expected, answer } = outcome;
  const failures: RequestFailure[] = [];
  const log = changeLogOf(answer.toolCalls);
  const changedAny = log.changed.size > 0 || log.made.size > 0;
  // An Answer waiting on its question has nothing else to hold to yet, but must not have written first.
  if (outcome.stoppedAtAsk) {
    return [
      ...(expected.asks === undefined ? [{ kind: "asked" } as const] : []),
      ...(changedAny ? [{ kind: "changed-unasked" } as const] : []),
    ];
  }
  if (expected.write && !changedAny) failures.push({ kind: "no-change" });
  if (!expected.write && !expected.either && changedAny) {
    failures.push({ kind: "changed-unasked" });
  }
  if (expected.into && changedAny) {
    const landed =
      expected.into === "new"
        ? log.made.size > 0
        : outcome.askedFrom != null && log.changed.has(outcome.askedFrom) && log.made.size === 0;
    if (!landed) failures.push({ kind: "wrong-place", wanted: expected.into });
  }
  if (outcome.verdict.unbacked.length > 0) {
    failures.push({
      kind: "unbacked",
      sentences: outcome.verdict.unbacked,
      flagged: (answer.steps?.unbackedClaims ?? []).length > 0,
    });
  }
  const citedHere = expected.write
    ? outcome.citedInMinds.length
    : answer.citations.length + outcome.citedInMinds.length;
  if (expected.cite && outcome.scoped.length > 0 && citedHere === 0) {
    failures.push({ kind: "no-citations" });
  }
  const dead = markersWithoutCitation(answer);
  if (dead.length > 0) failures.push({ kind: "dead-markers", markers: dead });
  const shaped = toolTextIn(answer.text);
  if (shaped.length > 0) failures.push({ kind: "tool-text", blocks: shaped });
  if (expected.coverAll) {
    const cited = new Set([
      ...answer.citations.map((citation) => citation.documentId),
      ...outcome.citedInMinds,
    ]);
    const uncovered = outcome.scoped
      .filter(
        (document) => !cited.has(document.id) && !namedAsUncovered(answer.text, document.name),
      )
      .map((document) => document.name);
    if (uncovered.length > 0) failures.push({ kind: "uncovered", documents: uncovered });
  }
  if (expected.only !== undefined) {
    const outside = outcome.changedBlocks.filter((block) => block !== expected.only);
    if (outside.length > 0) failures.push({ kind: "outside", blocks: outside });
  }
  const added = answer.toolCalls.some(
    (call) => call.tool === "add_to_mind" && call.mindChange && call.mindChange.proposals > 0,
  );
  if (expected.inPlace && added) failures.push({ kind: "beside" });
  const { addedBlocks } = outcome;
  if (
    expected.inPlace &&
    addedBlocks &&
    !addedBlocks.some((block) => outcome.changedBlocks.includes(block))
  ) {
    failures.push({ kind: "untouched" });
  }
  if (outcome.sourcesAsText && outcome.sourcesAsText.length > 0) {
    failures.push({ kind: "as-text", sources: [...outcome.sourcesAsText] });
  }
  const inMinds = outcome.writtenInMinds ?? [];
  const earlier = expected.noEarlier ? answer.text.match(POINTS_BACK)?.[0] : undefined;
  if (earlier) failures.push({ kind: "earlier", said: earlier });
  const written = [answer.text, ...inMinds].join("\n\n");
  const example = expected.noExample ? written.match(EXAMPLE)?.[0] : undefined;
  if (example) failures.push({ kind: "example", said: example });
  const { lost } = takenOut(outcome);
  if (lost.length > 0) failures.push({ kind: "content-lost", sentences: lost });
  const unseen = outcome.askedAgain ? aboutAnUnseenAttempt(answer.text) : null;
  if (unseen) failures.push({ kind: "unseen-attempt", said: unseen });
  const dates = expected.textDates ? datesNotInText(answer.text, outcome.texts ?? []) : [];
  if (dates.length > 0) failures.push({ kind: "date-not-in-text", dates });
  if (expected.language && !inLanguage(answer.text, expected.language)) {
    failures.push({
      kind: "wrong-language",
      wanted: expected.language,
      share: chineseShare(answer.text),
    });
  }
  if (expected.figure) {
    const shown = (answer.figures ?? []).map((figure) => figure.shown);
    if (!shown.some((each) => expected.figure?.test(each))) {
      failures.push({ kind: "no-figure", wanted: expected.figure.source, shown });
    }
    const gaveUp = givesUpOnCalculating(answer.text);
    if (gaveUp) failures.push({ kind: "gave-up", said: gaveUp });
  }
  for (const term of expected.terms ?? []) {
    const text = inMinds.join("\n\n");
    const found = term.not.filter((word) => text.includes(word));
    if (!text.includes(term.want) || found.length > 0) {
      failures.push({ kind: "term", want: term.want, found });
    }
  }
  failures.push(...thisFailures(outcome));
  return failures;
}

/** How many lines a reader sees in Markdown: a heading, a paragraph, a list item or a table row each one. */
export function linesOf(markdown: string): number {
  return markdown
    .split("\n")
    .filter((line) => line.trim() !== "" && !/^\s*\|?\s*:?-{3,}/.test(line)).length;
}

function otherDocuments(outcome: RequestOutcome, allowed: readonly string[]): string[] {
  const cited = new Set([
    ...outcome.answer.citations.map((citation) => citation.documentId),
    ...outcome.citedInMinds,
  ]);
  const written = [outcome.answer.text, ...(outcome.writtenInMinds ?? [])]
    .join("\n")
    .toLocaleLowerCase();
  return outcome.scoped
    .filter(
      (document) =>
        !allowed.includes(document.name) &&
        (cited.has(document.id) || written.includes(document.name.toLocaleLowerCase())),
    )
    .map((document) => document.name);
}

function thisFailures(outcome: RequestOutcome): RequestFailure[] {
  const { expected, answer } = outcome;
  const failures: RequestFailure[] = [];
  if (expected.documents) {
    const others = otherDocuments(outcome, expected.documents);
    if (others.length > 0) failures.push({ kind: "other-documents", documents: others });
  }
  const given = (outcome.givenToMinds ?? []).filter((each) => each.landed);
  if (expected.atMostLines !== undefined) {
    const written = given.map((each) => each.content).join("\n");
    const lines = linesOf(written || answer.text);
    if (lines > expected.atMostLines) {
      failures.push({ kind: "too-long", lines, most: expected.atMostLines });
    }
  }
  const asked = answer.toolCalls.some((call) => call.tool === "ask_user");
  if (expected.asks === "must" && !asked) failures.push({ kind: "no-ask" });
  const copies = given.filter((each) => each.question !== undefined).length;
  const fresh = given.length - copies;
  if (expected.addsAnswer === true && (copies === 0 || fresh > 0)) {
    failures.push({ kind: "not-the-answer" });
  }
  if (expected.addsAnswer === false && copies > 0 && fresh === 0) {
    failures.push({ kind: "only-a-copy" });
  }
  const quoted = outcome.quoted;
  const [first] = answer.citations;
  if (
    quoted &&
    (first?.documentId !== quoted.documentId ||
      first.pageFrom !== quoted.pageFrom ||
      first.pageTo !== quoted.pageTo ||
      first.check !== "found")
  ) {
    const said = first
      ? `${first.documentName}, pp. ${first.pageFrom}–${first.pageTo}, ${first.check}`
      : null;
    failures.push({ kind: "not-quoted", first: said });
  }
  return failures;
}

/** A failure as the evaluation's report lists it. */
export function failureLine(failure: RequestFailure): string {
  switch (failure.kind) {
    case "no-change":
      return "asked to write, it changed no Mind";
    case "changed-unasked":
      return "asked a Question, it changed a Mind";
    case "wrong-place":
      return failure.wanted === "new"
        ? "wrote the piece somewhere other than a new Mind"
        : "wrote the piece somewhere other than the Mind it was asked from";
    case "unbacked":
      return `claims a change no call made${failure.flagged ? " (flagged under the reply)" : ""}: ${failure.sentences.map((sentence) => `“${sentence}”`).join(" ")}`;
    case "no-citations":
      return "Documents in scope, and nothing it wrote cites them";
    case "dead-markers":
      return `wrote Citation markers that no Citation backs: ${failure.markers.map((marker) => `[^${marker}]`).join(", ")}`;
    case "tool-text":
      return `shows a Tool's call written as text: ${failure.blocks.map((block) => `“${block.slice(0, 60)}”`).join(", ")}`;
    case "uncovered":
      return `neither cites nor names as left out ${failure.documents.map((name) => `“${name}”`).join(", ")}`;
    case "outside":
      return `changed what it was asked to leave: Block ${failure.blocks.map((block) => block + 1).join(", ")}`;
    case "beside":
      return "added a new version beside the text it was asked to change";
    case "untouched":
      return "left the text it was asked to change as it was";
    case "as-text":
      return `wrote sources into a Mind as text: ${failure.sources.map((source) => `“${source}”`).join(", ")}`;
    case "earlier":
      return `talks about an earlier Answer: “${failure.said}”`;
    case "example":
      return `mentions the example unasked: “${failure.said}”`;
    case "content-lost":
      return `left out of a page what says more than a pointer: ${failure.sentences.map((sentence) => `“${sentence}”`).join(" ")}`;
    case "unseen-attempt":
      return `says something of an earlier try the User never saw: “${failure.said}”`;
    case "date-not-in-text":
      return `gives a date the Documents' text doesn't: ${failure.dates.join(", ")}`;
    case "no-figure":
      return `has no Calculated figure matching /${failure.wanted}/ (figures: ${failure.shown.length > 0 ? failure.shown.join(", ") : "none"})`;
    case "gave-up":
      return `says it couldn't calculate what its Citations give: “${failure.said}”`;
    case "term":
      return `doesn't write “${failure.want}” for it${failure.found.length > 0 ? `, but ${failure.found.map((word) => `“${word}”`).join(", ")}` : ""}`;
    case "wrong-language":
      return `is not written in ${failure.wanted === "en" ? "English" : "Chinese"}, the Question's language (${Math.round(failure.share * 100)}% of its letters are Chinese characters)`;
    case "other-documents":
      return `cites or names Documents it wasn't asked about: ${failure.documents.map((name) => `“${name}”`).join(", ")}`;
    case "too-long":
      return `asked for it short, wrote ${failure.lines} lines (at most ${failure.most})`;
    case "no-ask":
      return "didn't ask which Document was meant";
    case "asked":
      return "asked the User which, unasked";
    case "not-the-answer":
      return "didn't add the last Answer as it is, or wrote new text beside it";
    case "only-a-copy":
      return "asked for new notes, it only copied the last Answer";
    case "not-quoted":
      return `its first Citation isn't the selected words where they were selected (${failure.first ?? "no Citation"})`;
  }
}
