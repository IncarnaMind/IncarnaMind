import { type ReactNode, useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { useLanguage, useT } from "../i18n";
import { ClaimMarkIcon, type ClaimMarkState } from "./icons";
import { QuoteLink } from "./QuoteLink";
import type { QuoteRole } from "./quoteGroups";

const useFolded = create<{ folded: boolean }>(() => ({ folded: false }));

/** Whether the User folded the cards' quotes to one line: it holds for every card until they open them. */
export const useQuotesFolded = (): boolean => useFolded((state) => state.folded);
export const setQuotesFolded = (folded: boolean): void => useFolded.setState({ folded });

const LABEL = { otherwise: "claim.group.otherwise", so: "claim.group.so" } as const;

/** A press that folds or shows the quotes from the focused control: the one in its place takes the focus. */
let focusPassing = false;
const passFocus = (from: Element | null) => {
  focusPassing = from?.contains(document.activeElement) === true;
};
const takeFocus = (element: HTMLElement | null | undefined) => {
  if (!focusPassing || !element) return;
  focusPassing = false;
  element.focus();
};

function GroupIcon({ role, mark }: { role: QuoteRole; mark: ClaimMarkState }) {
  return (
    <ClaimMarkIcon
      state={role === "so" ? "supported" : mark}
      className="claim-group-icon"
      aria-hidden="true"
    />
  );
}

/**
 * One group: its label, which folds every group to one line, and its quotes. A group whose role
 * the check didn't say has no label, as a ✓ card's quote has none.
 */
export function QuoteGroupView({
  role,
  count,
  mark,
  onFold,
  children,
}: {
  role: QuoteRole | null;
  count: number;
  mark: ClaimMarkState;
  onFold(): void;
  children: ReactNode;
}) {
  const t = useT();
  const language = useLanguage();
  const label = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => takeFocus(label.current), []);
  return (
    <section
      className={`claim-group ${role === "so" ? "citation-card--found" : ""}`}
      data-testid="claim-group"
      data-role={role ?? undefined}
    >
      {role && (
        <button
          ref={label}
          type="button"
          className="claim-group-label"
          data-testid="claim-group-label"
          aria-expanded={true}
          title={t("claim.quotes.fold")}
          onClick={(event) => {
            passFocus(event.currentTarget);
            onFold();
          }}
        >
          <GroupIcon role={role} mark={mark} />
          {t(LABEL[role])}
          {count > 1 && (
            <span className="claim-group-count">
              {`· ${new Intl.NumberFormat(language).format(count)}`}
            </span>
          )}
        </button>
      )}
      {children}
    </section>
  );
}

/** The groups folded to one line: what each does and how many, and Show quotes. */
export function FoldedQuotes({
  groups,
  mark,
  onShow,
}: {
  groups: readonly { role: QuoteRole; count: number }[];
  mark: ClaimMarkState;
  onShow(): void;
}) {
  const t = useT();
  const language = useLanguage();
  const line = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => takeFocus(line.current?.querySelector("button")), []);
  return (
    <p ref={line} className="claim-quotes-folded" data-testid="claim-quotes-folded">
      {groups.map(({ role, count }) => (
        <span
          key={role}
          className={`claim-folded-group ${role === "so" ? "citation-card--found" : ""}`}
          data-role={role}
        >
          <GroupIcon role={role} mark={mark} />
          {t(LABEL[role])}
          <span className="claim-group-count">
            {`· ${new Intl.NumberFormat(language).format(count)}`}
          </span>
        </span>
      ))}
      <QuoteLink
        testId="claim-show-quotes"
        expanded={false}
        onClick={() => {
          passFocus(line.current);
          onShow();
        }}
      >
        {t("claim.quotes.show")}
      </QuoteLink>
    </p>
  );
}
