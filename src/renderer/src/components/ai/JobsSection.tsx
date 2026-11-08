import { useCallback, useId } from "react";
import type {
  ChatModelGroup,
  ChatProvider,
  ModelRoles,
  RerankSettings,
} from "../../../../core/api";
import { modelName } from "../../../../shared/modelName";
import { searchesTheWeb } from "../../../../shared/webSearch";
import { useLanguage, useT } from "../../i18n";
import type { SettingsTarget } from "../../settingsPages";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import type { ServicesView } from "../../transcriptionServices";
import { TranscriptionRouteSelect } from "../meetings/TranscriptionRouteSelect";
import { TranscriptionRouteConsent } from "../meetings/TranscriptionSettings";
import { useTranscriptionSetUp } from "../meetings/TranscriptionSetUp";
import { ModelHealthLine, useModelHealthFailure } from "../providers/ModelHealthLine";
import type { useSorting } from "../providers/SortingChoice";
import { providerLabel } from "../providers/shared";
import {
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "../settings/SettingsGroup";
import { DocumentSearchRows } from "./DocumentSearchRows";
import { OrganizeRows } from "./OrganizeRow";
import { popUpWidth, type Role, RoleSelect, useModelRoles } from "./RoleSelect";

/**
 * Settings › AI › What each job uses: one row and one picker per job, and no other place chooses
 * it. `services`, `sorting` and `rerank`: the page's one read of each.
 */
export function JobsSection({
  groups,
  providers,
  services,
  sorting,
  rerank,
  onRerank,
}: {
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
  services: ServicesView;
  sorting: ReturnType<typeof useSorting>;
  rerank: RerankSettings | null;
  onRerank(rerank: RerankSettings): void;
}) {
  const t = useT();
  const id = useId();
  const roles = useModelRoles(groups);
  const health = useModelHealthFailure();
  return (
    <SettingsSection title={t("ai.jobs.title")} testId="ai-jobs">
      <SettingsGroup>
        <ModelRow
          id={`${id}-answers`}
          job="chatModel"
          label={t("ai.jobs.answers")}
          line={t("ai.jobs.answers.line")}
          tip={t("ai.jobs.answers.tip")}
          groups={groups}
          providers={providers}
          roles={roles}
        >
          {health && <ModelHealthLine />}
        </ModelRow>
        <ModelRow
          id={`${id}-quick`}
          job="quickTasksModel"
          label={t("ai.jobs.quick")}
          line={t("ai.jobs.quick.line")}
          groups={groups}
          providers={providers}
          roles={roles}
        />
        <ModelRow
          id={`${id}-images`}
          job="imageModel"
          label={t("ai.jobs.images")}
          line={t("ai.jobs.images.line")}
          groups={groups}
          providers={providers}
          roles={roles}
        />
        <OrganizeRows id={`${id}-organize`} sorting={sorting} />
        <TranscriptionRow id={`${id}-meetings`} services={services} />
        <DocumentSearchRows
          id={`${id}-search`}
          providers={providers}
          rerank={rerank}
          setRerank={onRerank}
        />
        <WebSearchRow id={`${id}-web`} />
      </SettingsGroup>
      <SettingsHelp className="flex flex-col gap-1">
        <TranscriptionRouteConsent read={services} />
        <p data-testid="ai-jobs-foot">{t("ai.jobs.foot")}</p>
      </SettingsHelp>
    </SettingsSection>
  );
}

const ANSWERS: readonly SettingsTarget[] = ["chat-model"];
const NONE: readonly SettingsTarget[] = [];

function ModelRow({
  id,
  job,
  label,
  line,
  tip,
  groups,
  providers,
  roles,
  children,
}: {
  id: string;
  job: Role;
  label: string;
  line: string;
  tip?: string;
  groups: readonly ChatModelGroup[];
  providers: readonly ChatProvider[];
  roles: ModelRoles | null;
  children?: React.ReactNode;
}) {
  const focusPicker = useCallback(() => document.getElementById(id)?.focus(), [id]);
  const reached = useSettingsTarget<HTMLDivElement>(
    job === "chatModel" ? ANSWERS : NONE,
    true,
    focusPicker,
  );
  return (
    <SettingsRow
      ref={reached}
      data-testid={`model-default-row-${job}`}
      label={label}
      htmlFor={id}
      detail={line}
      detailId={`${id}-line`}
      tip={tip}
      tipId={`${id}-tip`}
      control={
        <RoleSelect
          id={id}
          job={job}
          groups={groups}
          providers={providers}
          roles={roles}
          describedBy={tip === undefined ? `${id}-line` : `${id}-line ${id}-tip`}
        />
      }
    >
      {children}
    </SettingsRow>
  );
}

const TRANSCRIPTION: readonly SettingsTarget[] = ["transcription"];

/** Where meetings are transcribed, with "Set up another transcription service" at its picker's foot. */
function TranscriptionRow({ id, services }: { id: string; services: ServicesView }) {
  const t = useT();
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const setUp = useTranscriptionSetUp(id, services);
  const reached = useSettingsTarget<HTMLDivElement>(TRANSCRIPTION, true, () =>
    document.getElementById(id)?.focus(),
  );
  return (
    <SettingsRow
      ref={reached}
      data-testid="model-default-row-transcription"
      data-read-host
      label={t("ai.jobs.transcription")}
      htmlFor={id}
      detail={t("ai.jobs.transcription.line")}
      control={
        <TranscriptionRouteSelect
          id={id}
          popUp
          grouped
          className={popUpWidth}
          localOnly={localOnly}
          read={services}
          setUp={setUp.rows}
          onChosen={setUp.onChosen}
        />
      }
    >
      {setUp.panel}
    </SettingsRow>
  );
}

const WEB: readonly SettingsTarget[] = ["web-search"];

/**
 * Search the web in Answers (#128): a switch, off by default, through the Answers model's own
 * search. A line says whether that model has one, or that Local mode keeps it off.
 */
function WebSearchRow({ id }: { id: string }) {
  const t = useT();
  const language = useLanguage();
  const on = useAppStore((state) => state.settings?.user.webSearch);
  const localOnly = useAppStore((state) => state.embedding?.localOnly === true);
  const readiness = useAppStore((state) => state.chatReadiness);
  const updateSettings = useAppStore((state) => state.updateSettings);

  const reached = useSettingsTarget<HTMLDivElement>(WEB, on !== undefined, () =>
    document.getElementById(id)?.focus({ preventScroll: true }),
  );
  if (on === undefined) return null;
  const provider = readiness && "provider" in readiness ? readiness.provider : null;
  const model = readiness && "modelId" in readiness ? readiness.modelId : null;
  const status = localOnly
    ? t("web.settings.localMode")
    : provider && model
      ? t(searchesTheWeb(provider.kind) ? "web.settings.supported" : "web.settings.unsupported", {
          model: modelName(model, { kind: provider.kind, endpoint: provider.endpoint }),
          provider: providerLabel(provider, t, language),
        })
      : null;
  return (
    <SettingsRow
      ref={reached}
      data-testid="web-search-settings"
      label={t("ai.jobs.web")}
      htmlFor={id}
      detail={
        <>
          <span className="block">{t("ai.jobs.web.line")}</span>
          {on && status && (
            <span data-testid="web-search-status" role="status" className="block">
              {status}
            </span>
          )}
        </>
      }
      control={
        <SettingsSwitch
          id={id}
          checked={on}
          onChange={(next) => void updateSettings({ user: { webSearch: next } })}
          testId="web-search-switch"
        />
      }
    />
  );
}
