import type { ComponentType } from "react";
import type { AnswerToolCall } from "../../../../core/api";
import { isCommandId } from "../../../../shared/commands";
import { commandCallText } from "../../commandFacts";
import { commands } from "../../commands/registry";
import { useT } from "../../i18n";
import {
  CheckLineIcon,
  ExportLineIcon,
  FolderLineIcon,
  FolderPlusLineIcon,
  OpenBesideLineIcon,
  PencilLineIcon,
  PlusLineIcon,
  SearchLineIcon,
  SettingsLineIcon,
  ShieldLineIcon,
  SortLineIcon,
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
  "documents.organize": SortLineIcon,
  "folder.new": FolderPlusLineIcon,
  "folder.rename": PencilLineIcon,
  "folder.delete": TrashLineIcon,
  "tag.new": TagLineIcon,
  "tag.rename": PencilLineIcon,
  "tag.delete": TrashLineIcon,
  "mind.citationStyle": PencilLineIcon,
  "mind.style": PencilLineIcon,
  "settings.change": SettingsLineIcon,
  "mind.openBeside": OpenBesideLineIcon,
  "document.openBeside": OpenBesideLineIcon,
};

/** A call's icon: its command's own, else the window's command's, else a tick for one done. */
function iconOf(call: AnswerToolCall, command: string): ComponentType<{ className?: string }> {
  if (call.tool === "list_commands") return SearchLineIcon;
  if (call.command?.yours) return ShieldLineIcon;
  const own = ICONS[command];
  if (own) return own;
  const listed = isCommandId(command) ? commands.get(command)?.icon : undefined;
  return listed ?? (call.command?.window ? CheckLineIcon : PencilLineIcon);
}

/**
 * The row of a call of the commands' Tools (#1110): what it found, or what the command did, from
 * what it returned; why it didn't run when it failed or wasn't allowed.
 */
export function CommandCall({ call }: { call: AnswerToolCall }) {
  const t = useT();
  const text = commandCallText(t, call);
  const command = typeof call.input?.command === "string" ? call.input.command : "";
  const Icon = iconOf(call, command);
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
