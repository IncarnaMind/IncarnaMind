import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CitationStyleId } from "../../../shared/citationStyles";
import {
  chooseCitationStyle,
  styleLabel,
  useCitationStylePicker,
  useStyleCatalogue,
} from "../citationStylePicker";
import {
  commonEntries,
  keepShown,
  type StyleEntry,
  type StyleMatches,
  searchStyles,
  styleEntries,
} from "../citationStyleSearch";
import { useGap, useLanguage, useT } from "../i18n";
import { formatCount } from "../linkedFolders";
import { useAppStore } from "../store";
import { type PickerOption, type PickerSection, SearchPicker } from "./SearchPicker";

/**
 * The citation style picker (#289, #910), mounted once in the window and opened through
 * `useCitationStylePicker`: a field to search every style the app ships, by its name, its short
 * name or its field, the common ones also by their names in either language ("国标", "Cite Them
 * Right"). Without a query: the Mind's style, ticked; Recently used; the common list. Searching:
 * styles, then journals, each with its form and, for a journal, the style it follows.
 */
export function CitationStylePickerHost() {
  const t = useT();
  const gap = useGap();
  const language = useLanguage();
  const open = useCitationStylePicker((state) => state.open);
  const close = useCitationStylePicker((state) => state.close);
  const catalogue = useStyleCatalogue((state) => state.catalogue);
  const recent = useAppStore((state) => state.settings?.user.recentCitationStyles);
  /** Where the picker opens when nothing was given to open beside: the top of the window. */
  const fallback = useRef<HTMLSpanElement>(null);
  const anchor = open ? (open.anchor?.isConnected ? open.anchor : fallback.current) : null;
  const current = open?.current?.style;

  useEffect(() => {
    if (open) useStyleCatalogue.getState().load();
  }, [open]);

  const entries = useMemo(() => styleEntries(language, catalogue), [language, catalogue]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  // Written while SearchPicker computes its options; safe, as the same query and styles always
  // give the same options, however often they are computed.
  const shown = useRef<{ query: string; found: StyleMatches } | null>(null);

  const sections = useCallback(
    (query: string): PickerSection<CitationStyleId>[] => {
      const optionOf = (entry: StyleEntry): PickerOption<CitationStyleId> => {
        const form = t(`citationStyle.form.${entry.format}`);
        return {
          id: entry.id,
          label: entry.title,
          detail: entry.follows
            ? `${form} · ${t("citationStyle.follows", { style: entry.follows })}`
            : form,
          data: { "data-style": entry.id },
        };
      };

      const last = shown.current;
      shown.current = null;
      if (query) {
        const now = searchStyles(entries, query);
        const found = last?.query === query ? keepShown(last.found, now) : now;
        shown.current = { query, found };
        const styles = { title: t("citationStyle.styles"), options: found.styles.map(optionOf) };
        const journals = {
          title: t("citationStyle.journals"),
          options: found.journals.map(optionOf),
        };
        return found.journalsFirst ? [journals, styles] : [styles, journals];
      }
      const mine = current === undefined ? undefined : byId.get(current);
      const own: PickerOption<CitationStyleId>[] = mine
        ? [optionOf(mine)]
        : current === undefined
          ? []
          : [{ id: current, label: styleLabel(current, t), data: { "data-style": current } }];
      const recently = (recent ?? []).flatMap((id) => {
        const entry = byId.get(id);
        return entry && id !== current ? [optionOf(entry)] : [];
      });
      return [
        { options: own },
        { title: t("citationStyle.recent"), options: recently },
        {
          title: t("citationStyle.common"),
          options: commonEntries(entries, language)
            .filter((entry) => entry.id !== current)
            .map(optionOf),
        },
      ];
    },
    [t, entries, byId, current, recent, language],
  );

  const placeholder = catalogue
    ? t("citationStyle.searchCount", { count: formatCount(catalogue.count, language) })
    : t("citationStyle.search");
  return (
    <>
      <span
        ref={fallback}
        aria-hidden="true"
        className="pointer-events-none fixed top-12 left-1/2 h-0 w-0"
      />
      <SearchPicker<CitationStyleId>
        anchor={anchor}
        title={t("citationStyle.title")}
        searchLabel={placeholder}
        noMatch={(query) => t("citationStyle.noMatch", { query })}
        options={sections}
        current={current}
        currentLabel={t("citationStyle.current")}
        onChoose={(style) => {
          if (open) void chooseCitationStyle(open.mindId, style, open.current);
        }}
        onClose={close}
        testId="citation-style"
        widthClass="w-[360px] max-w-[calc(100vw-16px)]"
        footer={
          <>
            {t("citationStyle.credit")}
            {gap(t("citationStyle.credit"), "citationstyles.org")}
            <a
              href="https://citationstyles.org/"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              citationstyles.org
            </a>
          </>
        }
      />
    </>
  );
}
