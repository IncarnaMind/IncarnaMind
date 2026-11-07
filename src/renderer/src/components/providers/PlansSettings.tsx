import { SHOW_CLAUDE_APP_SETUP, SHOW_GOOGLE_PLAN_SETUP } from "../../../../shared/agentConnection";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsGroup, SettingsRow, SettingsSection } from "../settings/SettingsGroup";
import { buttonStyle } from "../ui";
import { ChatGptPlanRow } from "./ChatGptPlanSettings";
import { ClaudePlanRow } from "./ClaudePlan";
import { CopilotPlanRow } from "./CopilotPlan";
import { LocalModeUnavailable } from "./LocalModeUnavailable";

const GOOGLE_CREDITS = "https://developers.google.com/program";

/**
 * Settings → Models → "Already pay for a plan?": the routes for a plan the User already has.
 * ChatGPT (its sign-in lives only here), a Claude account and Copilot sign in; a Google AI plan pays where the User uses IncarnaMind
 * from (Antigravity: Settings → Agents). Each setup route follows its own availability.
 */
export function PlansSettings() {
  const t = useT();
  const showPage = useAppStore((state) => state.showSettingsPage);
  return (
    <SettingsSection title={t("plans.title")} testId="plans-settings">
      <LocalModeUnavailable className="mb-2" />
      <SettingsGroup role="list">
        <ChatGptPlanRow />
        <ClaudePlanRow />
        <CopilotPlanRow />
        {SHOW_CLAUDE_APP_SETUP && (
          <SettingsRow
            role="listitem"
            label={t("plans.claude.title")}
            detail={t("plans.claude.line")}
            control={
              <button
                type="button"
                data-testid="plans-claude"
                onClick={() => showPage("agents")}
                className={buttonStyle("secondary", "sm")}
              >
                {t("setup.claude.connect")}
              </button>
            }
          />
        )}
        {SHOW_GOOGLE_PLAN_SETUP && (
          <SettingsRow
            role="listitem"
            label={t("plans.google.title")}
            detail={
              <>
                <span className="block">{t("plans.google.line")}</span>
                <a
                  href={GOOGLE_CREDITS}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-accent underline-offset-2 hover:underline"
                >
                  {t("plans.google.credits")} ↗
                </a>
              </>
            }
            control={
              <button
                type="button"
                data-testid="plans-google"
                onClick={() => showPage("agents")}
                className={buttonStyle("secondary", "sm")}
              >
                {t("plans.google.connect")}
              </button>
            }
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
