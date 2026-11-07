import { type ReactNode, useId } from "react";
import type { ChatModelGroup, OtherModel } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { modelName } from "../../../../shared/modelName";
import { ChevronDownSmallIcon, ChevronRightSmallIcon } from "../../editor/icons";
import { useT } from "../../i18n";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "../settings/SettingsGroup";

type Why = OtherModel["why"];

const WHYS: readonly Why[] = ["unknown", "older", "cannot-answer"];

const WHY_TITLES: Record<Why, MessageKey> = {
  unknown: "models.other.group.unknown",
  older: "models.other.group.older",
  "cannot-answer": "models.other.group.cannotAnswer",
};

const REASONS: Record<NonNullable<OtherModel["reason"]>, MessageKey> = {
  completion: "models.other.reason.completion",
  audio: "models.other.reason.audio",
  "deep-research": "models.other.reason.deepResearch",
  "computer-use": "models.other.reason.computerUse",
};

/** What a provider lists beyond its menu, then the ids the User added that it doesn't list; by id, so a switch moves nothing. */
export const otherRowsOf = (group: ChatModelGroup): OtherModel[] => [
  ...group.other,
  ...group.added
    .filter((id) => !group.other.some((each) => each.id === id))
    .map((id): OtherModel => ({ id, why: "unknown" })),
];

export function OtherModels({
  group,
  open,
  onOpen,
  onToggle,
}: {
  group: ChatModelGroup;
  open: boolean;
  onOpen(open: boolean): void;
  onToggle(modelId: string, inMenu: boolean): void;
}) {
  const t = useT();
  const panelId = useId();
  const rows = otherRowsOf(group);
  if (rows.length === 0) return null;
  const Chevron = open ? ChevronDownSmallIcon : ChevronRightSmallIcon;
  return (
    <section data-testid="other-models-settings">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="other-models-toggle"
        onClick={() => onOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-sm px-4 py-1 text-left text-[13px] leading-5 font-semibold text-ink-secondary hover:text-ink"
      >
        <Chevron aria-hidden="true" className="size-4 shrink-0 text-ink-meta" />
        <span>
          {t("models.other.title")}
          <span className="font-normal text-ink-meta"> · {rows.length}</span>
        </span>
      </button>
      {open && (
        <div id={panelId} className="mt-2 flex flex-col gap-6">
          {WHYS.map((why) => {
            const inGroup = rows.filter((row) => row.why === why);
            if (inGroup.length === 0) return null;
            return (
              <OtherGroup key={why} title={t(WHY_TITLES[why])}>
                {inGroup.map((row) => (
                  <ModelRow
                    key={row.id}
                    row={row}
                    name={modelName(row.id, {
                      kind: group.provider.kind,
                      endpoint: group.provider.endpoint,
                      names: group.names,
                    })}
                    checked={group.added.includes(row.id)}
                    onToggle={(inMenu) => onToggle(row.id, inMenu)}
                  />
                ))}
              </OtherGroup>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OtherGroup({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <SettingsSection title={title} titleId={titleId} titleAs="h5">
      <SettingsGroup role="group" aria-labelledby={titleId}>
        {children}
      </SettingsGroup>
    </SettingsSection>
  );
}

function ModelRow({
  row,
  name,
  checked,
  onToggle,
}: {
  row: OtherModel;
  name: string;
  checked: boolean;
  onToggle(inMenu: boolean): void;
}) {
  const t = useT();
  const id = useId();
  const label = (
    <span title={name === row.id ? undefined : row.id} className="break-words">
      {name}
    </span>
  );
  if (row.why === "cannot-answer") {
    return (
      <SettingsRow
        data-testid="other-model"
        data-model={row.id}
        data-unavailable
        label={label}
        control={
          row.reason ? (
            <span className="text-[13px] leading-5 text-ink-meta">{t(REASONS[row.reason])}</span>
          ) : undefined
        }
      />
    );
  }
  return (
    <SettingsRow
      data-testid="other-model"
      data-model={row.id}
      label={label}
      htmlFor={id}
      control={
        <>
          {row.why === "unknown" && (
            <span className="text-[13px] leading-5 text-ink-meta">
              {t("models.other.mayNotWork")}
            </span>
          )}
          <SettingsSwitch id={id} checked={checked} onChange={onToggle} />
        </>
      }
    />
  );
}
