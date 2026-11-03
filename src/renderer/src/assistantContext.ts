import type { Translate } from "./objects";
import { DELETED_NAMES, type ScopeChip } from "./scope";

/**
 * What the next Question reads and searches, which an empty conversation
 * says once (#253, #258, #391, #544, #621). With a Mind: "Reads “Chapter 3” ·
 * searches “Thesis”", naming the first item of the composer's Search scope
 * (its Folder, by default); with none in focus: "Searches All Documents",
 * or the items the User chose in the composer.
 * Items deleted since are left out, as the search leaves them out.
 */
export function readsLine(
  t: Translate,
  mindName: string | null,
  scope: readonly ScopeChip[],
): string {
  const named = scope.filter((chip) => !chip.deleted && chip.name);
  const first = named[0]?.name;
  if (mindName === null) {
    if (!first) return t("assistant.searchesAll");
    if (named.length === 1) return t("assistant.searches.one", { scope: first });
    return t("assistant.searches.more", {
      scope: first,
      count: named.length - 1,
      total: named.length,
    });
  }
  if (!first) return t("assistant.reads.all", { mind: mindName });
  if (named.length === 1) return t("assistant.reads.one", { mind: mindName, scope: first });
  return t("assistant.reads.more", {
    mind: mindName,
    scope: first,
    count: named.length - 1,
    total: named.length,
  });
}

/**
 * What a Question in the assistant searched, in its Answer's steps (#391):
 * its Folder's or Tag's name, a Document's, "3 files" for Documents alone,
 * or All Documents; then "+N" for the rest of its scope and `extra` scopes
 * besides (a Connector's). A Folder deleted since is still named, it was
 * searched then; one gone without its name says "Deleted Folder", never left
 * out: an Answer that searched nothing doesn't read as having searched
 * everything. That is a placeholder, not a name, so it is not quoted.
 */
export function stepsScope(t: Translate, scope: readonly ScopeChip[], extra = 0): string {
  const first = scope.find((chip) => chip.kind !== "document") ?? scope[0];
  const files = first?.kind === "document" && scope.length > 1;
  const label = !first
    ? t("steps.scope.all")
    : files
      ? t("steps.scope.files", { count: scope.length })
      : first.name
        ? t("steps.scope.named", { name: first.name })
        : t(DELETED_NAMES[first.kind]);
  const more = (first && !files ? scope.length - 1 : 0) + extra;
  return more > 0 ? t("steps.scope.more", { scope: label, count: more, total: more + 1 }) : label;
}
