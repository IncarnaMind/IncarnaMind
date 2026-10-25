/**
 * Whether two Mind titles are close enough to be taken for each other (#1865), compared with each
 * other only, never with what the User wrote. Close: the same once case, width and spacing are
 * made alike ("Q3 plan" in two Folders); the same but for a part in brackets, or a number at the
 * start or the end, of either ("Q3 plan (draft)", "项目计划（草稿）", "Budget 2024" and
 * "Budget 2025", "2024年预算" and "2025年预算"); or one is
 * the other with a part after a dash or a colon ("Q3 plan – old"). Not close: "Q3 plan" and
 * "Q4 plan", "Harbour plan" and "Harbour budget", "Call: Acme" and "Call: Beta".
 */
export function closeTitles(a: string, b: string): boolean {
  const x = normalized(a);
  const y = normalized(b);
  if (x === "" || y === "") return false;
  if (x === y) return true;
  const core = withoutEnding(x);
  if (core !== "" && core === withoutEnding(y)) return true;
  return withoutSeparatedPart(x) === y || withoutSeparatedPart(y) === x;
}

const normalized = (title: string): string =>
  title.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

const BRACKETED = /\s*[([{【《〈][^()[\]{}【】《》〈〉]*[)\]}】》〉]$/u;
const LAST_NUMBER = /\s*\d+$/u;
const FIRST_NUMBER = /^\d+\s*/u;

const withoutEnding = (title: string): string =>
  title.replace(BRACKETED, "").replace(LAST_NUMBER, "").replace(FIRST_NUMBER, "").trim();

const SEPARATOR = /\s+[-–—|·]\s+|\s*[:：]\s*/gu;

/** The title before its last dash or colon; the title itself when it has none past its start. */
function withoutSeparatedPart(title: string): string {
  let cut = -1;
  for (const match of title.matchAll(SEPARATOR)) cut = match.index;
  return cut > 0 ? title.slice(0, cut).trim() : title;
}
