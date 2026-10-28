/**
 * Court decisions a sentence cites: a case name with "v." and a reporter
 * citation ("Brown v. Board of Education, 347 U.S. 483 (1954)"), a neutral
 * citation of the UK and the Commonwealth ("[2024] UKSC 5") or a law-report
 * citation ("[2019] 1 WLR 1234"). A "v." with no citation, or a number that
 * looks like none, doesn't count.
 */

export interface CaseCitation {
  /** "Brown v. Board of Education"; null when the citation stands without one. */
  name: string | null;
  /** "347 U.S. 483", "[2024] UKSC 5". */
  cite: string;
}

/** Its span in the text, from the word that introduces it to its court and year, for a sentence break inside it to be mended (`sentenceSpans`). */
export interface CitedCase extends CaseCitation {
  from: number;
  /** End of the citation identity and explicit court/year metadata, excluding a bare pinpoint. */
  citeTo: number;
  to: number;
}

const REPORTERS = [
  "U.S.",
  "S. Ct.",
  "L. Ed.",
  "L. Ed. 2d",
  "F.",
  "F.2d",
  "F.3d",
  "F.4th",
  "F. Supp.",
  "F. Supp. 2d",
  "F. Supp. 3d",
  "F. App'x",
  "F.R.D.",
  "B.R.",
  "Fed. Cl.",
  "A.",
  "A.2d",
  "A.3d",
  "N.E.",
  "N.E.2d",
  "N.E.3d",
  "N.W.",
  "N.W.2d",
  "N.Y.",
  "N.Y.2d",
  "N.Y.3d",
  "N.Y.S.",
  "N.Y.S.2d",
  "N.Y.S.3d",
  "P.",
  "P.2d",
  "P.3d",
  "S.E.",
  "S.E.2d",
  "S.W.",
  "S.W.2d",
  "S.W.3d",
  "So.",
  "So. 2d",
  "So. 3d",
  "Cal.",
  "Cal. 2d",
  "Cal. 3d",
  "Cal. 4th",
  "Cal. 5th",
  "Cal. App.",
  "Cal. App. 2d",
  "Cal. App. 3d",
  "Cal. App. 4th",
  "Cal. App. 5th",
  "Cal. Rptr.",
  "Cal. Rptr. 2d",
  "Cal. Rptr. 3d",
  "Ill.",
  "Ill. 2d",
  "Ill. App. 3d",
  "Mass.",
  "Mass. App. Ct.",
  "Wash.",
  "Wash. 2d",
  "Wash. App.",
  "Wn.2d",
  "Wn. App.",
  "Wn. App. 2d",
  "Pa.",
  "Pa. Super.",
  "Pa. Commw.",
  "N.J.",
  "N.J. Super.",
  "Ohio St.",
  "Ohio St. 2d",
  "Ohio St. 3d",
  "Ohio App. 3d",
  "Mich.",
  "Mich. App.",
  "Md.",
  "Md. App.",
  "Ga.",
  "Ga. App.",
  "N.C.",
  "N.C. App.",
  "Va.",
  "Wis.",
  "Wis. 2d",
  "Ky.",
  "La.",
  "Mo.",
  "Tenn.",
  "Conn.",
  "Minn.",
  "Colo.",
  "Fla.",
  "Tex.",
  "Tex. App.",
];

const NEUTRAL_COURTS = [
  "UKSC",
  "UKPC",
  "UKHL",
  "EWCA Civ",
  "EWCA Crim",
  "EWHC",
  "UKUT",
  "UKFTT",
  "UKEAT",
  "CSIH",
  "CSOH",
  "NICA",
  "NIQB",
  "IESC",
  "IECA",
  "IEHC",
  "HCA",
  "FCA",
  "FCAFC",
  "NSWSC",
  "NSWCA",
  "NSWCCA",
  "VSC",
  "VSCA",
  "QSC",
  "QCA",
  "WASC",
  "SASC",
  "NZSC",
  "NZCA",
  "NZHC",
  "SGCA",
  "SGHC",
  "HKCFA",
  "HKCA",
  "HKCFI",
];

const LAW_REPORTS = [
  "WLR",
  "AC",
  "QB",
  "KB",
  "Ch",
  "Fam",
  "All ER",
  "Lloyd's Rep",
  "Cr App R",
  "BCLC",
  "ICR",
  "IRLR",
  "FSR",
  "RPC",
  "SLT",
  "NZLR",
];

const escaped = (text: string) =>
  text
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\. /g, "\\.\\s*")
    .replace(/ /g, "\\s+")
    .replace(/'/g, "['’]");

const alternatives = (names: readonly string[]) =>
  [...names]
    .sort((a, b) => b.length - a.length)
    .map(escaped)
    .join("|");

const INTRODUCERS = [
  "See",
  "Also",
  "But",
  "Cf",
  "Compare",
  "Accord",
  "Contra",
  "Under",
  "In",
  "Per",
  "As",
  "By",
  "From",
  "Following",
  "Citing",
  "And",
  "With",
  "Since",
  "Because",
  "While",
  "Although",
  "Thus",
  "So",
  "Then",
  "Yet",
  "After",
  "Before",
  "Despite",
  "Unlike",
  "Like",
].join("|");

const ABBREVIATIONS = [
  "Inc",
  "Ltd",
  "Co",
  "Cos",
  "Corp",
  "Bros",
  "Jr",
  "Sr",
  "Dr",
  "St",
  "No",
  "Mt",
  "Ass'n",
  "Dep't",
  "Dept",
  "Bd",
  "Cty",
  "Univ",
  "Mfg",
  "Int'l",
  "Nat'l",
  "Comm'r",
  "Auth",
  "Assocs",
  "Mgmt",
  "Ins",
  "Hosp",
].map(escaped);

// A period ends a party's word only in initials or an abbreviation, and an abbreviation only before a lowercase word, a comma or another abbreviation: "…in the U.S. Brown v. Board" and "Acme Co. Smith v. Jones" end a sentence at the abbreviation.
const ABBREVIATED = ABBREVIATIONS.join("|");
const ABBREVIATION_ENDS = String.raw`(?=\s+[a-z]|\s+(?:${ABBREVIATED})\.|\s*[,;:)]|\s*$)`;
const NAME_LEADING = String.raw`(?:St|Mt|Ft|Dr|Mr|Mrs|Ms)\.(?=\s+[A-Z])`;
const CAMEL_CASE = String.raw`[a-z]+[A-Z][\p{L}\p{N}'’&-]*`;
const WORD = String.raw`(?:${NAME_LEADING}|[A-Z]\.|(?:(?:[A-Z]\.){2,4}|(?:${ABBREVIATED})\.)${ABBREVIATION_ENDS}|${CAMEL_CASE}|(?!(?:${INTRODUCERS})\b)[A-Z][\p{L}\p{N}'’&-]*)`;
const COMPANY_SUFFIX = String.raw`(?:,\s+(?:Inc|Ltd|LLC|L\.L\.C|LLP|L\.L\.P|Co|Corp|PC|P\.C|Jr|Sr)\.?)?`;
const PARTY = `${WORD}(?:\\s+(?:${WORD}|of|the|and|for|ex|rel\\.|de|la|&)){0,6}${COMPANY_SUFFIX}`;
const INTRODUCED = `(?<![\\p{L}\\p{N}.])(?:(?:${INTRODUCERS})\\.?,?\\s+)*`;
const NAME = `${PARTY}\\s+v\\.?\\s+${PARTY}`;
const ARTICLES = /^(?:(?:the|a|an)\s+)+/i;

const US_CITE = String.raw`\d{1,4}\s+(?:${alternatives(REPORTERS)})\s+\d{1,5}`;
const NEUTRAL_CITE = String.raw`\[(?:1[89]|20)\d{2}\]\s+(?:${alternatives(NEUTRAL_COURTS)})\s+\d{1,5}(?:\s*\([A-Za-z]{1,8}\))?`;
const REPORT_CITE = String.raw`\[(?:1[89]|20)\d{2}\]\s+(?:\d{1,2}\s+)?(?:${alternatives(LAW_REPORTS)})\s+\d{1,5}`;

const AMERICAN = new RegExp(`${INTRODUCED}(${NAME}),?\\s+(${US_CITE})(?![\\p{L}\\p{N}])`, "gu");
const COMMONWEALTH = new RegExp(`${NEUTRAL_CITE}|${REPORT_CITE}`, "gu");
const NAME_BEFORE = new RegExp(`${INTRODUCED}(${NAME}),?\\s*$`, "u");

const spaced = (text: string) => text.replace(/\s+/g, " ").trim();
const bare = (name: string) => spaced(name).replace(ARTICLES, "");

const MAY_CITE = /\sv\.?\s|\[(?:1[89]|20)\d{2}\]/u;
const TRAILER = /^((?:,\s*\d{1,5}(?:[-–]\d{1,5})?)*)(\s*\([^()]{0,40}\d{4}\))?/u;

export function citedCases(text: string): CitedCase[] {
  if (!MAY_CITE.test(text)) return [];
  const found: CitedCase[] = [];
  const add = (name: string | null, cite: string, from: number, citeEnd: number) => {
    const trailer = TRAILER.exec(text.slice(citeEnd));
    const to = citeEnd + (trailer?.[0].length ?? 0);
    found.push({ name, cite: spaced(cite), from, citeTo: trailer?.[2] ? to : citeEnd, to });
  };
  for (const match of text.matchAll(AMERICAN)) {
    const [whole, name, cite] = match;
    if (name !== undefined && cite !== undefined) {
      add(bare(name), cite, match.index, match.index + whole.length);
    }
  }
  for (const match of text.matchAll(COMMONWEALTH)) {
    const before = NAME_BEFORE.exec(text.slice(0, match.index));
    const name = before?.[1];
    add(
      name === undefined ? null : bare(name),
      match[0],
      before ? before.index : match.index,
      match.index + match[0].length,
    );
  }
  return found.sort((a, b) => a.from - b.from);
}

export const caseCitations = (sentence: string): CaseCitation[] =>
  citedCases(sentence).map(({ name, cite }) => ({ name, cite }));

const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const START_LENGTH = 1500;
const MAX_CAPTION_LINES = 8;

const BESIDE = String.raw`(?:\S*\d\S*|no|nos|cite|as|inc|co|corp|ltd|llc|llp|lp|plc|et|al|company|incorporated|corporation|limited|petitioners?|respondents?|appell(?:ant|ee)s?|plaintiffs?|defendants?)`;

const EXTENSION = /\.(?:pdf|docx?|txt|md|html?|rtf|pptx?|xlsx?|csv)$/iu;

const lineWords = (line: string) => plain(line.replace(/\([^)]*\)/gu, " "));

function standsAlone(lines: readonly string[], decision: CaseCitation): boolean {
  const [first, second] = decision.name?.split(/\s+v\.?\s+/).map(plain) ?? [];
  const cite = plain(decision.cite);
  const beside = `(?:${BESIDE}|${cite.split(" ").join("|")})`;
  const alone = [
    new RegExp(`^(?:cite as )?${cite}(?: ${beside})*$`, "u"),
    ...(first && second
      ? [new RegExp(`^${first}(?: \\S+){0,4} vs? (?:\\S+ ){0,3}${second}(?: ${beside})*$`, "u")]
      : []),
  ];
  return lines.some((_, from) =>
    Array.from({ length: Math.min(MAX_CAPTION_LINES, lines.length - from) }, (_, count) =>
      lines.slice(from, from + count + 1).join(" "),
    ).some((window) => alone.some((each) => each.test(window))),
  );
}

/**
 * Whether a Document is the opinion of a court decision: its caption (the parties joined by
 * "v.") or its citation stands on a line of its own, with at most the citation, a docket or a
 * year beside it, at the start of its first Passage, or is its whole name. A Document that cites
 * the case in a sentence, names both parties, or is a memo or an alert about it isn't.
 */
export function isOpinionOf(
  document: { name: string; start: string },
  decision: CaseCitation,
): boolean {
  const lines = document.start
    .slice(0, START_LENGTH)
    .split(/\r?\n/u)
    .map(lineWords)
    .filter((line) => line !== "");
  return (
    standsAlone([lineWords(document.name.replace(EXTENSION, ""))], decision) ||
    standsAlone(lines, decision)
  );
}
