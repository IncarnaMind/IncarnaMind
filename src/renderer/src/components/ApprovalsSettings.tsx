import { useEffect, useState } from "react";
import type { ApprovalPolicy } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { skillTitle } from "../skills";
import { useAppStore } from "../store";
import { SettingsGroup, SettingsHelp, SettingsRow } from "./settings/SettingsGroup";
import { buttonStyle } from "./ui";

/**
 * Settings → Privacy → Approvals: every policy that replaces a default, so the User
 * can tighten permissions later. Each Tool always allowed, each Tool set to
 * ask every time (even one its Connector says only reads), and (#41) each
 * Skill whose scripts always run; each can be revoked, back to the default.
 * One row each, with the policy at its end.
 */
export function ApprovalsSettings() {
  const t = useT();
  const [policies, setPolicies] = useState<ApprovalPolicy[] | null>(null);

  useEffect(() => {
    core.listApprovalPolicies().then(setPolicies, () => undefined);
    return core.on("approvals.changed", setPolicies);
  }, []);

  if (!policies) return null;
  const revoke = (policy: ApprovalPolicy) =>
    core.revokeApprovalPolicy(policy.id).catch((failure: unknown) => {
      useAppStore.getState().reportError(failure);
    });

  return (
    <div data-testid="approvals-settings">
      <SettingsGroup role={policies.length === 0 ? undefined : "list"}>
        {policies.length === 0 ? (
          <SettingsRow label={t("approvals.settings.empty")} />
        ) : (
          policies.map((policy) => {
            const { subject } = policy;
            const name =
              subject.kind === "tool"
                ? `${policy.ownerName} · ${subject.tool}`
                : t("approvals.settings.skillScripts", { skill: skillTitle(policy.ownerName, t) });
            const value =
              subject.kind === "skill-script"
                ? t("approvals.policy.alwaysRun")
                : policy.policy === "always"
                  ? t("approvals.policy.always")
                  : policy.policy === "off"
                    ? t("approvals.policy.off")
                    : t("approvals.policy.ask");
            return (
              <SettingsRow
                key={policy.id}
                role="listitem"
                data-testid="approval-policy"
                data-policy={policy.policy}
                label={
                  <span className="break-words" title={name}>
                    {subject.kind === "tool" ? (
                      <>
                        {policy.ownerName}
                        <span className="text-ink-meta"> · </span>
                        <span className="font-mono text-[13px] font-medium">{subject.tool}</span>
                      </>
                    ) : (
                      name
                    )}
                  </span>
                }
                control={
                  <>
                    <span data-testid="approval-policy-value" className="text-ui text-ink-meta">
                      {value}
                    </span>
                    <button
                      type="button"
                      data-testid="approval-policy-revoke"
                      aria-label={t("approvals.settings.revokeLabel", { name })}
                      onClick={() => void revoke(policy)}
                      className={buttonStyle("secondary", "sm")}
                    >
                      {t("approvals.settings.revoke")}
                    </button>
                  </>
                }
              />
            );
          })
        )}
      </SettingsGroup>
      <SettingsHelp>{t("approvals.settings.body")}</SettingsHelp>
    </div>
  );
}
