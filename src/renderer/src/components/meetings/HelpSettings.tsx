import { type KeyboardEvent, useEffect, useId, useState } from "react";
import type { CallHelpModel, ChatModelChoice, Settings } from "../../../../core/api";
import {
  defaultHelpKeys,
  type HelpShortcut,
  helpKeysOf,
  helpShortcutLabel,
  helpShortcutsOn,
  isGlobalKeys,
} from "../../../../shared/meetingHelp";
import { SAYS_HIDDEN_FROM_SHARES } from "../../../../shared/meetingPanel";
import { loadCallHelpOffer, useCallHelpOffer } from "../../callHelpOffer";
import { keysHere } from "../../commands/keymap";
import { files } from "../../core";
import { useT } from "../../i18n";
import { quickNotesHere } from "../../meetingHelp";
import { useModelInUse } from "../../modelInUse";
import { useModelNames } from "../../modelNames";
import { useSettingsTarget } from "../../settingsTarget";
import { useAppStore } from "../../store";
import { PopUpButton } from "../settings/PopUpButton";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitchRow,
} from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";

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
function ShortcutRow({ kind, device }: { kind: HelpShortcut; device: Settings["device"] }) {
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
    const by = helpShortcutsOn(!quickNotesHere()).find(
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
    <SettingsRow
      data-testid="help-keys-row"
      label={name}
      control={
        <>
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
            data-recording={recording ? "" : undefined}
            aria-label={t("meetings.settings.keysChange", { name })}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onClick={() => {
              setProblem(null);
              setRecording(true);
            }}
            onBlur={() => setRecording(false)}
            onKeyDown={(event) => void onKeyDown(event)}
            className={`${buttonStyle("secondary", "sm")} min-w-24 data-recording:border-accent data-recording:text-ink-meta`}
          >
            {recording
              ? t("meetings.settings.keysPress")
              : keys
                ? keysHere(keys)
                : t("meetings.settings.keysNone")}
          </button>
        </>
      }
    >
      {problem && (
        <p
          id={`${id}-problem`}
          role="alert"
          data-testid="help-keys-problem"
          className="text-[12px] leading-[18px] text-ink-secondary"
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
    </SettingsRow>
  );
}

const MODEL_TARGET = ["call-help-model"] as const;

/**
 * Which model call help answers on (#2526): the Answers model, by default, or its provider's quick
 * model, which replies in about a second but cites less carefully. Shown where a quick model is
 * offered for the model a new Note answers on, and while Fastest is chosen, so it can be undone.
 */
function CallHelpModelRow() {
  const t = useT();
  const labelId = useId();
  const detailId = useId();
  const chosen = useAppStore((state) => state.settings?.user.callHelpModel);
  const answers = useModelInUse(null);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const fastest = useCallHelpOffer((state) => state.fastest);
  useEffect(loadCallHelpOffer, []);
  const names = useModelNames();
  const shown = !!chosen && !!answers && (fastest !== null || chosen === "fastest");
  const row = useSettingsTarget<HTMLDivElement>(MODEL_TARGET, shown, () =>
    queueMicrotask(() =>
      row.current
        ?.querySelector<HTMLButtonElement>('[data-testid="call-help-model"]')
        ?.focus({ preventScroll: true }),
    ),
  );
  if (!shown || !chosen || !answers) return null;
  const nameOf = ({ modelId, providerId }: ChatModelChoice) => names(modelId, providerId).name;
  return (
    <SettingsRow
      ref={row}
      data-testid="call-help-model-row"
      label={t("meetings.settings.helpModel")}
      labelId={labelId}
      tip={t("meetings.settings.helpModel.tip")}
      detail={
        fastest
          ? t("meetings.settings.helpModel.trade")
          : t("meetings.settings.helpModel.notOffered", { model: nameOf(answers) })
      }
      detailId={detailId}
      control={
        <PopUpButton<CallHelpModel>
          value={chosen}
          options={[
            {
              value: "answers",
              label: t("meetings.settings.helpModel.answers", { model: nameOf(answers) }),
            },
            {
              value: "fastest",
              label: fastest
                ? t("meetings.settings.helpModel.fastest", { model: nameOf(fastest) })
                : t("meetings.settings.helpModel.fastestUnnamed"),
            },
          ]}
          onChange={(callHelpModel) => void updateSettings({ user: { callHelpModel } })}
          labelledBy={labelId}
          describedBy={detailId}
          testId="call-help-model"
        />
      }
    />
  );
}

/**
 * Settings › Meetings › Help during the call: whether the floating panel shows while a
 * meeting records, whether it is kept out of the User's screen share, the model it answers on,
 * and the buttons' shortcuts.
 */
export function HelpSettings() {
  const t = useT();
  const device = useAppStore((state) => state.settings?.device);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (!device) return null;
  return (
    <div data-testid="help-settings" className="flex flex-col gap-6">
      <SettingsSection title={t("meetings.help.label")}>
        <SettingsGroup>
          <SettingsSwitchRow
            label={t("meetings.callHelp.show")}
            detail={t("meetings.settings.panelBody")}
            checked={device.meetingPanel}
            onChange={(meetingPanel) => void updateSettings({ device: { meetingPanel } })}
            switchTestId="help-panel-setting"
          />
          {SAYS_HIDDEN_FROM_SHARES && (
            <SettingsSwitchRow
              label={t("meetings.settings.hidden")}
              detail={t("meetings.panel.hidden")}
              checked={device.meetingPanelHidden}
              onChange={(meetingPanelHidden) =>
                void updateSettings({ device: { meetingPanelHidden } })
              }
              switchTestId="help-hidden-setting"
            />
          )}
          <CallHelpModelRow />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection
        title={t("meetings.settings.keys")}
        help={t(isMac ? "meetings.settings.keysBody.mac" : "meetings.settings.keysBody.other")}
      >
        <SettingsGroup>
          {helpShortcutsOn(!quickNotesHere()).map((kind) => (
            <ShortcutRow key={kind} kind={kind} device={device} />
          ))}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
