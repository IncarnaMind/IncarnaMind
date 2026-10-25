import { useId, useState } from "react";
import {
  type EmbeddingModelError,
  MODEL_SOURCE_CHOICES,
  type ModelSourceChoice,
  type ModelSourceId,
} from "../../../core/api";
import type { MessageKey } from "../../../shared/i18n";
import { useT } from "../i18n";
import { useAppStore } from "../store";

const SOURCE_NAMES: Record<ModelSourceId, MessageKey> = {
  huggingface: "modelSource.huggingface",
  modelscope: "modelSource.modelscope",
  "hf-mirror": "modelSource.hfMirror",
  r2: "modelSource.copy",
};

const CHOICE_NAMES: Record<ModelSourceChoice, MessageKey> = {
  auto: "modelSource.auto",
  huggingface: "modelSource.huggingface",
  modelscope: "modelSource.modelscope",
};

/** A download that every one of several sources failed (#1578); one source alone says nothing more. */
export const failedEverySource = (error: EmbeddingModelError | null | undefined) =>
  error !== null &&
  error !== undefined &&
  error.kind !== "load" &&
  (error.sources?.length ?? 0) > 1;

/**
 * A failed model download's Details (DESIGN.md, #1578): `toggle` is the line's "Details" part, and
 * `panel`, under the line while open, holds each source's error and "Download source: Automatic ▾".
 * Picking a source keeps it on this device and tries again at once. Both are null unless every
 * one of several sources failed.
 */
export function useDownloadSources(
  error: EmbeddingModelError | null | undefined,
  retry: () => void,
  testId: string,
) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const picked = useAppStore((state) => state.settings?.device.modelSource ?? "auto");
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (!failedEverySource(error)) return { toggle: null, panel: null };
  const tried = error?.sources ?? [];
  const choices = MODEL_SOURCE_CHOICES.filter(
    (choice) => choice === "auto" || tried.some((each) => each.source === choice),
  );
  const toggle = (
    <button
      type="button"
      data-testid={`${testId}-details`}
      aria-expanded={open}
      aria-controls={id}
      onClick={() => setOpen(!open)}
      className="rounded-sm font-semibold text-ink-secondary hover:text-ink"
    >
      {t("modelSource.details")}
    </button>
  );
  const panel = open && (
    <div id={id} data-testid={`${testId}-sources`} className="text-[12px] leading-4 text-ink-meta">
      <ul className="my-1">
        {tried.map((each) => (
          <li key={each.source} className="break-words">
            {t("modelSource.failed", {
              source: t(SOURCE_NAMES[each.source]),
              message: each.message,
            })}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-1.5">
        {t("modelSource.label")}
        <select
          data-testid={`${testId}-source`}
          value={choices.includes(picked) ? picked : "auto"}
          onChange={(event) => {
            const choice = choices.find((each) => each === event.target.value) ?? "auto";
            void updateSettings({ device: { modelSource: choice } }).then(() => {
              if (useAppStore.getState().settings?.device.modelSource === choice) retry();
            });
          }}
          className="rounded-sm border border-rule-strong bg-sheet px-1 py-0.5 text-ink"
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {t(CHOICE_NAMES[choice])}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
  return { toggle, panel };
}
