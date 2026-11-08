import type { ReactNode } from "react";
import { SettingsGroup, SettingsSection, SettingsSwitchRow } from "./settings/SettingsGroup";

/**
 * Settings → a page → one switch row: what the section is about as its title, the row's own
 * label, what turning it on does (a line or a tip), and the switch at its end.
 */
export function SwitchSetting({
  sectionTestId,
  heading,
  title,
  tip,
  description,
  switchTestId,
  on,
  onChange,
}: {
  sectionTestId: string;
  heading: string;
  title: string;
  tip?: string;
  description?: ReactNode;
  switchTestId: string;
  on: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <SettingsSection title={heading} testId={sectionTestId}>
      <SettingsGroup>
        <SettingsSwitchRow
          label={title}
          tip={tip}
          detail={description}
          checked={on}
          onChange={onChange}
          switchTestId={switchTestId}
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
