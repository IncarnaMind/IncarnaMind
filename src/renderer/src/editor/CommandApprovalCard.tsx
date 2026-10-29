import { useId } from "react";
import {
  COMMAND_AT_ONCE,
  type CommandApprovalRequest,
  type CommandAsk,
  type CommandItem,
  RECENTLY_DELETED_DAYS,
} from "../../../core/api";
import type { CommandId } from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import { useApprovals } from "../approvals";
import { cameFromText } from "../commandFacts";
import { commands, labelOf } from "../commands/registry";
import { FORMAT_LABELS } from "../exports";
import { useT } from "../i18n";
import { folderName } from "../linkedFolders";
import type { Translate } from "../objects";
import { withShortcut } from "./withShortcut";

type Change = Extract<CommandAsk, { kind: "change" }>;

/** A change's question, for several things, then for one. */
const CHANGE: Readonly<Partial<Record<CommandId, [MessageKey, MessageKey]>>> = {
  "document.rename": [
    "commands.ask.change.document.rename",
    "commands.ask.change.document.rename.one",
  ],
  "mind.rename": ["commands.ask.change.mind.rename", "commands.ask.change.mind.rename.one"],
  "document.moveTo": [
    "commands.ask.change.document.moveTo",
    "commands.ask.change.document.moveTo.one",
  ],
  "mind.moveTo": ["commands.ask.change.mind.moveTo", "commands.ask.change.mind.moveTo.one"],
  "document.tags": ["commands.ask.change.document.tags", "commands.ask.change.document.tags.one"],
  "document.delete": [
    "commands.ask.change.document.delete",
    "commands.ask.change.document.delete.one",
  ],
  "mind.delete": ["commands.ask.change.mind.delete", "commands.ask.change.mind.delete.one"],
  "folder.delete": ["commands.ask.change.folder.delete", "commands.ask.change.folder.delete.one"],
  "tag.delete": ["commands.ask.change.tag.delete", "commands.ask.change.tag.delete.one"],
};

function labelIn(t: Translate, id: CommandId): string {
  const command = commands.get(id);
  return command ? labelOf(command, { selection: [], focus: null, surface: "palette" }, t) : id;
}

function whyOf(t: Translate, ask: Change): string {
  if (ask.reason === "delete") {
    return t(ask.count === 1 ? "commands.ask.why.delete.one" : "commands.ask.why.delete", {
      days: RECENTLY_DELETED_DAYS,
    });
  }
  return t(ask.changed > 0 ? "commands.ask.why.many.changed" : "commands.ask.why.many", {
    max: COMMAND_AT_ONCE,
    changed: ask.changed,
  });
}

/** A thing by the name the User knew, and the one the Conversation gave it. */
const itemLine = (t: Translate, item: CommandItem) =>
  item.renamed === undefined
    ? item.name
    : t("commands.ask.item.renamed", { name: item.name, renamed: item.renamed });

/** The card's question, why it asks, the path it reaches (if any) and the names it lists. */
function wordsOf(
  t: Translate,
  ask: CommandAsk,
): { title: string; why: string; path: string | null; names: string[] } {
  switch (ask.kind) {
    case "export":
      return {
        title: t("commands.ask.export.title", {
          mind: ask.mind.name,
          format: t(FORMAT_LABELS[ask.format]),
          folder: folderName(ask.folder),
        }),
        why: t("commands.ask.export.text"),
        path: ask.folder,
        names: [ask.fileName],
      };
    case "add":
      return {
        title:
          ask.files.length === 1
            ? t("commands.ask.add.title.one", { folder: folderName(ask.folder) })
            : t("commands.ask.add.title", {
                folder: folderName(ask.folder),
                count: ask.files.length,
              }),
        why: t("commands.ask.add.text"),
        path: ask.folder,
        names: ask.files,
      };
    case "final":
      return {
        title: t("commands.ask.final.title", { command: labelIn(t, ask.command) }),
        why: t("commands.ask.final.text"),
        path: null,
        names: ask.items.map((item) => itemLine(t, item)),
      };
    case "listen":
      return {
        title: t("commands.ask.final.title", { command: labelIn(t, ask.command) }),
        why: t("commands.ask.listen.text"),
        path: null,
        names: [],
      };
    case "output":
      return {
        title: t("commands.ask.output.title", { folder: folderName(ask.folder) }),
        why: t("commands.ask.output.text"),
        path: ask.folder,
        names: [],
      };
    case "change": {
      const [many, one] = CHANGE[ask.command] ?? [
        "commands.ask.change.other",
        "commands.ask.change.other.one",
      ];
      const into = ask.into ?? "";
      const [first] = ask.items;
      const more = ask.count - ask.items.length;
      return {
        title: t(ask.count === 1 ? one : many, {
          count: ask.count,
          name: first?.name ?? "",
          folder: into,
          tag: into,
          command: labelIn(t, ask.command),
        }),
        why: whyOf(t, ask),
        path: null,
        // One thing is named in the title, unless the Conversation renamed it.
        names:
          ask.count === 1 && first?.renamed === undefined
            ? []
            : [
                ...ask.items.map((item) => itemLine(t, item)),
                ...(more > 0 ? [t("commands.more", { count: more })] : []),
              ],
      };
    }
  }
}

/**
 * A command of the assistant's waiting for the User (#1110), as the approval cards are: what it
 * would do, saving a Mind as a file outside the Output location, reading a folder's files to add
 * them, or a change inside IncarnaMind that needs their say, and why it asks; whether the
 * assistant had read text the User didn't write; the folder and the names it reaches; and Allow
 * or Don't allow, for a delete Delete or Don't delete (DESIGN.md, Approval). Never "always":
 * each such call asks.
 */
export function CommandApprovalCard({
  request,
  keys,
}: {
  request: CommandApprovalRequest;
  keys?: string;
}) {
  const t = useT();
  const respond = useApprovals((state) => state.respond);
  const titleId = useId();
  const { ask } = request;
  const { title, why, path, names } = wordsOf(t, ask);
  const deletes = ask.kind === "change" && ask.reason === "delete";
  const allow = t(deletes ? "commands.ask.delete" : "commands.ask.allow");
  const read = request.tainted || (request.thirdParty?.length ?? 0) > 0;
  return (
    <div
      contentEditable={false}
      role="alertdialog"
      aria-labelledby={titleId}
      data-testid="approval-card"
      data-tool={request.tool}
      data-kind="command"
      data-ask={ask.kind}
      data-reason={ask.kind === "change" ? ask.reason : undefined}
      className="approval-card"
    >
      <div className="approval-head">
        <p id={titleId} className="approval-title">
          <span aria-hidden="true" className="approval-dot" />
          <span className="approval-title-text">{title}</span>
        </p>
        {request.cameFrom && (
          <p data-testid="approval-came-from" className="approval-came-from">
            {cameFromText(t, request.cameFrom)}
          </p>
        )}
        <p className="approval-explanation">{why}</p>
        {read && (
          <p data-testid="approval-read" className="approval-explanation">
            {t("commands.ask.read")}
          </p>
        )}
      </div>
      {(path !== null || names.length > 0) && (
        <div className="approval-details">
          {/* A path has no spaces to wrap at: it breaks anywhere rather than widen the card. */}
          {path !== null && (
            <p data-testid="approval-folder" className="approval-label break-all">
              {path}
            </p>
          )}
          <ul
            data-testid="approval-files"
            className="approval-args max-h-40 list-none overflow-y-auto"
          >
            {names.map((name, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two Documents may have the same name.
              <li key={index} data-testid="approval-file">
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="approval-actions">
        <button
          type="button"
          data-testid="approval-allow-once"
          onClick={() => respond(request.requestId, "allow-once")}
          className="approval-button approval-button--primary"
          {...withShortcut(allow, keys)}
        >
          {allow}
          {keys && <span className="approval-keys">{keys}</span>}
        </button>
        <button
          type="button"
          data-testid="approval-deny"
          onClick={() => respond(request.requestId, "deny")}
          className="approval-button approval-button--ghost"
        >
          {t(deletes ? "commands.ask.keep" : "commands.ask.deny")}
        </button>
      </div>
    </div>
  );
}
