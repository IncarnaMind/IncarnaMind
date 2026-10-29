const WORD_ALIASES: Record<string, string> = {
  amended: "am",
  declaration: "decl",
  defendant: "def",
  defendants: "def",
  defs: "def",
  deposition: "dep",
  docket: "dkt",
  exhibit: "ex",
  complaint: "compl",
  plaintiff: "pl",
  plaintiffs: "pl",
  pls: "pl",
  transcript: "tr",
};

/**
 * The one canonical form of a record source's name, for a cite's source and a Document's name
 * alike: "Def.'s Ex. 7" and "Defendants' Exhibit 7.pdf" are both "def ex 7", which keeps its
 * party and so never matches the bare "ex 7".
 */
export const recordCiteAlias = (value: string) =>
  value
    .trim()
    .replace(/\.[a-z0-9]{1,10}$/i, "")
    .replace(/[’‘]/g, "'")
    .replace(/\.(?=')/g, "")
    .replace(/(\p{L})'s?(?=\s|$)/gu, "$1")
    .replace(/\./g, "")
    .replace(/\b(?:ecf|dkt)(?:\s+no)?\b/gi, "dkt")
    .replace(
      /\b(amended|declaration|defendants?|defs|deposition|docket|exhibit|complaint|plaintiffs?|pls|transcript)\b/gi,
      (word) => WORD_ALIASES[word.toLocaleLowerCase()] ?? word,
    )
    .replace(/\bdep tr\b/gi, "dep")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

/** Whether a Document's name names the source a cite's alias names, word for word from its start. */
export const recordCiteAliasMatches = (documentName: string, alias: string) => {
  const name = recordCiteAlias(documentName);
  const wanted = recordCiteAlias(alias);
  return wanted !== "" && (name === wanted || name.startsWith(`${wanted} `));
};
