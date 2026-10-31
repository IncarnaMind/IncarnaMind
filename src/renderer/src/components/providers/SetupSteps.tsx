import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptionRoute } from "../../../../core/api";
import { useT } from "../../i18n";
import { finishSetupStep, openSetupStep, useModelSetup } from "../../modelSetup";
import { useAppStore } from "../../store";
import { useTranscriptionServicesRead } from "../../transcriptionServices";
import { ROUTE_LABELS, TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { ReadProblem } from "../ReadProblem";
import { STEP_BUTTON_CLASS, StepNumber } from "../StepNumber";
import { buttonStyle, fieldClass, hintClass } from "../ui";
import { SortingLine, SortingSelect, useSorting } from "./SortingChoice";

const linkClass =
  "text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline";

/**
 * Once a model works (#1922), steps 2 and 3 open one at a time above the composer, which works on
 * below them (#2310): meeting transcription, best left on this computer, and what sorts Documents
 * and names meeting hints. Each is one click, skippable, and its choice is the consent for its
 * flow (ADR-0022). Only the step in hand shows its details; the other is its title, so a step the
 * User finished folds to its choice and opens again (#2147).
 */
export function SetupSteps() {
  const t = useT();
  const step = useModelSetup((state) => state.step);
  const done = useModelSetup((state) => state.done);
  if (step === null) return null;
  return (
    <SetupCard>
      <ol className="flex flex-col gap-3">
        <Step
          number={2}
          title={t("setup.step.transcription")}
          testId="transcription"
          open={step === "transcription"}
          choice={done.transcription}
          onOpen={() => openSetupStep("transcription")}
        >
          <TranscriptionStep onDone={(choice) => finishSetupStep("transcription", choice)} />
        </Step>
        <Step
          number={3}
          title={t("setup.step.sorting")}
          testId="sorting"
          open={step === "sorting"}
          choice={done.sorting}
          onOpen={() => openSetupStep("sorting")}
        >
          <SortingStep onDone={(choice) => finishSetupStep("sorting", choice)} />
        </Step>
      </ol>
    </SetupCard>
  );
}

/**
 * The steps left, above the composer (#2310): the line above says how many and offers the skip,
 * so the card is only the step in hand, with no title or foot of its own to keep from it in a
 * short window.
 */
export function SetupCard({ children }: { children: ReactNode }) {
  return (
    <section
      data-testid="model-setup"
      className="setup-card flex min-h-0 max-h-[85vh] flex-col gap-2.5 overflow-y-auto px-4"
    >
      {children}
    </section>
  );
}

function Step({
  number,
  title,
  testId,
  open,
  choice,
  onOpen,
  children,
}: {
  number: number;
  title: string;
  testId: string;
  open: boolean;
  /** What was chosen, once the step is done. */
  choice: string | null;
  onOpen(): void;
  children: ReactNode;
}) {
  const t = useT();
  const item = useRef<HTMLLIElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(open);
  // In a short card the step opens at the card's top at once, not later when its list arrives
  // and the focus follows. The button that opened it is gone, so its heading holds the focus
  // until the step's own field can take it.
  useLayoutEffect(() => {
    const card = item.current?.closest("section");
    if (open && !wasOpen.current && item.current && card) {
      card.scrollTop += item.current.getBoundingClientRect().top - card.getBoundingClientRect().top;
      heading.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  const done = choice !== null;
  const mark = <StepNumber number={number} state={done ? "done" : open ? "open" : "later"} />;
  return (
    <li
      ref={item}
      data-testid={`setup-step-${testId}`}
      data-done={done || undefined}
      data-open={open || undefined}
      className="flex flex-col gap-2"
    >
      <h3
        ref={heading}
        tabIndex={-1}
        className="flex items-center text-[14px] leading-5 outline-none"
      >
        {open ? (
          <span className="flex items-center gap-2.5 font-semibold text-ink">
            {mark}
            {title}
            {done && <span className="sr-only">{t("gettingStarted.done")}</span>}
          </span>
        ) : (
          <button
            type="button"
            data-testid={`setup-step-${testId}-open`}
            onClick={onOpen}
            className={STEP_BUTTON_CLASS}
          >
            <span className="mt-px flex">{mark}</span>
            {done && <span className="sr-only">{t("gettingStarted.done")}</span>}
            {/* Where one line can't hold both, the choice goes under the title, aligned with its text. */}
            <span className="min-w-0 text-ink-meta group-hover:text-ink">
              <span data-testid={`setup-step-${testId}-title`} className="inline-block max-w-full">
                {title}
                {done && "\u00a0·"}
              </span>
              {done && (
                <>
                  {" "}
                  <span
                    data-testid={`setup-step-${testId}-choice`}
                    className="inline-block max-w-full text-ink-secondary [overflow-wrap:anywhere] group-hover:text-ink"
                  >
                    {choice}
                  </span>
                </>
              )}
            </span>
          </button>
        )}
      </h3>
      {open && <div className="flex flex-col gap-2 pl-7">{children}</div>}
    </li>
  );
}

/**
 * Where a Meeting's audio is transcribed (#141): this computer, free and private, unless a key
 * already serves a cloud service. Choosing one there is the consent to send it the audio.
 */
function TranscriptionStep({ onDone }: { onDone(choice: string): void }) {
  const t = useT();
  const id = useId();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const saved = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? null;
  const updateSettings = useAppStore((state) => state.updateSettings);
  const openSettings = useAppStore((state) => state.openSettings);
  // Opened again, the step reads the list again: a key may have come or gone. A read that
  // fails is said in place, and the step draws no rows from the list it had.
  const read = useTranscriptionServicesRead();
  const services = read.state === "ready" ? read.data : [];
  const cloudy = services.filter((service) => service.hasKey);
  const [picked, setPicked] = useState<TranscriptionRoute | null>(null);
  const route = localOnly ? "local" : (picked ?? saved ?? "local");
  const service = services.find((each) => each.route === route);
  // The saved route says where the audio goes, whether or not the list has named its service.
  const cloud = route === "local" ? null : t(ROUTE_LABELS[route]);
  const use = async () => {
    await updateSettings({ device: { transcriptionRoute: route } });
    onDone(t(ROUTE_LABELS[route]));
  };
  if (read.state === "failed") {
    return (
      <>
        <ReadProblem
          words={t("setup.services.failed")}
          read={read}
          testId="setup-transcription-problem"
        />
        <button
          type="button"
          data-testid="setup-transcription-later"
          onClick={() => onDone(t("setup.step.laterRecord"))}
          className={linkClass}
        >
          {t("setup.step.laterRecord")}
        </button>
      </>
    );
  }
  return (
    <>
      <TranscriptionRouteSelect
        id={`${id}-route`}
        // Its focus leaves the step's title in view in the short card, not just the field (#1922).
        className={`${fieldClass} scroll-mt-12`}
        localOnly={localOnly}
        saveOnChange={false}
        read={read}
        focusOnShow
        testId="setup-transcription"
        onChosen={setPicked}
      />
      <p data-testid="setup-transcription-line" className={hintClass}>
        {cloud
          ? t("meetings.route.cloudLine", { service: cloud })
          : t("setup.step.transcription.line")}
      </p>
      {/* Before a cloud route is chosen, what choosing one sends (ADR-0022). */}
      {!localOnly && <TranscriptionRouteConsent read={read} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          data-testid="setup-transcription-use"
          disabled={cloud !== null && !service}
          onClick={() => void use()}
          className={buttonStyle("primary", "sm")}
        >
          {t("setup.step.useThis")}
        </button>
        <button
          type="button"
          data-testid="setup-transcription-later"
          onClick={() => onDone(t("setup.step.laterRecord"))}
          className={linkClass}
        >
          {t("setup.step.laterRecord")}
        </button>
        {!localOnly && cloudy.length === 0 && (
          <button
            type="button"
            data-testid="setup-transcription-add-key"
            onClick={() => openSettings("meetings")}
            className={linkClass}
          >
            {t("setup.step.addKey")}
          </button>
        )}
      </div>
    </>
  );
}

/** What sorts Tags and Folders and names meeting hints, the best the keys reach picked first. */
function SortingStep({ onDone }: { onDone(choice: string): void }) {
  const t = useT();
  const { options, current, choose, known, loading, read } = useSorting();
  const [picked, setPicked] = useState<SortingOptionLike | null>(null);
  const chosen = picked ?? current;
  const use = async () => {
    if (chosen && !(await choose(chosen, { turnOn: true }))) return;
    onDone(chosen?.label ?? t("setup.step.skipped"));
  };
  if (read.state === "failed") {
    return (
      <>
        <ReadProblem words={t("setup.sorting.failed")} read={read} testId="setup-sorting-problem" />
        <button
          type="button"
          data-testid="setup-sorting-skip"
          onClick={() => onDone(t("setup.step.skipped"))}
          className={linkClass}
        >
          {t("setup.step.skip")}
        </button>
      </>
    );
  }
  return (
    <>
      <SortingSelect
        id="setup-sorting"
        className={`${fieldClass} scroll-mt-12`}
        autoFocus
        options={options}
        current={chosen}
        onChange={setPicked}
      />
      <SortingLine option={chosen} holds={known} reading={loading && chosen === null} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          data-testid="setup-sorting-use"
          disabled={chosen === null || chosen.unresolved === true}
          onClick={() => void use()}
          className={buttonStyle("primary", "sm")}
        >
          {t("setup.step.useThis")}
        </button>
        <button
          type="button"
          data-testid="setup-sorting-skip"
          onClick={() => onDone(t("setup.step.skipped"))}
          className={linkClass}
        >
          {t("setup.step.skip")}
        </button>
      </div>
    </>
  );
}

type SortingOptionLike = ReturnType<typeof useSorting>["options"][number];
