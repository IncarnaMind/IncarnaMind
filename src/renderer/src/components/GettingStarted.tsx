import { Fragment, type ReactNode } from "react";
import type { ExampleGroup } from "../../../core/api";
import { shortcutLabel } from "../commands/keymap";
import { CheckMarkIcon } from "../editor/icons";
import { useGap, useT } from "../i18n";
import { useLaterPromptsAllowed } from "../laterPrompts";
import { closeTip, useFeatureTip } from "../tips";
import { allExamples, useAppStore } from "../store";
import { useAddYourDocuments } from "./AddYourDocuments";
import { AskIcon, PlugIcon } from "./icons";
import { SLOT, Slotted } from "./Slotted";
import { Tip } from "./Tip";
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

/** A step of the three, numbered: filled while it is the one to do, a green tick once done. */
function GuideStep({
  number,
  state,
  title,
  children,
}: {
  number: number;
  state: "next" | "later" | "done";
  title: string;
  children: ReactNode;
}) {
  return (
    <li data-testid="start-step" className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3">
      <span
        aria-hidden="true"
        className={`flex size-6 items-center justify-center rounded-full text-[12px] font-bold ${
          state === "next"
            ? "bg-ink text-white"
            : state === "done"
              ? "bg-success text-white"
              : "border-[1.5px] border-tab-divider text-ink-meta"
        }`}
      >
        {state === "done" ? <CheckMarkIcon check="found" className="size-3" /> : number}
      </span>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-[16px] leading-6 font-semibold text-ink">{title}</h3>
        {children}
      </div>
    </li>
  );
}

/**
 * Under an empty Mind's first line, while the checklist is shown: the three
 * steps, add Documents or connect apps, ask, and check where each claim comes
 * from, and the example Mind to see it first. Typing in the Mind puts it away.
 */
export function StartGuide({ mindId }: { mindId: string }) {
  const t = useT();
  const later = useLaterPromptsAllowed();
  const connect = useFeatureTip("connect-app", mindId, later);
  const gap = useGap();
  const progress = useAppStore((state) => state.settings?.device.gettingStarted);
  const examplesAvailable = useAppStore((state) => state.examples?.available === true);
  const addLinkedFolder = useAppStore((state) => state.addLinkedFolder);
  const pickDocuments = useAppStore((state) => state.pickDocuments);
  const openSettings = useAppStore((state) => state.openSettings);
  const openExamples = useAppStore((state) => state.openExamples);
  if (!progress) return null;

  const done = [progress.indexed, progress.askedOwn, progress.citationChecked];
  const next = done.indexOf(false);
  const stateOf = (index: number): "next" | "later" | "done" =>
    done[index] ? "done" : index === next ? "next" : "later";

  return (
    <section
      aria-labelledby="start-guide-title"
      data-testid="start-guide"
      className="mt-10 flex flex-col gap-1 font-sans"
    >
      <h2 id="start-guide-title" className="mb-2 text-[13px] leading-5 font-semibold text-ink-meta">
        {t("startGuide.title")}
      </h2>
      <ol className="flex flex-col gap-5">
        <GuideStep number={1} state={stateOf(0)} title={t("startGuide.documents.title")}>
          <p className="-mt-2 text-ui text-ink-secondary">{t("startGuide.documents.body")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="start-link-folder"
              title={t("startGuide.documents.linkFolder.tip")}
              onClick={() => void addLinkedFolder()}
              className={buttonStyle("primary")}
            >
              {t("startGuide.documents.linkFolder")}
            </button>
            <button
              type="button"
              data-testid="start-add-files"
              onClick={() => void pickDocuments()}
              className={buttonStyle("secondary")}
            >
              {t("startGuide.documents.addFiles")}
            </button>
          </div>
          {connect && <Tip id="connect-app" onClose={() => closeTip("connect-app")}>
            {t("startGuide.documents.apps")}{" "}
            <button type="button" data-testid="start-connect-app" onClick={() => { closeTip("connect-app"); openSettings("connectors"); }} className="inline-flex items-center gap-1 rounded-sm font-semibold text-accent underline-offset-2 hover:underline">
              <PlugIcon className="size-3.5" />{t("startGuide.documents.connectApp")}
            </button>
          </Tip>}
        </GuideStep>

        <GuideStep number={2} state={stateOf(1)} title={t("startGuide.ask.title")}>
          <p className="-mt-2 text-ui text-ink-secondary">
            <Slotted
              message={t("startGuide.ask.body", { shortcut: SLOT })}
              slot={
                <kbd className="rounded-sm bg-chip px-[5px] py-px font-sans text-[12px] text-ink-strong">
                  {shortcutLabel("composer.focus")}
                </kbd>
              }
            />
          </p>
          <div
            aria-hidden="true"
            className="relative rounded-lg bg-frame py-2 pr-3 pl-11 text-[15px] leading-6 text-ink-placeholder"
          >
            <span className="absolute top-2 left-2.5 flex size-6 items-center justify-center rounded-md bg-tab-divider text-white">
              <AskIcon className="size-3" />
            </span>
            {t("startGuide.ask.example")}
          </div>
        </GuideStep>

        <GuideStep number={3} state={stateOf(2)} title={t("startGuide.check.title")}>
          <p className="-mt-2 text-ui text-ink-secondary">
            <Slotted
              message={t("startGuide.check.body", { mark: SLOT })}
              slot={
                <span
                  aria-hidden="true"
                  className="inline-flex h-[18px] items-center gap-0.5 rounded-sm bg-success-wash pr-[5px] pl-[3px] align-[1px] text-[11px] leading-[18px] font-bold text-success"
                >
                  <CheckMarkIcon check="found" className="size-[11px]" />1
                </span>
              }
            />
          </p>
        </GuideStep>
      </ol>
      {examplesAvailable && (
        <p className="mt-5 text-ui text-ink-meta">
          {t("startGuide.example.lead")}
          {gap(t("startGuide.example.lead"), t("startGuide.example.open"))}
          <button
            type="button"
            data-testid="start-open-example"
            onClick={() => void openExamples()}
            className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-offset-0"
          >
            {t("startGuide.example.open")}
          </button>
        </p>
      )}
    </section>
  );
}

/** Whether an Answer is the example one, written in advance: its meta line says so. */
export function useIsExampleAnswer(answerId: string | null) {
  return useAppStore(
    (state) => answerId !== null && allExamples(state).some((each) => each.answerId === answerId),
  );
}
