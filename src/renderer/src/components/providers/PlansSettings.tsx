import { SHOW_AGENT_CONNECTION } from "../../../../shared/agentConnection";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import {
  buttonStyle,
  rowButtonsClass,
  rowTextClass,
  rowTitleClass,
  ruledListClass,
  ruledRowClass,
  sectionTitleClass,
} from "../ui";
import { ChatGptPlanRow } from "./ChatGptPlanSettings";
import { ClaudePlanRow } from "./ClaudePlan";
import { CopilotPlanRow } from "./CopilotPlan";
import { LocalModeUnavailable } from "./LocalModeUnavailable";

const GOOGLE_CREDITS = "https://developers.google.com/program";

/**
 * Settings → Models → "Already pay for a plan?": the routes for a plan the User already has.
 * ChatGPT (its sign-in lives only here), a Claude account and Copilot sign in; a Google AI plan pays where the User uses IncarnaMind
 * from (Antigravity: Settings → Agents), offered only with the agent connection.
 */
export function PlansSettings() {
  const t = useT();
  const showPage = useAppStore((state) => state.showSettingsPage);
  const row = (title: string, line: string, action: React.ReactNode, extra?: React.ReactNode) => (
    <li className={ruledRowClass}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={rowTitleClass}>{title}</span>
        <span className={rowTextClass}>{line}</span>
        {extra}
      </div>
      <div className={rowButtonsClass}>{action}</div>
    </li>
  );
  return (
    <section data-testid="plans-settings">
      <h4 className={`mb-2 ${sectionTitleClass}`}>{t("plans.title")}</h4>
      <LocalModeUnavailable className="mb-2" />
      <ul className={ruledListClass}>
        <ChatGptPlanRow />
        <ClaudePlanRow />
        <CopilotPlanRow />
        {SHOW_AGENT_CONNECTION && (
          <>
            {row(
              t("plans.claude.title"),
              t("plans.claude.line"),
              <button
                type="button"
                data-testid="plans-claude"
                onClick={() => showPage("agents")}
                className={buttonStyle("secondary", "sm")}
              >
                {t("setup.claude.connect")}
              </button>,
            )}
            {row(
              t("plans.google.title"),
              t("plans.google.line"),
              <button
                type="button"
                data-testid="plans-google"
                onClick={() => showPage("agents")}
                className={buttonStyle("secondary", "sm")}
              >
                {t("plans.google.connect")}
              </button>,
              <a
                href={GOOGLE_CREDITS}
                target="_blank"
                rel="noreferrer"
                className="text-[13px] font-semibold text-accent underline-offset-2 hover:underline"
              >
                {t("plans.google.credits")} ↗
              </a>,
            )}
          </>
        )}
      </ul>
    </section>
  );
}
