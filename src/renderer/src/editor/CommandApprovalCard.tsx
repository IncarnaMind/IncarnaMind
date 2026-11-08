import { useEffect, useId, useState } from "react";
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
import { organizeAskWhy, readTextLine } from "../commandFacts";
import { commands, labelOf } from "../commands/registry";
import { FORMAT_LABELS } from "../exports";
import { useGap, useT } from "../i18n";
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
  "documents.organize": ["commands.ask.change.organize", "commands.ask.change.organize.one"],
  "tag.merge": ["commands.ask.change.tag.merge", "commands.ask.change.tag.merge.one"],
};

function labelIn(t: Translate, id: CommandId): string {
  const command = commands.get(id);
  return command ? labelOf(command, { selection: [], focus: null, surface: "palette" }, t) : id;
}

function whyOf(t: Translate, ask: Change, gap: (before: string, after: string) => string): string {
  if (ask.reason === "delete") {
    return t(ask.count === 1 ? "commands.ask.why.delete.one" : "commands.ask.why.delete", {
      days: RECENTLY_DELETED_DAYS,
    });
  }
  if (ask.reason === "organize") return organizeAskWhy(t, gap, ask);
  if (ask.reason === "merge") {
    return ask.merges && ask.merges.length > 1
      ? t("commands.ask.why.merge.groups")
      : t("commands.ask.why.merge", { tag: ask.into ?? "" });
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
  gap: (before: string, after: string) => string,
): { title: string; why: string; path: string | null; names: string[]; fresh: string[] } {
  switch (ask.kind) {
    case "export": {
      const names = [ask.fileName, ...ask.pictures];
      const earlier = new Set(
        ask.previous ? [ask.previous.fileName, ...ask.previous.pictures] : [],
      );
      return {
        title: ask.previous
          ? t("commands.ask.export.changed")
          : t("commands.ask.export.title", {
              mind: ask.mind.name,
              format: t(FORMAT_LABELS[ask.format]),
              folder: folderName(ask.folder),
            }),
        why: t(
          ask.pictures.length > 0 ? "commands.ask.export.why.files" : "commands.ask.export.text",
          { count: ask.pictures.length + 1 },
        ),
        path: ask.folder,
        names,
        fresh: ask.previous ? names.filter((name) => !earlier.has(name)) : [],
      };
    }
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
        fresh: [],
      };
    case "final":
      return {
        title: t("commands.ask.final.title", { command: labelIn(t, ask.command) }),
        why: t("commands.ask.final.text"),
        path: null,
        names: ask.items.map((item) => itemLine(t, item)),
        fresh: [],
      };
    case "listen":
      return {
        title: t("commands.ask.final.title", { command: labelIn(t, ask.command) }),
        why: t("commands.ask.listen.text"),
        path: null,
        names: [],
        fresh: [],
      };
    case "output":
      return {
        title: t("commands.ask.output.title", { folder: folderName(ask.folder) }),
        why: t("commands.ask.output.text"),
        path: ask.folder,
        names: [],
        fresh: [],
      };
    case "change": {
      const [many, one] = CHANGE[ask.command] ?? [
        "commands.ask.change.other",
        "commands.ask.change.other.one",
      ];
      const into = ask.into ?? "";
      const [first] = ask.items;
      const more = ask.count - ask.items.length;
      // A merge into more than one Tag lists the pairs, each once, under one title.
      const merges = ask.merges && ask.merges.length > 1 ? ask.merges : null;
      return {
        title: merges
          ? t("commands.ask.change.tag.merge.groups", { count: ask.count })
          : t(ask.count === 1 ? one : many, {
              count: ask.count,
              name: first?.name ?? "",
              folder: into,
              tag: into,
              command: labelIn(t, ask.command),
            }),
        why: whyOf(t, ask, gap),
        path: null,
        // One thing is named in the title, unless the Conversation renamed it.
        names: merges
          ? merges.map((pair) => `${pair.from} → ${pair.into}`)
          : ask.count === 1 && first?.renamed === undefined
            ? []
            : [
                ...ask.items.map((item) => itemLine(t, item)),
                ...(more > 0 ? [t("commands.more", { count: more })] : []),
              ],
        fresh: [],
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
  const gap = useGap();
  const respond = useApprovals((state) => state.respond);
  const titleId = useId();
  const { ask } = request;
  const { title, why, path, names, fresh } = wordsOf(t, ask, gap);
  const refreshed = ask.kind === "export" && ask.previous !== undefined;
  const [ready, setReady] = useState(!refreshed);
  useEffect(() => {
    if (!refreshed) {
      setReady(true);
      return;
    }
    setReady(false);
    const timer = setTimeout(() => setReady(true), 1_000);
    return () => clearTimeout(timer);
  }, [refreshed]);
  const deletes = ask.kind === "change" && ask.reason === "delete";
  const merges = ask.kind === "change" && ask.reason === "merge";
  const allow = t(
    merges ? "commands.ask.merge" : deletes ? "commands.ask.delete" : "commands.ask.allow",
  );
  const read = request.tainted || (request.thirdParty?.length ?? 0) > 0;
  const readLine = request.readText ? readTextLine(t, request.readText, gap) : null;
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
        {readLine && (
          <p data-testid="approval-read-text" className="approval-read-text">
            {readLine}
          </p>
        )}
        <p className="approval-explanation">{why}</p>
        {read && !readLine && (
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
            className="approval-args max-h-40 list-none grid-cols-1 overflow-y-auto wrap-anywhere"
          >
            {names.map((name, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two Documents may have the same name.
              <li key={index} data-testid="approval-file">
                {name}
                {fresh.includes(name) && (
                  <span
                    data-testid="approval-file-new"
                    className="ml-2 font-semibold text-ink-meta"
                  >
                    {t("commands.ask.export.new")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="approval-actions approval-actions--row">
        <button
          type="button"
          data-testid="approval-deny"
          onClick={() => respond(request.requestId, "deny")}
          className="approval-button approval-button--ghost"
        >
          {t(deletes ? "commands.ask.keep" : "commands.ask.deny")}
        </button>
        <button
          type="button"
          data-testid="approval-allow-once"
          onClick={() => respond(request.requestId, "allow-once")}
          disabled={!ready}
          className="approval-button approval-button--primary"
          {...withShortcut(allow, keys)}
        >
          {allow}
          {keys && <span className="approval-keys">{keys}</span>}
        </button>
      </div>
    </div>
  );
}
