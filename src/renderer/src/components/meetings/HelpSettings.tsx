import { type KeyboardEvent, useId, useState } from "react";
import type { Settings } from "../../../../core/api";
import {
  defaultHelpKeys,
  HELP_SHORTCUTS,
  type HelpShortcut,
  helpKeysOf,
  helpShortcutLabel,
  isGlobalKeys,
} from "../../../../shared/meetingHelp";
import { SAYS_HIDDEN_FROM_SHARES } from "../../../../shared/meetingPanel";
import { keysHere } from "../../commands/keymap";
import { files } from "../../core";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  hintClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRow,
  ruledRowClass,
  sectionTitleClass,
} from "../ui";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function keyOf(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter) return letter;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)?.[1];
  if (digit) return digit;
  return /^F(?:[1-9]|1\d|2[0-4])$/.test(code) ? code : null;
}

/** The keys pressed, as an Electron accelerator; null while only modifiers are down. */
function keysPressed(event: KeyboardEvent): string | null {
  const key = keyOf(event.code);
  if (!key) return null;
  return [
    event.metaKey && isMac && "Cmd",
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

type KeysProblem =
  | { kind: "invalid" }
  | { kind: "taken"; by: HelpShortcut }
  | { kind: "inUse"; keys: string };

/**
 * One shortcut: click, then press the new keys; Esc keeps the old ones, Backspace takes the
 * shortcut away. Keys another app holds say so, and the old ones stay.
 */
function KeysField({ kind, device }: { kind: HelpShortcut; device: Settings["device"] }) {
  const t = useT();
  const updateSettings = useAppStore((state) => state.updateSettings);
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<KeysProblem | null>(null);
  const id = useId();
  const keys = helpKeysOf(kind, device.meetingHelpKeys, isMac);
  const standard = defaultHelpKeys(kind, isMac);
  const name = t(helpShortcutLabel(kind));

  const save = (chosen: string) =>
    updateSettings({ device: { meetingHelpKeys: { ...device.meetingHelpKeys, [kind]: chosen } } });

  const onKeyDown = async (event: KeyboardEvent) => {
    if (!recording) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      setRecording(false);
      setProblem(null);
      await save("");
      return;
    }
    const chosen = keysPressed(event);
    if (!chosen) return;
    setRecording(false);
    if (!isGlobalKeys(chosen)) {
      setProblem({ kind: "invalid" });
      return;
    }
    const by = HELP_SHORTCUTS.find(
      (other) => other !== kind && helpKeysOf(other, device.meetingHelpKeys, isMac) === chosen,
    );
    if (by) {
      setProblem({ kind: "taken", by });
      return;
    }
    if (chosen !== keys && !(await files.globalKeysFree(chosen))) {
      setProblem({ kind: "inUse", keys: chosen });
      return;
    }
    setProblem(null);
    await save(chosen);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {keys !== standard && (
          <button
            type="button"
            data-testid={standard ? "help-keys-default" : "help-keys-remove"}
            onClick={() => {
              setProblem(null);
              void save(standard ?? "");
            }}
            className="text-[13px] leading-5 text-accent hover:underline"
          >
            {t(standard ? "meetings.settings.keysDefault" : "meetings.settings.keysRemove")}
          </button>
        )}
        <button
          id={id}
          type="button"
          data-testid="help-keys"
          data-kind={kind}
          aria-label={t("meetings.settings.keysChange", { name })}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onClick={() => {
            setProblem(null);
            setRecording(true);
          }}
          onBlur={() => setRecording(false)}
          onKeyDown={(event) => void onKeyDown(event)}
          className={`h-8 min-w-24 rounded-sm border px-2 text-[13px] leading-5 ${
            recording
              ? "border-accent text-ink-meta"
              : "border-rule-strong bg-sheet text-ink hover:bg-hover"
          }`}
        >
          {recording
            ? t("meetings.settings.keysPress")
            : keys
              ? keysHere(keys)
              : t("meetings.settings.keysNone")}
        </button>
      </div>
      {problem && (
        <p
          id={`${id}-problem`}
          role="alert"
          data-testid="help-keys-problem"
          className="text-right text-[12px] leading-[18px] text-ink-secondary"
        >
          {problem.kind === "invalid" &&
            t(isMac ? "meetings.settings.keysInvalid.mac" : "meetings.settings.keysInvalid.other")}
          {problem.kind === "taken" &&
            t("meetings.settings.keysTaken", { name: t(helpShortcutLabel(problem.by)) })}
          {problem.kind === "inUse" && (
            <>
              {t("meetings.settings.keysInUse")}
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                onClick={() => {
                  setProblem(null);
                  setRecording(true);
                  document.getElementById(id)?.focus();
                }}
                className="font-semibold text-accent hover:underline"
              >
                {t("meetings.settings.keysChooseAnother")}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Settings › Meetings › Help during the call: whether the floating panel shows while a
 * meeting records, whether it is kept out of the User's screen share, and the buttons' shortcuts.
 */
export function HelpSettings() {
  const t = useT();
  const device = useAppStore((state) => state.settings?.device);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const panelId = useId();
  const hiddenId = useId();
  if (!device) return null;
  return (
    <section data-testid="help-settings" className="flex flex-col">
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t("meetings.help.label")}</h4>
      <div className={ruledListClass}>
        <div className={ruledRowClass}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={panelId} className={rowTitleClass}>
              {t("meetings.callHelp.show")}
            </label>
            <p id={`${panelId}-description`} className={rowTextClass}>
              {t("meetings.settings.panelBody")}
            </p>
          </div>
          <input
            id={panelId}
            type="checkbox"
            role="switch"
            aria-checked={device.meetingPanel}
            aria-describedby={`${panelId}-description`}
            data-testid="help-panel-setting"
            checked={device.meetingPanel}
            onChange={(event) =>
              void updateSettings({ device: { meetingPanel: event.target.checked } })
            }
            className="switch"
          />
        </div>
        {SAYS_HIDDEN_FROM_SHARES && (
          <div className={ruledRowClass}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={hiddenId} className={rowTitleClass}>
                {t("meetings.settings.hidden")}
              </label>
              <p id={`${hiddenId}-description`} className={rowTextClass}>
                {t("meetings.panel.hidden")}
              </p>
            </div>
            <input
              id={hiddenId}
              type="checkbox"
              role="switch"
              aria-checked={device.meetingPanelHidden}
              aria-describedby={`${hiddenId}-description`}
              data-testid="help-hidden-setting"
              checked={device.meetingPanelHidden}
              onChange={(event) =>
                void updateSettings({ device: { meetingPanelHidden: event.target.checked } })
              }
              className="switch"
            />
          </div>
        )}
      </div>
      <h5 className={`mt-4 mb-1 ${rowTitleClass}`}>{t("meetings.settings.keys")}</h5>
      <p className={`mb-2 ${hintClass}`}>
        {t(isMac ? "meetings.settings.keysBody.mac" : "meetings.settings.keysBody.other")}
      </p>
      <div className={ruledListClass}>
        {HELP_SHORTCUTS.map((kind) => (
          <div key={kind} data-testid="help-keys-row" className={ruledRow("center")}>
            <span className={rowTextClass}>{t(helpShortcutLabel(kind))}</span>
            <KeysField kind={kind} device={device} />
          </div>
        ))}
      </div>
    </section>
  );
}
