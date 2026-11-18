import { type ReactNode, useEffect, useRef } from "react";
import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import { CheckLineIcon, ChevronLeftLineIcon, CloseLineIcon } from "../lineIcons";
import { OnThisComputer } from "../OnThisComputer";

export type SetupStep = "work" | "ai" | "sorting" | "meetings";

const STEP_NAMES: Record<SetupStep, MessageKey> = {
  work: "setupPage.progress.work",
  ai: "setupPage.progress.ai",
  sorting: "setupPage.progress.sorting",
  meetings: "setupPage.progress.meetings",
};

/** Where a step is in the setup, and how it moves on. */
export interface StepPlace {
  steps: readonly SetupStep[];
  at: number;
  next(): void;
  /** Absent on the first step shown. */
  back?(): void;
  /** Where the steps show in a dialog: what its ✕ does. */
  close?(): void;
}

/**
 * One step of the first run's setup (#3296): the progress line and the title at the panel's top,
 * where they stay from step to step, the step's choices under them, and its foot. `view` names
 * what the panel shows; when it changes, the focus goes to its first choice or field.
 */
export function SetupPanel({
  place,
  view,
  title,
  lead,
  crumb,
  foot,
  children,
}: {
  place: StepPlace;
  view: string;
  title: string;
  lead?: string;
  crumb?: { label: string; onClick(): void };
  foot: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new step or view takes the focus once.
  useEffect(() => {
    const within = body.current;
    if (!within) return;
    const chosen = within.querySelector<HTMLElement>("input:checked");
    // Else a form that put the focus on its own safe choice keeps it.
    if (!chosen && within.contains(document.activeElement)) return;
    const first =
      chosen ??
      within.querySelector<HTMLElement>("input:not([type=hidden]), select") ??
      within.querySelector<HTMLElement>("button:not([data-testid=setup-crumb])");
    first?.focus({ preventScroll: true });
  }, [view]);
  return (
    <section
      data-testid="setup-panel"
      data-step={place.steps[place.at]}
      aria-labelledby="setup-title"
      className={`relative flex min-h-[548px] w-full max-w-[640px] flex-col bg-sheet ${
        place.close ? "" : "rounded-[12px] shadow-[0_0_0_1px_var(--color-rule)]"
      }`}
    >
      <div className={`flex px-6 pt-5 ${place.close ? "pr-14" : ""}`}>
        <ol
          aria-label={t("setupPage.progress", { step: place.at + 1, count: place.steps.length })}
          className="grid flex-1 gap-1.5"
          style={{ gridTemplateColumns: `repeat(${place.steps.length}, minmax(0, 1fr))` }}
        >
          {place.steps.map((step, index) => (
            <li
              key={step}
              data-testid="setup-progress-step"
              aria-current={index === place.at ? "step" : undefined}
              className={`flex min-w-0 flex-col gap-[7px] text-[12px] leading-4 ${
                index === place.at ? "font-semibold text-ink" : "text-ink-meta"
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-[3px] rounded-full ${index <= place.at ? "bg-ink" : "bg-rule-strong"}`}
              />
              <span className="truncate">{t(STEP_NAMES[step])}</span>
            </li>
          ))}
        </ol>
      </div>
      <div ref={body} className="flex flex-1 flex-col gap-4 px-6 pt-5 pb-1">
        {crumb && (
          <button
            type="button"
            data-testid="setup-crumb"
            onClick={crumb.onClick}
            className="-ml-1 inline-flex items-center gap-1 self-start rounded-md py-0.5 pr-1.5 pl-0.5 text-[13px] leading-5 font-semibold text-ink-secondary hover:bg-hover hover:text-ink"
          >
            <ChevronLeftLineIcon aria-hidden="true" className="size-4" />
            {crumb.label}
          </button>
        )}
        <div className="flex flex-col gap-1">
          <h1 id="setup-title" className="text-[20px] leading-7 font-semibold text-ink">
            {title}
          </h1>
          {lead && <p className="text-ui text-ink-secondary">{lead}</p>}
        </div>
        {children}
      </div>
      {foot && (
        <div
          data-testid="setup-foot"
          className="flex flex-wrap items-center gap-2 px-6 pt-3.5 pb-5"
        >
          {foot}
        </div>
      )}
      {/* Last, so the step's own first choice takes the focus as the dialog opens. */}
      {place.close && (
        <button
          type="button"
          data-testid="setup-close"
          aria-label={t("setupPage.close")}
          title={t("setupPage.close")}
          onClick={place.close}
          className="absolute top-3.5 right-4 inline-flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-chip hover:text-ink focus-visible:outline-offset-0"
        >
          <CloseLineIcon className="size-4" />
        </button>
      )}
    </section>
  );
}

/** One choice of a step: a box to tick (several allowed) or a round one (one of them). */
export function SetupChoice({
  type,
  name,
  checked,
  title,
  line,
  testId,
  value,
  onChange,
}: {
  type: "checkbox" | "radio";
  name: string;
  checked: boolean;
  title: string;
  line?: string;
  testId: string;
  value: string;
  onChange(): void;
}) {
  return (
    <label
      data-testid={testId}
      data-value={value}
      className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-[11px] shadow-[inset_0_0_0_1px_var(--color-rule-strong)] hover:bg-hover has-[input:checked]:shadow-[inset_0_0_0_2px_var(--color-ink)]"
    >
      <input
        type={type}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 shrink-0 accent-ink"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-ui font-semibold text-ink">{title}</span>
        {line && <span className="text-[13px] leading-5 text-ink-secondary">{line}</span>}
      </span>
    </label>
  );
}

/** Under every key field of the setup: where keys are kept. */
export function KeysStay() {
  const t = useT();
  return (
    <p data-testid="setup-keys-stay" className="mt-1 text-[12px] leading-[18px]">
      <OnThisComputer>{t("setupPage.keysStay")}</OnThisComputer>
    </p>
  );
}

/** What a step has set up and works, with what changes it beside. */
export function WorksRow({
  text,
  testId,
  children,
}: {
  text: string;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-chip py-2 pr-2 pl-3 text-[13px] leading-5"
    >
      <span className="mr-auto inline-flex min-w-0 items-center gap-2 font-semibold text-ink">
        <CheckLineIcon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
      </span>
      {children}
    </div>
  );
}
