import type { SentenceChecksExported } from "../../core/api";
import type { Translate } from "../../shared/locations";

const RESULTS = [
  ["contradicted", "contradicted"],
  ["notFound", "notFound"],
  ["unsupported", "unsupported"],
  ["recheck", "needsRecheck"],
] as const;

type Result = (typeof RESULTS)[number][0];

/** The results that have sentences as one list, "2 Contradicted and 1 Unsupported", with the last count. */
function listed(
  checks: SentenceChecksExported,
  part: (result: Result, count: number) => string,
  t: Translate,
): { text: string; last: number } | null {
  const found = RESULTS.flatMap(([result, field]) =>
    checks[field] > 0 ? [{ text: part(result, checks[field]), count: checks[field] }] : [],
  );
  const last = found.at(-1);
  if (!last) return null;
  const head = found
    .slice(0, -1)
    .map((each) => each.text)
    .join(t("export.parts.separator"));
  return {
    text: head ? `${head}${t("export.parts.last")}${last.text}` : last.text,
    last: last.count,
  };
}

/** How many comments on what needs a look a Word file holds, for the line after saving; null for none. */
export function checkComments(checks: SentenceChecksExported, t: Translate): string | null {
  if (!checks.commented || checks.comments === 0) return null;
  return checks.comments === 1
    ? t("export.checkComments.one")
    : t("export.checkComments", { count: checks.comments });
}

/** What went out with no comment, for the line's warning; null when every one is in a comment. */
export function unmarkedChecks(checks: SentenceChecksExported, t: Translate): string | null {
  if (checks.commented) return null;
  const list = listed(checks, (result, count) => t(`export.unmarked.${result}`, { count }), t);
  return (
    list &&
    t(list.last === 1 ? "export.unmarked.one" : "export.unmarked.other", { list: list.text })
  );
}

/** The changes waiting that went into a Word file as tracked changes; null when none did. */
export function trackedChanges(count: number, t: Translate): string | null {
  if (count === 0) return null;
  return count === 1 ? t("export.tracked.one") : t("export.tracked", { count });
}
