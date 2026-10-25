import { useEffect, useState } from "react";
import type { ApprovalPolicy } from "../../../core/api";
import { core } from "../core";
import { useT } from "../i18n";
import { skillTitle } from "../skills";
import { useAppStore } from "../store";
import {
  buttonStyle,
  pageIntroClass,
  rowStatusClass,
  rowTitleClass,
  ruledListClass,
  ruledRow,
} from "./ui";

/**
 * Settings → Privacy → Approvals: every policy that replaces a default, so the User
 * can tighten permissions later. Each Tool always allowed, each Tool set to
 * ask every time (even one its Connector says only reads), and (#41) each
 * Skill whose scripts always run; each can be revoked, back to the default.
 * Rows split by rules, with the policy on the right.
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
    <section data-testid="approvals-settings" className="flex flex-col gap-4">
      <p className={pageIntroClass}>{t("approvals.settings.body")}</p>
      {policies.length === 0 ? (
        <p className={`${rowStatusClass} border-y border-rule py-3.5`}>
          {t("approvals.settings.empty")}
        </p>
      ) : (
        <ul className={ruledListClass}>
          {policies.map((policy) => {
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
              <li
                key={policy.id}
                data-testid="approval-policy"
                data-policy={policy.policy}
                className={ruledRow("center")}
              >
                <span className={`min-w-0 truncate ${rowTitleClass}`} title={name}>
                  {subject.kind === "tool" ? (
                    <>
                      {policy.ownerName}
                      <span className="font-normal text-ink-meta"> · </span>
                      <span className="font-mono text-[13px] font-medium">{subject.tool}</span>
                    </>
                  ) : (
                    name
                  )}
                </span>
                <span className="flex items-center gap-3">
                  <span data-testid="approval-policy-value" className={rowStatusClass}>
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
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
