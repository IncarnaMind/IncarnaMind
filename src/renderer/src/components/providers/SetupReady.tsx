import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatProvider } from "../../../../core/api";
import { useAnswers } from "../../answers";
import { continueSetup } from "../../conversations";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { CheckLineIcon } from "../lineIcons";
import { ROUTE_LABELS, TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { ProblemLine } from "../ProblemLine";
import { UndoLineAt } from "../UndoLine";
import { buttonStyle } from "../ui";
import { CHATGPT_RECIPIENT } from "./ChatGptSignIn";
import { jobSelectClass, ROWS, RoleSelect, useJobSummary, useModelRoles } from "./ModelDefaults";
import { providerName } from "./ProviderPage";
import { SendsLine } from "./SendsLine";
import { SETUP_UNDO_PLACE } from "./shared";

function recipientOf(provider: ChatProvider, name: string): string | null {
  if (provider.kind === "ollama") return null;
  if (provider.kind === "chatgpt") return CHATGPT_RECIPIENT;
  if (provider.kind === "claude-account") return "Anthropic";
  if (provider.kind === "copilot") return "GitHub";
  return name;
}

/**
 * Once a key or sign-in works, the setup card says which model each job uses, with Change in
 * place, and waits for Continue, which is never held back. The Question that waited is asked then.
 */
export function SetupReady() {
  const t = useT();
  const language = useLanguage();
  const id = useId();
  const user = useAppStore((state) => state.settings?.user);
  const groups = useAnswers((state) => state.models) ?? [];
  const [providers, setProviders] = useState<ChatProvider[]>([]);
  const [listFailed, setListFailed] = useState(false);
  const roles = useModelRoles(groups);
  const next = useRef<HTMLButtonElement>(null);

  // A key or sign-in just worked, so the menus may not hold its models, and the card needs its name.
  const load = useCallback(() => {
    setListFailed(false);
    core.listChatModels().then(
      (models) => useAnswers.setState({ models }),
      (error: unknown) => {
        console.error("The setup card couldn't read the list of models.", error);
        setListFailed(true);
      },
    );
    core.listChatProviders().then(setProviders, (error: unknown) => {
      console.error("The saved chat providers couldn't be listed for the setup card.", error);
      setListFailed(true);
    });
  }, []);
  useEffect(() => {
    load();
    next.current?.focus({ preventScroll: true });
  }, [load]);

  const chosen = user?.chatModel;
  const provider = providers.find((each) => each.id === chosen?.providerId);
  const name = provider ? providerName(provider, t, language) : null;
  const recipient = provider && name ? recipientOf(provider, name) : null;
  // Only when the Answers model can't read a scan itself, which a model's own record says.
  const group = groups.find((each) => each.provider.id === chosen?.providerId);
  const readsImages = chosen ? group?.about[chosen.modelId]?.readsImages : undefined;
  const rows = ROWS.filter((row) => row.role !== "imageModel" || readsImages === false);

  return (
    <section
      data-testid="model-setup"
      aria-labelledby={`${id}-title`}
      className="setup-card flex min-h-0 max-h-[85vh] flex-col gap-2.5 overflow-y-auto px-4"
    >
      <h2
        id={`${id}-title`}
        data-setup-title
        data-testid="setup-ready-title"
        className="flex items-center gap-2 text-[15px] leading-6 font-semibold text-ink"
      >
        <CheckLineIcon className="size-4 shrink-0 text-ink" />
        {name ? t("setup.ready", { name }) : t("setup.ready.generic")}
      </h2>
      {/* Empty, it takes no room: the card's gap above it is taken back. */}
      <UndoLineAt place={SETUP_UNDO_PLACE} className="pl-2 empty:-mb-2.5" />
      {listFailed && (
        <ProblemLine
          testId="setup-jobs-problem"
          action={{ label: t("setup.jobs.retry"), testId: "setup-jobs-retry", onClick: load }}
        >
          {t("setup.jobs.listFailed")}
        </ProblemLine>
      )}
      <section data-testid="setup-jobs" className="flex flex-col">
        <h3 className="text-[13px] leading-5 font-semibold text-ink-secondary">
          {t("setup.jobs.title")}
        </h3>
        {rows.map((row) => (
          <Job
            key={row.role}
            id={`${id}-${row.role}`}
            testId={row.role}
            label={t(row.label)}
            tip={t(row.tip)}
            summary={
              <RoleSummary role={row.role} groups={groups} providers={providers} roles={roles} />
            }
            editor={(done, left) => (
              <RoleSelect
                id={`${id}-${row.role}`}
                role={row.role}
                groups={groups}
                providers={providers}
                roles={roles}
                className={jobSelectClass}
                labelledBy={`${id}-${row.role}-label`}
                focusOnShow
                onChosen={done}
                onBlur={left}
                onEscape={done}
              />
            )}
          />
        ))}
        <Job
          id={`${id}-meetings`}
          testId="meetings"
          label={t("models.defaults.meetings")}
          tip={t("models.defaults.meetings.tip")}
          summary={<RouteSummary />}
          editor={(done, left) => (
            <TranscriptionRouteSelect
              id={`${id}-meetings`}
              className={jobSelectClass}
              labelledBy={`${id}-meetings-label`}
              focusOnShow
              onChosen={done}
              onBlur={left}
              onEscape={done}
            />
          )}
        />
      </section>
      {recipient && <SendsLine provider={recipient} testId="setup-ready-sends" />}
      <TranscriptionRouteConsent />
      <div data-setup-foot>
        <button
          ref={next}
          type="button"
          data-testid="setup-continue"
          onClick={continueSetup}
          className={buttonStyle("primary", "md")}
        >
          {t("setup.continue")}
        </button>
      </div>
    </section>
  );
}

function RoleSummary({
  role,
  groups,
  providers,
  roles,
}: {
  role: (typeof ROWS)[number]["role"];
  groups: Parameters<typeof useJobSummary>[1];
  providers: readonly ChatProvider[];
  roles: ReturnType<typeof useModelRoles>;
}) {
  return <>{useJobSummary(role, groups, roles, providers)}</>;
}

function RouteSummary() {
  const t = useT();
  const route = useAppStore((state) => state.settings?.device.transcriptionRoute) ?? "local";
  return <>{t(ROUTE_LABELS[route])}</>;
}

function Job({
  id,
  testId,
  label,
  tip,
  summary,
  editor,
}: {
  id: string;
  testId: string;
  label: string;
  tip: string;
  summary: ReactNode;
  /** `done` after a choice or Esc, with the focus back on Change; `left` once the focus went elsewhere. */
  editor(done: () => void, left: () => void): ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const change = useRef<HTMLButtonElement>(null);
  const left = () => setEditing(false);
  const done = () => {
    left();
    // Back on the words, the focus on the button that opened the choice.
    requestAnimationFrame(() => change.current?.focus());
  };
  return (
    <div
      data-testid={`setup-job-${testId}`}
      className="grid min-h-9 grid-cols-[minmax(5rem,7rem)_minmax(0,1fr)_auto] items-start gap-x-3 py-1.5"
    >
      <span title={tip} id={`${id}-label`} className="text-[13px] leading-5 font-semibold text-ink">
        {label}
      </span>
      <span id={`${id}-tip`} className="sr-only">
        {tip}
      </span>
      {editing ? (
        <span className="col-span-2 min-w-0">{editor(done, left)}</span>
      ) : (
        <>
          <span
            data-testid={`setup-job-${testId}-value`}
            className="min-w-0 text-[13px] leading-5 break-words text-ink-secondary"
          >
            {summary}
          </span>
          <button
            ref={change}
            type="button"
            data-testid={`setup-job-${testId}-change`}
            aria-label={t("setup.jobs.changeJob", { job: label })}
            onClick={() => setEditing(true)}
            className="shrink-0 text-[13px] leading-5 font-semibold text-accent underline-offset-2 hover:underline"
          >
            {t("setup.jobs.change")}
          </button>
        </>
      )}
    </div>
  );
}
