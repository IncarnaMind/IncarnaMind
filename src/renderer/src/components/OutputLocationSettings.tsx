import { useEffect, useId, useRef, useState } from "react";
import type { OutputSettings } from "../../../core/api";
import { core } from "../core";
import { errorMessage } from "../errors";
import { translateNow, useT } from "../i18n";
import { folderName } from "../linkedFolders";
import { chooseOutputLocation } from "../outputFiles";
import { useSettingsTarget } from "../settingsTarget";
import { PathText } from "./PathText";
import { ProblemLine } from "./ProblemLine";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./settings/SettingsGroup";
import { buttonStyle } from "./ui";

const TARGET = ["output-location"] as const;

/**
 * Settings → General → Output location: where new files go, the default
 * Documents › IncarnaMind until the User picks another, changed with
 * the system's folder dialog; and, once IncarnaMind has asked about any, the
 * Linked folders it may or may not add files to, each with its switch.
 */
export function OutputLocationSettings() {
  const t = useT();
  const titleId = useId();
  const [settings, setSettings] = useState<OutputSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    core.getOutputSettings().then(
      (loaded) => {
        if (current) setSettings(loaded);
      },
      (failure: unknown) => {
        if (current) setProblem(errorMessage(failure, translateNow));
      },
    );
    const stop = core.on("outputSettings.changed", setSettings);
    return () => {
      current = false;
      stop();
    };
  }, []);

  const changeButton = useRef<HTMLButtonElement>(null);
  const section = useSettingsTarget<HTMLElement>(TARGET, settings !== null, () =>
    changeButton.current?.focus({ preventScroll: true }),
  );

  const change = async (action: () => Promise<OutputSettings | null>) => {
    setProblem(null);
    try {
      const updated = await action();
      if (updated) setSettings(updated);
    } catch (failure) {
      setProblem(errorMessage(failure, t));
    }
  };

  if (!settings) return null;
  const { location, linkedFolders } = settings;

  return (
    <section ref={section} data-testid="output-location-settings" className="flex flex-col gap-6">
      <SettingsSection
        title={t("outputLocation.title")}
        titleId={titleId}
        tip={t("outputLocation.body.tip")}
        help={
          (!location || problem) && (
            <>
              {!location && (
                <span data-testid="output-location-default">{t("outputLocation.default")}</span>
              )}
              {problem && (
                <ProblemLine testId="output-location-problem" className="mt-1">
                  {t("outputLocation.failed", { reason: problem })}
                </ProblemLine>
              )}
            </>
          )
        }
      >
        <SettingsGroup>
          <SettingsRow
            label={
              <PathText
                path={location ?? settings.suggested}
                testId="output-location-path"
                className="font-mono text-[13px] leading-5 text-ink-secondary"
              />
            }
            control={
              <button
                ref={changeButton}
                type="button"
                data-testid="output-location-change"
                aria-describedby={titleId}
                onClick={() => void change(chooseOutputLocation)}
                className={buttonStyle("secondary", "sm")}
              >
                {t("outputLocation.change")}
              </button>
            }
          />
        </SettingsGroup>
      </SettingsSection>
      {linkedFolders.length > 0 && (
        <SettingsSection
          title={t("outputLocation.linked.title")}
          testId="linked-folder-writing"
          help={t("outputLocation.linked.body")}
        >
          <SettingsGroup role="list">
            {linkedFolders.map((each) => (
              <SettingsRow
                key={each.linkedFolderId}
                role="listitem"
                data-testid="linked-folder-writing-row"
                data-allowed={each.allowed}
                label={<span className="block truncate">{folderName(each.path)}</span>}
                detail={<PathText path={each.path} />}
                control={
                  <SettingsSwitch
                    ariaLabel={t("outputLocation.linked.allow", { name: folderName(each.path) })}
                    testId="linked-folder-writing-switch"
                    checked={each.allowed}
                    onChange={(allowed) =>
                      void change(() => core.setLinkedFolderWriting(each.linkedFolderId, allowed))
                    }
                  />
                }
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}
    </section>
  );
}
