import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { Fragment, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import {
  type AnswerToolCall,
  type ApprovalRequest,
  BLOCK_ID_ATTRIBUTE,
  type ChatModelChoice,
  type ProviderErrorKind,
  type SignInRouteProblem,
  SKILL_SCRIPT_LIMITS,
  type SkillScriptApprovalRequest,
  SOURCE_KIND_PROVIDERS,
  type ToolApprovalRequest,
} from "../../../core/api";
import { isSignInRoute, isSignInRouteProblem } from "../../../core/providers/signInRoutes";
import { asksAfterThirdParty } from "../../../shared/approvalRules";
import { toolCallsOf } from "../../../shared/toolCalls";
import { AnswerWriting } from "../answerPhase";
import { isCalculated, RUN_SCRIPT, SEARCH } from "../answerSteps";
import { useAnswers } from "../answers";
import { useApprovals, waitingFor } from "../approvals";
import { signInAgain } from "../chatGptSignIn";
import { AskCall } from "../components/assistant/AskCall";
import { CommandCall } from "../components/assistant/CommandCall";
import { MindCall } from "../components/assistant/MindCall";
import { DetailsLine } from "../components/DetailsLine";
import { useIsExampleAnswer } from "../components/GettingStarted";
import { PlugIcon, ScriptIcon, SkillIcon, StopIcon } from "../components/icons";
import { DocumentLineIcon, FindSourcesLineIcon } from "../components/lineIcons";
import { ObjectMenu, useObjectMenu } from "../components/ObjectMenu";
import { ProblemLine, ProblemMark } from "../components/ProblemLine";
import {
  LocalModelRefusedLine,
  OllamaNotRunningLine,
} from "../components/providers/OllamaProblems";
import { RouteProblemLine } from "../components/providers/RouteProblemLine";
import { core } from "../core";
import { formatResetTime } from "../cost";
import { useDeclineEnded } from "../declineEnded";
import { useFindSources } from "../findSources";
import { useLanguage, useT } from "../i18n";
import {
  billingUrlOfProvider,
  keyProviderOf,
  useBillingOpenedSince,
  useKeyRefusals,
  useKeySavedSince,
} from "../keyRefusals";
import { requestModelMenu, retryModel } from "../modelMenu";
import { useModelNames, useServiceName } from "../modelNames";
import { useStoppedByPlanLimit } from "../planLimits";
import { ANSWER_PROBLEMS, failedAnswerLine, retry } from "../problems";
import { useRouteOffered } from "../routeSignIn";
import type { SettingsPage } from "../settingsPages";
import { skillTitle } from "../skills";
import { useAppStore } from "../store";
import { reasonKey } from "../webPages";
import { AnalysisCall } from "./AnalysisCall";
import { CommandApprovalCard } from "./CommandApprovalCard";
import { ChevronRightSmallIcon, RegenerateSmallIcon } from "./icons";
import { useMindId } from "./mindContext";
import { PlanLimitLine } from "./PlanLimitLine";
import { ThirdPartyLine } from "./ThirdPartyLine";
import { withShortcut } from "./withShortcut";

const text = (value: unknown) => (typeof value === "string" ? value : null);

const isErrorKind = (value: unknown): value is ProviderErrorKind =>
  typeof value === "string" && Object.hasOwn(ANSWER_PROBLEMS, value);

/** Items of the meta line, with a dot between each two. */
function Dotted({ items }: { items: ReactNode[] }) {
  return items.map((item, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the items are fixed slots of the meta line.
    <Fragment key={index}>
      {index > 0 && <span aria-hidden="true">·</span>}
      {item}
    </Fragment>
  ));
}

/**
 * An Answer: grey text at the Mind's text edge, under its Question line, with
 * no box, no label and no meta line at rest (DESIGN.md, Answer). Its meta line
 * shows on hover or focus, just under its last line: which model wrote it,
 * what it searched (it opens to the list) and Regenerate. While it is being
 * written the line stays, with a pulsing dot, what it is doing and Stop; once
 * stopped, it says so. Above its text, ruled rows for the Skills, Connector
 * calls and Skill scripts it used; under it, what went wrong and how to fix
 * it, and the approval cards of calls waiting for the User.
 */
export function AnswerView({ node, editor, getPos }: ReactNodeViewProps) {
  const t = useT();
  const mindId = useMindId();
  const answerId = text(node.attrs[BLOCK_ID_ATTRIBUTE]);
  const questionId = text(node.attrs.questionId);
  const modelId = text(node.attrs.modelId);
  const shownModel = useModelNames()(modelId ?? "", text(node.attrs.providerId));
  const status = text(node.attrs.status) ?? "done";
  const writing = useAnswers((state) => (answerId ? state.writing.has(answerId) : false));
  // The event says so first; the status says so in windows that opened since.
  const streaming = writing || status === "streaming";
  const { regenerate, stop } = useAnswers.getState();
  const openSettings = useAppStore((state) => state.openSettings);
  const toolCalls = toolCallsOf(node.attrs.toolCalls);
  const searches = toolCalls.filter((call) => call.tool === SEARCH);
  const [searchesOpen, setSearchesOpen] = useState(false);
  // Written again, it starts with its searches closed.
  if (searchesOpen && searches.length === 0) setSearchesOpen(false);
  const waiting = useApprovals((state) => state.waiting);
  const approvals = useMemo(() => waitingFor(waiting, answerId), [waiting, answerId]);
  const isExample = useIsExampleAnswer(answerId);
  const planModel = useStoppedByPlanLimit(
    status === "failed" && isErrorKind(node.attrs.errorKind) ? node.attrs.errorKind : null,
    text(node.attrs.providerId),
  )
    ? modelId
    : null;

  // One the User edited comes back as changes over their version: nothing to confirm.
  const writeAgain = async () => {
    if (answerId && questionId) await regenerate(mindId, answerId, questionId);
  };
  const objectMenu = useObjectMenu({ kind: "answer", id: answerId ?? "" });
  const here = {
    "answer.copy": () => {
      navigator.clipboard.writeText(node.textContent).catch(useAppStore.getState().reportError);
    },
    ...(!streaming && questionId && { "answer.regenerate": () => writeAgain() }),
    "block.delete": () => {
      const pos = getPos();
      if (pos !== undefined) editor.commands.deleteBlock(pos);
    },
  };

  const meta: ReactNode[] = [];
  if (streaming) {
    meta.push(<AnswerWriting answerId={answerId} waitingForApproval={approvals.length > 0} />);
  } else if (status === "stopped") {
    meta.push(<span data-testid="answer-stopped">{t("answer.status.stopped")}</span>);
  }
  // Written in advance, by no model, until it is written again with the User's.
  if (isExample && !modelId && !streaming) {
    meta.push(<span data-testid="answer-example">{t("examples.answer")}</span>);
  }
  if (modelId) {
    meta.push(
      <span data-testid="answer-model" className="answer-model" title={shownModel.id}>
        {shownModel.name}
      </span>,
    );
  }
  if (searches.length > 0) {
    meta.push(
      <SearchesSummary
        searches={searches}
        open={searchesOpen}
        onToggle={() => setSearchesOpen((open) => !open)}
      />,
    );
  }
  const { calculated, uncalculated } = figuresOf(toolCalls);

  return (
    <NodeViewWrapper
      className="answer-block"
      data-testid="answer"
      data-status={streaming ? "streaming" : status}
      data-answer-id={answerId ?? undefined}
      {...(answerId ? objectMenu.rowProps : {})}
    >
      <span contentEditable={false} className="sr-only">
        {t("answer.label")}
      </span>
      <CallRows calls={toolCalls} approvals={approvals} />

      {text(node.attrs.citationSupport) === "none" && (
        <div contentEditable={false}>
          <NoCitationsLine modelId={modelId} providerId={text(node.attrs.providerId)} />
        </div>
      )}

      <NodeViewContent
        className="answer-content"
        data-generated-marks={node.attrs.generatedMarks === true ? "" : undefined}
      />

      {!streaming && uncalculated > 0 && <UncalculatedLine count={uncalculated} />}

      {searchesOpen && (
        <div contentEditable={false} className="answer-searches-open">
          <SearchList searches={searches} calculated={calculated} />
        </div>
      )}

      {!streaming && status === "failed" && !planModel && (
        <AnswerError
          kind={isErrorKind(node.attrs.errorKind) ? node.attrs.errorKind : "unknown"}
          modelId={modelId}
          providerId={text(node.attrs.providerId)}
          resetsAt={text(node.attrs.errorResetsAt)}
          signInRoute={
            isSignInRouteProblem(node.attrs.errorSignInRoute) ? node.attrs.errorSignInRoute : null
          }
          details={text(node.attrs.errorMessage)}
          onRetry={questionId ? () => writeAgain() : undefined}
          onOpenSettings={openSettings}
        />
      )}
      {!streaming && status === "failed" && planModel && (
        <PlanLimitLine
          modelId={planModel}
          providerId={text(node.attrs.providerId)}
          details={text(node.attrs.errorMessage)}
          onAnswerAgain={writeAgain}
        />
      )}

      {approvals.length > 0 && (
        <div contentEditable={false} className="answer-approvals">
          {/* Keyed by request, so a card keeps its state (the "Always run" warning) as its call comes in. */}
          {approvals.map((request) => (
            <ApprovalCard key={request.requestId} request={request} />
          ))}
        </div>
      )}

      {/* Under its last line, in the room before the next Block: shown on hover or focus. */}
      <div contentEditable={false} data-testid="answer-meta" className="answer-meta">
        <Dotted items={meta} />
        {streaming && answerId && (
          <button
            type="button"
            data-testid="answer-stop"
            onClick={() => stop(mindId, answerId)}
            className="answer-action"
          >
            <StopIcon className="size-3" />
            {t("answer.stop")}
          </button>
        )}
        {!streaming && questionId && (
          <button
            type="button"
            data-testid="answer-regenerate"
            onClick={() => writeAgain()}
            className="answer-action"
          >
            <RegenerateSmallIcon className="size-3" />
            {t("answer.regenerate")}
          </button>
        )}
        {answerId && (
          <ObjectMenu
            target={{ kind: "answer", id: answerId }}
            label={t("answer.more")}
            here={here}
            className="answer-action"
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}

/** An Answer by a model that can't add Citations (#765): it says so, with the way to another model. */
export function NoCitationsLine({
  modelId,
  providerId,
}: {
  modelId: string | null;
  providerId: string | null;
}) {
  const t = useT();
  const shownModel = useModelNames()(modelId ?? "", providerId);
  return (
    <ProblemLine
      testId="answer-no-citations"
      role="status"
      action={{
        label: t("citation.unsupported.choose"),
        testId: "answer-choose-model",
        onClick: requestModelMenu,
      }}
      className="answer-info"
    >
      {t("citation.unsupported", {
        model: modelId ? shownModel.name : t("answer.error.thisModel"),
      })}
    </ProblemLine>
  );
}

/** Failures that can come of a model that can't answer, rather than of the connection. */
const WRONG_MODEL: ReadonlySet<ProviderErrorKind> = new Set([
  "model",
  "provider",
  "refused",
  "no-answer",
  "unknown",
]);

/** A failed Answer, under what was written of it: one line, and the one thing that can fix it. */
export function AnswerError({
  kind,
  modelId,
  providerId,
  resetsAt,
  signInRoute = null,
  details,
  failedAt = null,
  onRetry,
  onRetryWith,
  modelNow = null,
  chooseHere = false,
  onOpenSettings,
}: {
  kind: ProviderErrorKind;
  modelId: string | null;
  providerId: string | null;
  /** When the plan's limit resets, when its provider said. */
  resetsAt: string | null;
  signInRoute?: SignInRouteProblem | null;
  details: string | null;
  /**
   * When it failed, ISO 8601, said beside a refused key; an Answer in a Mind keeps no time, so
   * its failure counts from when it was first shown. A key saved since lets it be asked again.
   */
  failedAt?: string | null;
  onRetry?: (() => void) | undefined;
  /** Asks again with the model the composer shows now, when it isn't the one that failed (#1848). */
  onRetryWith?: ((model: ChatModelChoice) => void) | undefined;
  /** The model the composer's chip shows now. */
  modelNow?: ChatModelChoice | null;
  /** The composer's model menu is here: "Choose another model" opens it, not Settings. */
  chooseHere?: boolean;
  onOpenSettings(page: SettingsPage): void;
}) {
  const t = useT();
  const language = useLanguage();
  const shownModel = useModelNames()(modelId ?? "", providerId);
  const providerInUse = useAnswers(
    (state) => state.models?.find((group) => group.provider.id === providerId)?.provider,
  );
  const provider = providerInUse?.kind;
  const service = useServiceName(providerId);
  const [shownAt] = useState(() => new Date().toISOString());
  const billingOpened = useBillingOpenedSince(providerId, failedAt ?? shownAt);
  const keySaved = useKeySavedSince(providerId, failedAt ?? shownAt);
  const pickedModel = retryModel({ providerId, modelId }, modelNow);
  const declineEnded = useDeclineEnded(
    providerInUse?.service?.id ?? null,
    kind === "consent-declined" && onRetry !== undefined,
  );
  // Whose plan or sign-in it was decides the line. A sign-in that ends changes readiness, which
  // clears the list, so it is read again then, and not on every error (offline, that only fails).
  const readiness = useAppStore((state) => state.chatReadiness);
  useEffect(() => {
    if (readiness) useAnswers.getState().loadModels();
  }, [readiness]);
  // A model the User added to the menu that then failed: one click takes it back out.
  const added = useAnswers((state) =>
    state.models?.some(
      (group) =>
        group.provider.id === providerId && modelId !== null && group.added.includes(modelId),
    ),
  );
  const removeFromMenu =
    added && WRONG_MODEL.has(kind) && providerId && modelId
      ? () => {
          void core.setChatModelInMenu({ providerId, modelId, inMenu: false }).then(() => {
            useAnswers.setState({ models: null });
            useAnswers.getState().loadModels();
          });
        }
      : undefined;
  const offered = useRouteOffered(isSignInRoute(provider) ? provider : null);
  const billingUrl = billingUrlOfProvider(providerInUse);
  const shown = failedAnswerLine(kind, provider, signInRoute, offered, {
    ...(billingUrl && { billingUrl }),
    ...(providerInUse && { local: providerInUse.service === null }),
  });
  if (shown.kind === "route") {
    return (
      <RouteProblemLine
        route={shown.route}
        words={shown.words}
        kind={kind}
        resetsAt={resetsAt}
        details={details}
        onRetry={onRetry}
        onOpenSettings={onOpenSettings}
      />
    );
  }
  const { line } = shown.problem;
  const fix =
    kind === "consent-declined" && declineEnded
      ? retry
      : kind === "out-of-credit" && (billingOpened || keySaved) && onRetry
        ? retry
        : shown.problem.fix;
  if (fix.kind === "ollama") return <OllamaNotRunningLine details={details} onRetry={onRetry} />;
  if (fix.kind === "local-model") {
    return (
      <LocalModelRefusedLine
        model={modelId ? shownModel.name : t("answer.error.thisModel")}
        details={details}
      />
    );
  }
  const chooseModel = fix.kind === "settings" && fix.page === "models";
  const action =
    chooseModel && pickedModel && onRetryWith
      ? { label: t("answer.error.askAgain"), onClick: () => onRetryWith(pickedModel) }
      : removeFromMenu
        ? { label: t("answer.error.removeFromMenu"), onClick: removeFromMenu }
        : kind === "auth" && keySaved && onRetry
          ? { label: t("answer.error.askAgain"), onClick: onRetry }
          : kind === "auth"
            ? {
                label: t("answer.error.checkKey"),
                onClick: () =>
                  void useKeyRefusals.getState().check(providerId, modelId ?? "", failedAt),
              }
            : fix.kind === "settings"
              ? {
                  label: t(fix.label),
                  onClick: () =>
                    chooseModel && chooseHere ? requestModelMenu() : onOpenSettings(fix.page),
                }
              : fix.kind === "sign-in"
                ? {
                    label: t(fix.label),
                    onClick: () =>
                      void signInAgain(onOpenSettings).then((signedIn) => {
                        if (signedIn) onRetry?.();
                      }),
                  }
                : fix.kind === "link"
                  ? // The main process opens it in the User's browser.
                    {
                      label: `${t(fix.label)} ↗`,
                      onClick: () => {
                        if (kind === "out-of-credit")
                          useKeyRefusals.getState().openBilling(providerId, fix.url);
                        else window.open(fix.url, "_blank", "noreferrer");
                      },
                    }
                  : fix.kind === "retry" && onRetry
                    ? { label: t(fix.label), onClick: onRetry }
                    : undefined;
  return (
    <div contentEditable={false} data-testid="answer-error" data-error-kind={kind}>
      <ProblemLine
        action={action && { ...action, testId: "answer-error-action" }}
        also={
          kind === "out-of-credit" &&
          line === "answer.error.out-of-credit" &&
          keyProviderOf(providerInUse)
            ? {
                label: t("answer.error.useAnotherKey"),
                testId: "answer-error-key",
                onClick: () =>
                  void useKeyRefusals
                    .getState()
                    .check(providerId, modelId ?? "", failedAt, "out-of-credit"),
              }
            : undefined
        }
        // The provider's own words, for whoever wants them.
        title={details ?? undefined}
        className="mt-1 select-none"
      >
        {t(line, { model: modelId ? shownModel.name : t("answer.error.thisModel"), service })}
        {removeFromMenu && kind !== "model" && ` · ${shownModel.name}`}
        {kind === "plan-limit" && resetsAt && (
          <>
            <span aria-hidden="true"> · </span>
            {t("run.stopped.tryAfter", { time: formatResetTime(resetsAt, language) })}
          </>
        )}
      </ProblemLine>
    </div>
  );
}

/**
 * The Skills, Connector calls and Skill script runs an Answer made, as ruled
 * rows, Skills first. A call waiting for the User's approval has no row: its
 * approval card shows instead, after the Answer's text.
 */
export function CallRows({
  calls,
  approvals,
}: {
  calls: AnswerToolCall[];
  approvals: ApprovalRequest[];
}) {
  const waitingIds = new Set(approvals.map((request) => request.toolCallId));
  const rows = calls
    .filter(
      (call) =>
        !waitingIds.has(call.id) &&
        (call.source === "connector" ||
          call.source === "sources" ||
          call.source === "web" ||
          call.source === "analysis" ||
          (call.source === "skill" && call.tool === RUN_SCRIPT)),
    )
    .map((call) => <CallRow key={call.id} call={call} />);
  const skills = skillRows(calls);
  if (skills.length === 0 && rows.length === 0) return null;
  return (
    <div contentEditable={false} className="answer-calls">
      {skills.map(({ name, use, reads }) => (
        <SkillRow key={name} name={name} use={use} reads={reads} />
      ))}
      {rows}
    </div>
  );
}

export function CallRow({ call }: { call: AnswerToolCall }) {
  if (call.source === "asks") return <AskCall call={call} />;
  if (call.source === "minds") return <MindCall call={call} />;
  if (call.source === "analysis") return <AnalysisCall call={call} />;
  if (call.source === "commands") return <CommandCall call={call} />;
  if (call.source === "connector") return <ConnectorCall call={call} />;
  if (call.source === "sources") return <SourcesCall call={call} />;
  if (call.source === "web") return <WebCall call={call} />;
  return <ScriptCall call={call} />;
}

/**
 * The approval card for a request: a Connector's Tool, or a Skill script.
 * `keys`: the shortcut that allows it once, shown on its button (the Task tray's ⌘↵).
 */
export function ApprovalCard({ request, keys }: { request: ApprovalRequest; keys?: string }) {
  if ("ask" in request) return <CommandApprovalCard request={request} keys={keys} />;
  return request.subject.kind === "skill-script" ? (
    <ScriptApprovalCard request={request as SkillScriptApprovalRequest} keys={keys} />
  ) : (
    <ToolApprovalCard request={request as ToolApprovalRequest} keys={keys} />
  );
}

/** Stands for the name in a title, which is then drawn in mono (see `TitleWithCode`). */
const NAME_SLOT = "\u0000";

/** A title with a Tool or script name in it, the name in mono. */
function TitleWithCode({ title, code }: { title: string; code: string }) {
  const [before, after = ""] = title.split(NAME_SLOT);
  return (
    <span className="approval-title-text">
      {before}
      <code>{code}</code>
      {after}
    </span>
  );
}

/**
 * A Tool call waiting for the User: a ruled block in three sections. Which
 * Tool of which Connector, and whether it may change something or the User
 * asked to approve it every time, and why it asks when its Answer had read
 * third-party text; the arguments it would send; and three choices, or two
 * when its Answer had read third-party text: "Always allow" wouldn't cover
 * such a call, so it isn't offered. The Answer waits meanwhile.
 */
function ToolApprovalCard({ request, keys }: { request: ToolApprovalRequest; keys?: string }) {
  const t = useT();
  const respond = useApprovals((state) => state.respond);
  const titleId = useId();
  const params = { connector: request.connector.name, tool: request.tool };
  const decide = (decision: Parameters<typeof respond>[1]) => respond(request.requestId, decision);
  const thirdParty = asksAfterThirdParty(request);
  return (
    <div
      contentEditable={false}
      role="alertdialog"
      aria-labelledby={titleId}
      data-testid="approval-card"
      data-tool={request.tool}
      data-read-only={request.readOnly}
      className="approval-card"
    >
      <div className="approval-head">
        <p id={titleId} className="approval-title">
          <span aria-hidden="true" className="approval-dot" />
          <TitleWithCode
            title={t("approvals.card.title", { ...params, tool: NAME_SLOT })}
            code={request.tool}
          />
        </p>
        {request.title && request.title !== request.tool && (
          <p className="approval-explanation">{request.title}</p>
        )}
        <p className="approval-explanation">
          {request.readOnly
            ? t("approvals.card.readOnly", params)
            : t("approvals.card.changes", params)}
        </p>
        <ThirdPartyLine request={request} />
      </div>
      <ApprovalArguments input={request.input} />
      <div className="approval-actions">
        <button
          type="button"
          data-testid="approval-allow-once"
          onClick={() => decide("allow-once")}
          className="approval-button approval-button--primary"
          {...withShortcut(t("approvals.card.allowOnce"), keys)}
        >
          {t("approvals.card.allowOnce")}
          {keys && <span className="approval-keys">{keys}</span>}
        </button>
        {!thirdParty && (
          <button
            type="button"
            data-testid="approval-always-allow"
            title={t("approvals.card.alwaysAllowHint", params)}
            onClick={() => decide("always-allow")}
            className="approval-button"
          >
            {t("approvals.card.alwaysAllow")}
          </button>
        )}
        <button
          type="button"
          data-testid="approval-deny"
          onClick={() => decide("deny")}
          className="approval-button approval-button--ghost"
        >
          {t("approvals.card.deny")}
        </button>
      </div>
    </div>
  );
}

/**
 * A Skill script waiting for the User, in the same three sections: which
 * script of which Skill, and what it can reach (in the OS sandbox, or with
 * no sandbox: `Settings.scriptSandbox`), and why it asks when its Answer had
 * read third-party text; the Skill, script and arguments it would run with;
 * and three choices, without "Always run" when its Answer had read
 * third-party text. "Always run" first shows a warning in the last section,
 * which must be confirmed. The Answer waits meanwhile.
 */
function ScriptApprovalCard({
  request,
  keys,
}: {
  request: SkillScriptApprovalRequest;
  keys?: string;
}) {
  const t = useT();
  const respond = useApprovals((state) => state.respond);
  const sandboxed = useAppStore((state) => state.settings?.scriptSandbox === "os");
  const [warning, setWarning] = useState(false);
  const titleId = useId();
  const warningId = useId();
  const params = { skill: skillTitle(request.skill.name, t), script: request.script };
  return (
    <div
      contentEditable={false}
      role="alertdialog"
      aria-labelledby={titleId}
      data-testid="approval-card"
      data-tool={request.tool}
      data-kind="skill-script"
      className="approval-card"
    >
      <div className="approval-head">
        <p id={titleId} className="approval-title">
          <span aria-hidden="true" className="approval-dot" />
          <TitleWithCode
            title={t("scripts.card.title", { ...params, script: NAME_SLOT })}
            code={request.script}
          />
        </p>
        <div
          data-testid="approval-sandbox"
          data-sandbox={sandboxed ? "os" : "none"}
          className="approval-explanation"
        >
          {sandboxed ? (
            <DetailsLine
              testId="approval-sandbox-reach"
              details={t("scripts.card.sandboxed.details")}
            >
              {t("scripts.card.sandboxed")}
            </DetailsLine>
          ) : (
            <p>{t("scripts.card.noSandbox")}</p>
          )}
        </div>
        <ThirdPartyLine request={request} />
      </div>
      <div className="approval-details">
        <p className="approval-label">{t("scripts.card.wouldRun")}</p>
        <dl data-testid="approval-script" className="approval-args">
          <dt>{t("scripts.card.skill")}</dt>
          <dd data-testid="approval-script-skill">{skillTitle(request.skill.name, t)}</dd>
          <dt>{t("scripts.card.script")}</dt>
          <dd data-testid="approval-script-path" className="font-mono">
            {request.script}
          </dd>
          <dt>{t("scripts.card.args")}</dt>
          <dd>
            {request.args.length === 0 ? (
              <span className="approval-empty">{t("scripts.card.noArgs")}</span>
            ) : (
              <ol className="list-none">
                {request.args.map((arg, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: arguments are positional and may repeat.
                  <li key={index} data-testid="approval-argument" className="font-mono">
                    {arg}
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </dl>
      </div>
      {warning ? (
        <div
          role="alertdialog"
          aria-labelledby={warningId}
          data-testid="always-run-warning"
          className="approval-actions approval-warning"
        >
          <p id={warningId} className="approval-warning-title">
            <ProblemMark />
            {t("scripts.alwaysRun.title", params)}
          </p>
          {sandboxed ? (
            <DetailsLine
              testId="always-run-reach"
              className="approval-warning-body"
              details={t("scripts.alwaysRun.bodySandboxed.details")}
            >
              {t("scripts.alwaysRun.bodySandboxed", params)}
            </DetailsLine>
          ) : (
            <p className="approval-warning-body">{t("scripts.alwaysRun.body", params)}</p>
          )}
          <p className="approval-warning-body">{t("scripts.alwaysRun.trust")}</p>
          <div className="approval-buttons">
            <button
              type="button"
              data-testid="always-run-confirm"
              onClick={() => respond(request.requestId, "always-allow", { riskAccepted: true })}
              className="approval-button"
            >
              {t("scripts.alwaysRun.confirm", params)}
            </button>
            <button
              type="button"
              data-testid="always-run-cancel"
              onClick={() => setWarning(false)}
              className="approval-button approval-button--ghost"
            >
              {t("scripts.alwaysRun.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            data-testid="approval-allow-once"
            onClick={() => respond(request.requestId, "allow-once")}
            className="approval-button approval-button--primary"
            {...withShortcut(t("scripts.card.allowOnce"), keys)}
          >
            {t("scripts.card.allowOnce")}
            {keys && <span className="approval-keys">{keys}</span>}
          </button>
          {!asksAfterThirdParty(request) && (
            <button
              type="button"
              data-testid="approval-always-run"
              title={t("scripts.card.alwaysRunHint", params)}
              onClick={() => setWarning(true)}
              className="approval-button"
            >
              {t("scripts.card.alwaysRun")}
            </button>
          )}
          <button
            type="button"
            data-testid="approval-deny"
            onClick={() => respond(request.requestId, "deny")}
            className="approval-button approval-button--ghost"
          >
            {t("scripts.card.deny")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The arguments a call would send, readably: a key/value grid with the names
 * in mono, text as text (line breaks kept), anything else as indented JSON.
 */
function ApprovalArguments({ input }: { input: Record<string, unknown> }) {
  const t = useT();
  const entries = Object.entries(input);
  return (
    <div data-testid="approval-arguments" className="approval-details">
      <p className="approval-label">{t("approvals.card.arguments")}</p>
      {entries.length === 0 ? (
        <p className="approval-empty">{t("approvals.card.noArguments")}</p>
      ) : (
        <dl className="approval-args">
          {entries.map(([name, value]) => (
            <div key={name} data-testid="approval-argument" className="contents">
              <dt>{name}</dt>
              <dd>
                {typeof value === "string" ? (
                  value
                ) : (
                  <pre className="whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * A run of a Skill script: which script of which Skill, how it went, on one
 * row that opens to show its arguments and what it wrote (what the model
 * was given), or why it couldn't run.
 */
function ScriptCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const params = { skill: skillTitle(field(call, "skill"), t), script: field(call, "script") };
  const args = Array.isArray(call.input.args) ? call.input.args.map(String) : [];
  const run = call.script;
  const running = call.status === "running";
  const summary =
    call.approval === "denied"
      ? t("scripts.call.denied", params)
      : running && call.approval === "waiting"
        ? t("scripts.call.waiting", params)
        : running
          ? t("scripts.call.running", params)
          : run?.error
            ? t("scripts.call.cantRun", params)
            : run?.timedOut
              ? t("scripts.call.timedOut", params)
              : run && run.exitCode !== null
                ? t("scripts.call.exited", { ...params, code: run.exitCode })
                : t("scripts.call.stopped", params);
  const limit = SKILL_SCRIPT_LIMITS.maxOutputBytes;
  return (
    <div
      contentEditable={false}
      data-testid="answer-script-call"
      data-status={call.status}
      data-approval={call.approval}
      data-exit-code={run?.exitCode ?? undefined}
      className="answer-call"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary}. ${t("scripts.call.details")}`}
        onClick={() => setExpanded((open) => !open)}
        className="answer-call-summary"
      >
        <ScriptIcon className={`answer-call-icon ${running ? "animate-pulse" : ""}`} />
        <span className="answer-call-text">{summary}</span>
      </button>
      {expanded && (
        <div className="answer-call-details" data-testid="answer-script-details">
          <div className="answer-call-detail-label">{t("scripts.call.args")}</div>
          <pre data-testid="answer-script-args">
            {args.length > 0 ? args.join(" ") : t("scripts.card.noArgs")}
          </pre>
          {run?.error && (
            <p data-testid="answer-script-error" className="answer-call-error">
              <ProblemMark />
              {run.error}
            </p>
          )}
          {run && !run.error && (
            <>
              <div className="answer-call-detail-label">{t("scripts.call.stdout")}</div>
              <pre data-testid="answer-script-stdout">{run.stdout || "—"}</pre>
              {run.stdoutTruncated && (
                <p className="answer-call-detail-label">
                  {t("scripts.call.stdoutTruncated", { bytes: limit })}
                </p>
              )}
              <div className="answer-call-detail-label">{t("scripts.call.stderr")}</div>
              <pre data-testid="answer-script-stderr">{run.stderr || "—"}</pre>
              {run.stderrTruncated && (
                <p className="answer-call-detail-label">
                  {t("scripts.call.stderrTruncated", { bytes: limit })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A call an Answer made through a Connector: which Connector and Tool, and
 * the arguments it sent, on one row that opens to show them in full. What
 * came back went to the model; it isn't a Passage, so it is never a Citation.
 */
function ConnectorCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const params = { connector: call.connector?.name ?? "", tool: call.tool };
  const running = call.status === "running";
  if (call.signInRequired) return <SignInRequired connector={params.connector} />;
  const summary =
    call.approval === "denied"
      ? t("approvals.call.denied", params)
      : running && call.approval === "waiting"
        ? t("approvals.call.waiting", params)
        : running
          ? t("connectors.call.running", params)
          : call.status === "failed"
            ? t("connectors.call.failed", params)
            : call.approval === "allowed"
              ? t("approvals.call.allowed", params)
              : t("connectors.call.done", params);
  const compact = JSON.stringify(call.input);
  return (
    <div
      contentEditable={false}
      data-testid="answer-connector-call"
      data-status={call.status}
      data-approval={call.approval}
      className="answer-call"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary}. ${t("connectors.call.details")}`}
        onClick={() => setExpanded((open) => !open)}
        className="answer-call-summary"
      >
        <PlugIcon className={`answer-call-icon ${running ? "animate-pulse" : ""}`} />
        <span className="answer-call-text shrink-0">{summary}</span>
        {!expanded && compact !== "{}" && <code className="answer-call-args">{compact}</code>}
      </button>
      {expanded && (
        <div className="answer-call-details">
          <div className="answer-call-detail-label">
            {call.approval === "denied"
              ? t("approvals.call.notSent")
              : t("connectors.call.arguments")}
          </div>
          <pre data-testid="answer-connector-arguments">{JSON.stringify(call.input, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * Find sources, as an Answer called it: what it searched for and how many
 * works it found, with "Show results", which opens them in the Library to
 * add (the same search, answered from what was found, so nothing is sent again).
 */
function SourcesCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const query = field(call, "query");
  const year = (name: string) => {
    const value = call.input[name];
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  };
  const running = call.status === "running";
  const failed = call.status === "failed";
  const summary = t(
    running ? "sources.call.running" : failed ? "sources.call.failed" : "sources.call.done",
    { query },
  );
  const count = call.resultCount;
  return (
    <div
      contentEditable={false}
      data-testid="answer-sources-call"
      data-status={call.status}
      className="answer-call"
    >
      <span className="answer-call-summary answer-call-summary--static">
        <FindSourcesLineIcon className={`answer-call-icon ${running ? "animate-pulse" : ""}`} />
        <span className="answer-call-text">{summary}</span>
        {!running && !failed && count !== null && (
          <span className="answer-call-note">
            · {t(count === 1 ? "sources.call.found.one" : "sources.call.found", { count })}
          </span>
        )}
        {!running && !failed && query && (
          <button
            type="button"
            data-testid="answer-sources-show"
            onClick={() =>
              useFindSources.getState().show({
                query,
                fromYear: year("from_year"),
                toYear: year("to_year"),
                openAccessOnly: call.input.open_access_only === true,
                ...(typeof call.input.kind === "string" &&
                  SOURCE_KIND_PROVIDERS[call.input.kind] && {
                    providers: SOURCE_KIND_PROVIDERS[call.input.kind],
                  }),
              })
            }
            className="answer-action"
          >
            {t("sources.call.show")}
          </button>
        )}
      </span>
    </div>
  );
}

/** What a call of web search said: running, what it searched for, or the page it saved or why not (#128). */
function webCallText(t: ReturnType<typeof useT>, call: AnswerToolCall): string {
  const running = call.status === "running";
  if (call.tool === "search_web") {
    const query = field(call, "query");
    if (running) return t("web.call.searching", { query });
    return t(call.status === "failed" ? "web.call.searchFailed" : "web.call.searched", { query });
  }
  const page = call.webPage;
  const address = page?.address ?? field(call, "url");
  if (page && "documentId" in page) return t("web.call.saved", { name: page.name });
  if (running) return t("web.call.reading", { address });
  return t("web.call.notSaved", {
    address,
    reason: t(reasonKey(page && "failure" in page ? page.failure : "unreachable")),
  });
}

/**
 * A call of web search: a search, with how many pages it found; or a page
 * read, saved as a Document that opens from here, or why it couldn't be saved.
 */
function WebCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const running = call.status === "running";
  const page = call.webPage;
  const saved = page && "documentId" in page ? page : null;
  const count = call.tool === "search_web" && call.status === "done" ? call.resultCount : null;
  const text = webCallText(t, call);
  return (
    <div
      contentEditable={false}
      data-testid="answer-web-call"
      data-tool={call.tool}
      data-status={call.status}
      className="answer-call"
    >
      <span className="answer-call-summary answer-call-summary--static">
        <DocumentLineIcon
          kind="web"
          className={`answer-call-icon ${running ? "animate-pulse" : ""}`}
        />
        <span className="answer-call-text" title={text}>
          {text}
        </span>
        {count !== null && (
          <span className="answer-call-note">
            · {t(count === 1 ? "web.call.pages.one" : "web.call.pages", { count })}
          </span>
        )}
        {saved && (
          <button
            type="button"
            data-testid="answer-web-open"
            onClick={() => useAppStore.getState().openDocument({ documentId: saved.documentId })}
            className="answer-action"
          >
            {t("web.call.open")}
          </button>
        )}
      </span>
    </div>
  );
}

/** A remote Connector the Answer couldn't use: it waits for the User to sign in again. */
function SignInRequired({ connector }: { connector: string }) {
  const t = useT();
  return (
    <div contentEditable={false} data-testid="answer-sign-in-required" className="answer-call">
      <span className="answer-call-summary answer-call-summary--static">
        <PlugIcon className="answer-call-icon" />
        <span className="answer-call-text">
          {t("remoteConnectors.answer.signInRequired", { connector })}
        </span>
      </span>
    </div>
  );
}

/** A text field of what a Tool call was asked, or "". */
function field(call: AnswerToolCall, name: string): string {
  const value: unknown = call.input?.[name];
  return typeof value === "string" ? value : "";
}

interface SkillUse {
  name: string;
  /** How it was loaded: by the model, or chosen for the Question. */
  use: AnswerToolCall | null;
  /** The Skill's files it read. */
  reads: AnswerToolCall[];
}

/** The Skills an Answer used, in the order it first used them. */
function skillRows(calls: AnswerToolCall[]): SkillUse[] {
  const skills = new Map<string, SkillUse>();
  for (const call of calls) {
    // Script runs have rows of their own (`ScriptCall`).
    if (call.source !== "skill" || call.tool === RUN_SCRIPT) continue;
    const name = call.tool === "use_skill" ? field(call, "name") : field(call, "skill");
    const entry = skills.get(name) ?? { name, use: null, reads: [] };
    if (call.tool === "use_skill") entry.use ??= call;
    else entry.reads.push(call);
    skills.set(name, entry);
  }
  return [...skills.values()];
}

/** A Skill an Answer used, loaded by the model or chosen for the Question, with the files it read. */
export function SkillRow({ name, use, reads }: SkillUse) {
  const t = useT();
  const status = use?.status ?? "done";
  const title = skillTitle(name, t);
  const summary =
    status === "running"
      ? t("skills.answer.loading", { name: title })
      : status === "failed"
        ? t("skills.answer.failed", { name: title })
        : t("skills.answer.used", { name: title });
  return (
    <div
      data-testid="answer-skill"
      data-skill-name={name}
      data-status={status}
      data-forced={use?.forced === true}
      className={`answer-call ${status === "failed" ? "answer-call--failed" : ""}`}
    >
      <p className="answer-call-summary answer-call-summary--static">
        {status === "failed" ? (
          <span className="answer-call-icon flex items-center justify-center">
            <ProblemMark className="" />
          </span>
        ) : (
          <SkillIcon
            className={`answer-call-icon ${status === "running" ? "animate-pulse" : ""}`}
          />
        )}
        <span className="answer-call-text">{summary}</span>
        {use?.forced && <span className="answer-call-note"> · {t("skills.answer.forced")}</span>}
      </p>
      {reads.length > 0 && (
        <ul className="answer-call-files">
          {reads.map((read) => (
            <li key={read.id} data-testid="answer-skill-file" data-status={read.status}>
              {read.status === "failed"
                ? t("skills.answer.readFailed", { path: field(read, "path") })
                : t("skills.answer.read", { path: field(read, "path") })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How many calculated figures an Answer shows, and how many it couldn't, from its one `calculate` call. */
export function figuresOf(calls: readonly AnswerToolCall[]): {
  calculated: number;
  uncalculated: number;
} {
  const call = calls.find(isCalculated);
  return { calculated: call?.resultCount ?? 0, uncalculated: call?.uncalculated ?? 0 };
}

/** Under an Answer whose figures some couldn't be calculated: their numbers are missing from its text. */
export function UncalculatedLine({ count }: { count: number }) {
  const t = useT();
  return (
    <p contentEditable={false} data-testid="answer-uncalculated" className="answer-info">
      {count === 1
        ? t("answer.figures.uncalculated.one")
        : t("answer.figures.uncalculated", { count })}
    </p>
  );
}

/** The searches an Answer ran, summed up on its meta line; it opens the list. */
function SearchesSummary({
  searches,
  open,
  onToggle,
}: {
  searches: AnswerToolCall[];
  open: boolean;
  onToggle(): void;
}) {
  const t = useT();
  const running = searches.some((call) => call.status === "running");
  const failed = searches.every((call) => call.status === "failed");
  const summary = running ? t("search.running") : failed ? t("search.failed") : t("search.done");
  return (
    <span data-testid="answer-tools" className="answer-searches">
      <button
        type="button"
        data-testid="answer-tools-toggle"
        aria-expanded={open}
        aria-label={`${summary}. ${t("search.details")}`}
        onClick={onToggle}
        className={`answer-meta-button ${running ? "animate-pulse" : ""}`}
      >
        <span>{summary}</span>
        {searches.length > 1 && <span>· {t("search.count", { count: searches.length })}</span>}
        <ChevronRightSmallIcon className="answer-meta-chevron" />
      </button>
    </span>
  );
}

/**
 * What each search was for and what it found, then how many figures the
 * Answer calculated (ADR-0021), which have no Tool-call card.
 */
function SearchList({
  searches,
  calculated = 0,
}: {
  searches: AnswerToolCall[];
  calculated?: number;
}) {
  const t = useT();
  const results = (call: AnswerToolCall) =>
    call.status === "failed"
      ? t("search.failed")
      : call.resultCount === null
        ? null
        : call.resultCount === 0
          ? t("search.noResults")
          : call.resultCount === 1
            ? t("search.results.one")
            : t("search.results", { count: call.resultCount });
  return (
    <ul className="answer-searches-list">
      {searches.map((call) => {
        const query = typeof call.input.query === "string" ? call.input.query : "";
        const found = results(call);
        return (
          <li key={call.id} data-testid="answer-tool-call" data-status={call.status}>
            {t("search.query", { query })}
            {found && <span className="answer-searches-found"> · {found}</span>}
          </li>
        );
      })}
      {calculated > 0 && (
        <li data-testid="answer-figures">
          {calculated === 1
            ? t("answer.figures.calculated.one")
            : t("answer.figures.calculated", { count: calculated })}
        </li>
      )}
    </ul>
  );
}
