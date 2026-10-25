import { useId } from "react";
import type { ChatModelGroup, OtherModel } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { modelName } from "../../../../shared/modelName";
import { ChevronDownSmallIcon, ChevronRightSmallIcon } from "../../editor/icons";
import { useT } from "../../i18n";
import { rowTitleClass, ruledListClass } from "../ui";

type Why = OtherModel["why"];

const ROW = "flex min-h-[34px] items-center gap-2.5 py-1";

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

/** What a provider lists beyond its menu, then the ids the User added that it doesn't list; by id, so a tick moves nothing. */
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
        className="flex w-full items-center gap-2.5 py-2.5 text-left"
      >
        <Chevron aria-hidden="true" className="size-4 shrink-0 text-ink-meta" />
        <span className={rowTitleClass}>
          {t("models.other.title")}
          <span className="font-normal text-ink-meta"> · {rows.length}</span>
        </span>
      </button>
      {open && (
        <div id={panelId} className="ml-[26px] flex flex-col gap-3">
          {WHYS.map((why) => {
            const inGroup = rows.filter((row) => row.why === why);
            if (inGroup.length === 0) return null;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a titled list of rows, which a fieldset would box.
              <div key={why} role="group" aria-label={t(WHY_TITLES[why])}>
                <p className="mb-1 text-[12px] leading-4 font-semibold text-ink-meta">
                  {t(WHY_TITLES[why])}
                </p>
                <div className={ruledListClass}>
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
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
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
  if (row.why === "cannot-answer") {
    return (
      <div
        data-testid="other-model"
        data-model={row.id}
        data-unavailable
        className={`${ROW} pl-[26px]`}
      >
        <span
          title={name === row.id ? undefined : row.id}
          className="min-w-0 break-all text-ui text-ink-secondary"
        >
          {name}
        </span>
        <span className="ml-auto shrink-0 text-[13px] leading-5 text-ink-meta">
          {row.reason ? t(REASONS[row.reason]) : null}
        </span>
      </div>
    );
  }
  return (
    <label
      data-testid="other-model"
      data-model={row.id}
      className={`${ROW} cursor-pointer hover:bg-hover`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onToggle(event.target.checked)}
        className="size-4 shrink-0 accent-ink"
      />
      <span
        title={name === row.id ? undefined : row.id}
        className="min-w-0 flex-1 break-all text-ui text-ink"
      >
        {name}
      </span>
      {row.why === "unknown" && (
        <span className="ml-auto shrink-0 text-[13px] leading-5 text-ink-meta">
          {t("models.other.mayNotWork")}
        </span>
      )}
    </label>
  );
}
