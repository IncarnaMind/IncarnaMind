import { useT } from "../i18n";
import { useAppStore } from "../store";
import { SwitchSetting } from "./SwitchSetting";
import { rowTextClass } from "./ui";

export function SavedWebPagesSettings() {
  const t = useT();
  const on = useAppStore((state) => state.settings?.user.keepWebPageLook);
  const updateSettings = useAppStore((state) => state.updateSettings);
  if (on === undefined) return null;
  return (
    <SwitchSetting
      sectionTestId="saved-web-pages-settings"
      heading={t("web.settings.pages.title")}
      title={t("web.settings.keepLook")}
      description={<p className={rowTextClass}>{t("webPages.keepLook.body")}</p>}
      switchTestId="keep-web-page-look-switch"
      on={on}
      onChange={(next) => void updateSettings({ user: { keepWebPageLook: next } })}
    />
  );
}
