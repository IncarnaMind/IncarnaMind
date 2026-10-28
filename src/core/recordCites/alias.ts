const WORD_ALIASES: Record<string, string> = {
  amended: "am",
  declaration: "decl",
  defendant: "def",
  deposition: "dep",
  docket: "dkt",
  exhibit: "ex",
  complaint: "compl",
  plaintiff: "pl",
  transcript: "tr",
};

export const recordCiteAlias = (value: string) =>
  value
    .trim()
    .replace(/\.[a-z0-9]{1,10}$/i, "")
    .replace(/[.’]/g, (mark) => (mark === "’" ? "'" : ""))
    .replace(/\b(?:ecf|dkt)(?:\s+no)?\b/gi, "dkt")
    .replace(
      /\b(amended|declaration|defendant|deposition|docket|exhibit|complaint|plaintiff|transcript)\b/gi,
      (word) => WORD_ALIASES[word.toLocaleLowerCase()] ?? word,
    )
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();

export const recordCiteAliasMatches = (documentName: string, alias: string) => {
  const name = recordCiteAlias(documentName);
  const wanted = recordCiteAlias(alias);
  return name === wanted || name.startsWith(`${wanted} `);
};
