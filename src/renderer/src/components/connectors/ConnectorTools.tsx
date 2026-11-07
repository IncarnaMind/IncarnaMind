import { useId } from "react";
import type {
  ApprovalPolicy,
  ApprovalPolicyValue,
  ConnectorDirectoryEntry,
  ConnectorTool,
} from "../../../../core/api";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { PopUpButton } from "../settings/PopUpButton";
import { SettingsGroup, SettingsHelp, SettingsRow } from "../settings/SettingsGroup";

/** What the User chooses for a Tool: ask before each call, run without asking, or leave it out. */
const choices = ["ask", "always", "off"] as const;
type Choice = (typeof choices)[number];

/**
 * Whether Answers ask before calling a Tool: the User's policy, or else the
 * default for what its Connector claims (a Tool that says it only reads doesn't ask).
 */
export function asksFirst(tool: ConnectorTool, policy: ApprovalPolicyValue | undefined): boolean {
  return policy === "ask" || (policy === undefined && !tool.readOnly);
}

/**
 * What a connected Connector can do: each Tool, what it claims (only reads,
 * or may change things, as the Connector says; IncarnaMind can't check), and
 * whether Answers ask before calling it, call it without asking, or don't
 * use it at all, which the User chooses.
 */
export function ConnectorTools({
  connectorId,
  tools,
  policies,
}: {
  connectorId: string;
  tools: ConnectorTool[];
  policies: ApprovalPolicy[];
}) {
  const t = useT();
  const policyOf = (tool: ConnectorTool) =>
    policies.find(
      (policy) =>
        policy.subject.kind === "tool" &&
        policy.subject.connectorId === connectorId &&
        policy.subject.tool === tool.name,
    )?.policy;
  const choose = (tool: ConnectorTool, choice: Choice) => {
    // The default for what the Tool claims needs no policy.
    const policy: ApprovalPolicyValue | null =
      choice === "off" ? "off" : (choice === "ask") === !tool.readOnly ? null : choice;
    core
      .setApprovalPolicy({ subject: { kind: "tool", connectorId, tool: tool.name }, policy })
      .catch((failure: unknown) => useAppStore.getState().reportError(failure));
  };
  if (tools.length === 0) {
    return <p className="px-4 text-[13px] leading-5 text-ink-meta">{t("connectors.tools.none")}</p>;
  }
  return (
    <>
      <SettingsGroup data-testid="connector-tools">
        {tools.map((tool) => {
          const policy = policyOf(tool);
          const ask = asksFirst(tool, policy);
          return (
            <ToolRow
              key={tool.name}
              tool={tool}
              ask={ask}
              chosen={policy === "off" ? "off" : ask ? "ask" : "always"}
              onChoose={(choice) => choose(tool, choice)}
            />
          );
        })}
      </SettingsGroup>
      <SettingsHelp>{t("connectors.tools.note")}</SettingsHelp>
    </>
  );
}

/** One Tool: its name and what it claims, and the pop-up at its end that says what Answers do with it. */
function ToolRow({
  tool,
  ask,
  chosen,
  onChoose,
}: {
  tool: ConnectorTool;
  ask: boolean;
  chosen: Choice;
  onChoose(choice: Choice): void;
}) {
  const t = useT();
  const choiceId = useId();
  return (
    <SettingsRow
      data-testid="connector-tool"
      data-tool={tool.name}
      data-read-only={tool.readOnly}
      data-asks={ask}
      data-off={chosen === "off"}
      title={tool.description}
      label={
        <span data-testid="connector-tool-name" className="break-words">
          {tool.title ?? tool.name}
        </span>
      }
      detail={
        <span data-testid="connector-tool-claim">
          {tool.readOnly
            ? t("connectors.directory.tool.reads")
            : t("connectors.directory.tool.changes")}
        </span>
      }
      control={
        <>
          <span id={choiceId} className="sr-only">
            {t("approvals.tools.select", { tool: tool.name })}
          </span>
          <PopUpButton
            value={chosen}
            options={choices.map((each) => ({ value: each, label: t(`approvals.tools.${each}`) }))}
            onChange={onChoose}
            labelledBy={choiceId}
            testId="connector-tool-approval"
          />
        </>
      }
    />
  );
}

/**
 * A directory entry's Tools as IncarnaMind reviewed them, before the User
 * connects it: each one's name and what it does, with no choice yet, since
 * the choices belong to the Tools the service lists once connected.
 */
export function ReviewedTools({ tools }: { tools: NonNullable<ConnectorDirectoryEntry["tools"]> }) {
  const t = useT();
  const language = useLanguage();
  return (
    <>
      <SettingsGroup data-testid="connector-reviewed-tools">
        {tools.map((tool) => (
          <SettingsRow
            key={tool.title.en}
            data-testid="connector-reviewed-tool"
            label={tool.title[language]}
            detail={
              tool.changes
                ? t("connectors.directory.tool.changes")
                : t("connectors.directory.tool.reads")
            }
          />
        ))}
      </SettingsGroup>
      <SettingsHelp>{t("connectors.directory.what.listed")}</SettingsHelp>
    </>
  );
}
