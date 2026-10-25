import type { ComponentType } from "react";
import type { AnswerToolCall } from "../../../../core/api";
import { commandCallText } from "../../commandFacts";
import { useT } from "../../i18n";
import {
  ExportLineIcon,
  FolderLineIcon,
  PencilLineIcon,
  PlusLineIcon,
  SearchLineIcon,
  TagLineIcon,
  TrashLineIcon,
} from "../lineIcons";

const ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  "document.rename": PencilLineIcon,
  "mind.rename": PencilLineIcon,
  "document.moveTo": FolderLineIcon,
  "mind.moveTo": FolderLineIcon,
  "document.tags": TagLineIcon,
  "document.delete": TrashLineIcon,
  "mind.delete": TrashLineIcon,
  "mind.export": ExportLineIcon,
  "documents.addFromFolder": PlusLineIcon,
};

/**
 * The row of a call of the commands' Tools (#1110): what it found, or what the command did, from
 * what it returned; why it didn't run when it failed or wasn't allowed.
 */
export function CommandCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const text = commandCallText(t, call);
  const command = typeof call.input?.command === "string" ? call.input.command : "";
  const Icon = call.tool === "list_commands" ? SearchLineIcon : (ICONS[command] ?? PencilLineIcon);
  const running = call.status === "running";
  return (
    <div
      contentEditable={false}
      data-testid="answer-command-call"
      data-tool={call.tool}
      data-command={command || undefined}
      data-status={call.status}
      className="answer-call"
    >
      <span className="answer-call-summary answer-call-summary--static">
        <Icon className={`answer-call-icon ${running ? "motion-safe:animate-pulse" : ""}`} />
        <span className="answer-call-text" title={text}>
          {text}
        </span>
      </span>
    </div>
  );
}
