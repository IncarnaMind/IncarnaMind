/** The words of the answers a question of the User's own AI offers on its card (#3653). */
import type { NoteKept, NoteRule, NoteSuggested } from "../../../../core/api";
import type { useT } from "../../i18n";
import { visible } from "../../visibleText";

type Translate = ReturnType<typeof useT>;

/** What a rule covers, as Claude Code's own prompt names it after "don't ask again for". */
function ruleWords(t: Translate, rule: NoteRule): string {
  if (rule.kind === "commands") return t("ownAsk.what.commands", { start: visible(rule.start) });
  if (rule.kind === "command") return t("ownAsk.what.command", { value: visible(rule.value) });
  if (rule.kind === "site") return visible(rule.host);
  if (rule.kind === "tool") {
    return t("ownAsk.what.tool", { tool: visible(rule.tool), server: visible(rule.server) });
  }
  if (rule.kind === "searches") return t("ownAsk.what.searches");
  if (rule.kind === "files") {
    const folder = rule.folder === "" ? t("ownAsk.here.folder") : visible(rule.folder);
    return t(rule.change ? "ownAsk.what.changes" : "ownAsk.what.reads", { folder });
  }
  return visible(rule.rule);
}

/** One suggested answer in a few words, ending with where it is kept. */
function suggestedWords(t: Translate, language: string, suggested: NoteSuggested): string {
  const list = (parts: string[]) =>
    new Intl.ListFormat(language, { type: "conjunction" }).format(parts);
  if (suggested.kind === "rules") {
    return t(`ownAsk.lasting.rules.${suggested.kept}`, {
      what: list(suggested.rules.map((rule) => ruleWords(t, rule))),
    });
  }
  if (suggested.kind === "mode" && suggested.mode === "acceptEdits") {
    return t(`ownAsk.lasting.edits.${suggested.kept}`);
  }
  if (suggested.kind === "mode") {
    return t(`ownAsk.lasting.mode.${suggested.kept}`, { mode: visible(suggested.mode) });
  }
  if (suggested.kind === "folders") {
    return t(`ownAsk.lasting.folders.${suggested.kept}`, {
      what: list(
        suggested.folders.map((folder) =>
          folder === "" ? t("ownAsk.here.folder") : visible(folder),
        ),
      ),
    });
  }
  return t(`ownAsk.lasting.other.${suggested.kept}`, { text: visible(suggested.text) });
}

/** The order Claude Code's own "don't ask again" names what it applies: its rules first. */
const FIRST: Record<NoteSuggested["kind"], number> = { rules: 0, mode: 1, folders: 2, other: 3 };

const WIDTH: Record<NoteKept, number> = { request: 0, conversation: 1, everywhere: 2 };

/**
 * Claude Code's own "don't ask again", as the card says it: one thing it grants is the button's
 * words; several are a short button that says the widest place it keeps them, and every one of
 * them, each with where it is kept, in a line under it, never cut, since the User agrees to what
 * they read.
 */
export function lastingWords(
  t: Translate,
  language: string,
  suggested: readonly NoteSuggested[],
): { label: string; grants: string | null } {
  const ordered = [...suggested].sort((a, b) => FIRST[a.kind] - FIRST[b.kind]);
  const [only] = ordered;
  if (!only) return { label: "", grants: null };
  if (ordered.length === 1) return { label: suggestedWords(t, language, only), grants: null };
  const widest = ordered.reduce(
    (kept, each) => (WIDTH[each.kept] > WIDTH[kept] ? each.kept : kept),
    only.kept,
  );
  return {
    label: t(`ownAsk.lasting.short.${widest}`),
    grants: ordered
      .map((each, index) => {
        const said = suggestedWords(t, language, each);
        return index === 0 ? said : `${said.charAt(0).toLocaleLowerCase(language)}${said.slice(1)}`;
      })
      .join(t("ownAsk.lasting.then")),
  };
}
