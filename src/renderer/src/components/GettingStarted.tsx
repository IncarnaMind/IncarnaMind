import { Fragment } from "react";
import type { ExampleGroup } from "../../../core/api";
import { useGap, useT } from "../i18n";
import { allExamples, useAppStore } from "../store";
import { useAddYourDocuments } from "./AddYourDocuments";
import { buttonStyle } from "./ui";

/** Whether a Mind is the example one. */
export const useIsExample = (mindId: string | undefined) =>
  useAppStore(
    (state) => mindId !== undefined && allExamples(state).some((each) => each.mindId === mindId),
  );

/** "Example", after the example Mind's name and its Linked folder's. */
export function ExampleChip() {
  const t = useT();
  return (
    <span
      data-testid="example-chip"
      className="h-[18px] shrink-0 rounded-sm bg-chip px-1.5 text-[11px] leading-[18px] font-semibold text-ink-secondary"
    >
      {t("examples.chip")}
    </span>
  );
}

/**
 * Above the example Mind's title: what a Mind is, and the ways on: adding
 * one's own Documents, in place (#766), or removing the examples.
 */
export function ExampleBanner({ mindId }: { mindId: string }) {
  const t = useT();
  const gap = useGap();
  const addMenu = useAddYourDocuments("example-add");
  const removeExamples = useAppStore((state) => state.removeExamples);
  const tea = useAppStore((state) => state.examples?.group === "tea");
  const body = t(tea ? "examples.banner.body.tea" : "examples.banner.body");
  return (
    <aside
      aria-label={t("examples.banner.label")}
      data-testid="example-banner"
      // Reaching 12px into the margins, so its text keeps the Mind's text edge.
      className="-mx-3 mb-6 flex items-start gap-2.5 rounded-lg bg-accent-wash p-3 font-sans text-ui text-ink-strong"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-accent-strong"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <path d="M12 8v.01" />
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p>
          <strong className="font-semibold text-ink">{t("examples.banner.title")}</strong>
          {gap(t("examples.banner.title"), body)}
          {body}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            {...addMenu.buttonProps}
            type="button"
            data-testid="example-add-own"
            className={buttonStyle("primary", "sm")}
          >
            {t("examples.banner.addOwn")}
          </button>
          {addMenu.menu}
          <button
            type="button"
            data-testid="example-remove"
            onClick={() => void removeExamples()}
            className={`${buttonStyle("ghost", "sm")} text-ink-strong`}
          >
            {t("examples.banner.remove")}
          </button>
        </div>
        <OtherExamples mindId={mindId} />
      </div>
    </aside>
  );
}

function OtherExamples({ mindId }: { mindId: string }) {
  const t = useT();
  const gap = useGap();
  const openExample = useAppStore((state) => state.openExample);
  const more = useAppStore(
    (state) => allExamples(state).find((each) => each.mindId === mindId)?.more,
  );
  if (!more || more.length === 0) return null;
  return (
    <p data-testid="example-more" className="pt-1.5 text-[13px] leading-5 text-ink-secondary">
      {t("examples.banner.more")}
      {gap(t("examples.banner.more"), t(`examples.group.${more[0] as ExampleGroup}`))}
      {more.map((group, index) => (
        <Fragment key={group}>
          {index > 0 && " · "}
          <button
            type="button"
            data-testid="example-more-link"
            data-group={group}
            onClick={() => void openExample(group)}
            className="rounded-sm text-accent-strong underline-offset-2 hover:underline focus-visible:outline-offset-0"
          >
            {t(`examples.group.${group}`)}
          </button>
        </Fragment>
      ))}
    </p>
  );
}

/** Whether an Answer is the example one, written in advance: its meta line says so. */
export function useIsExampleAnswer(answerId: string | null) {
  return useAppStore(
    (state) => answerId !== null && allExamples(state).some((each) => each.answerId === answerId),
  );
}
