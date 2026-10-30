import { useMemo } from "react";
import type { CommandDone, CommandItem, ConversationAnswer } from "../../../../core/api";
import type { Yours } from "../../../../shared/commands";
import { keptWords, undoRun, useCommandRuns } from "../../assistantCommands";
import { commandCallText, commandRuns, runText, undoable, yoursWordsOf } from "../../commandFacts";
import { files } from "../../core";
import { LIBRARY_DELETED } from "../../deletedItems";
import { showFileLabelKey } from "../../fileInfo";
import { openFolderMenu } from "../../folderMenu";
import { useT } from "../../i18n";
import type { Translate } from "../../objects";
import { useAppStore } from "../../store";
import { CheckLineIcon, ShieldLineIcon } from "../lineIcons";
import { Dot } from "./AskedChangesCard";

const ITEMS_SHOWN = 8;

const itemText = (item: CommandItem) =>
  item.renamed ? `${item.name} → ${item.renamed}` : item.name;

function madeLines(t: Translate, done: readonly CommandDone[]): string[] {
  return done.flatMap((each) =>
    // A move into a Folder it made says so in its line already; so does a new Folder or Tag.
    each.into?.made &&
    !each.window &&
    each.command !== "document.moveTo" &&
    each.command !== "mind.moveTo" &&
    each.command !== "folder.new" &&
    each.command !== "tag.new"
      ? [
          t(each.into.kind === "folder" ? "commands.made.folder" : "commands.made.tag", {
            name: each.into.name,
          }),
        ]
      : [],
  );
}

/**
 * The card under the reply of an Answer that ran commands (#1110): for each Run, what changed,
 * from what the commands returned ("Renamed 3 Documents · Moved 2 Documents to “Real estate” ·
 * Undo"), then each thing changed, a rename as its old and new names. Undo takes back the whole
 * Run, as ⌘Z does; a file saved can be shown where it is. A command that failed, or that the User
 * didn't allow, says so on a line of its own.
 */
export function CommandsCard({
  answer,
  streaming,
}: {
  answer: Pick<ConversationAnswer, "id" | "toolCalls">;
  streaming: boolean;
}) {
  const t = useT();
  const runs = useMemo(() => commandRuns(answer), [answer]);
  const unrun = answer.toolCalls.filter(
    (call) => call.tool === "run_command" && call.status === "failed",
  );
  const yours = [
    ...new Map(
      answer.toolCalls.flatMap((call) => {
        const done = call.command;
        return done?.yours
          ? [[`${done.yours} ${done.folder?.id ?? ""}`, { what: done.yours, folder: done.folder }]]
          : [];
      }),
    ).values(),
  ];
  const { here, undone, kept } = useCommandRuns();
  const changed = runs.filter(({ done }) => done.some((each) => !each.yours));
  if (streaming || (changed.length === 0 && unrun.length === 0 && yours.length === 0)) return null;
  return (
    <section data-testid="command-changes" className="mind-changes">
      {yours.map(({ what, folder }) => (
        <YoursLine key={`${what} ${folder?.id ?? ""}`} what={what} folder={folder} />
      ))}
      {unrun.map((call) => (
        <div key={call.id} data-testid="command-changes-unrun" className="mind-changes-head">
          <p className="mind-changes-line mind-changes-count">{commandCallText(t, call)}</p>
        </div>
      ))}
      {changed.map(({ run, done: all }) => {
        const done = all.filter((each) => !each.yours);
        // What only showed, or made the Folder or Tag its line names, lists nothing under it.
        const items = done.flatMap((each) =>
          each.command === "mind.export" ||
          each.command === "folder.new" ||
          each.command === "tag.new" ||
          each.window ||
          each.setting
            ? []
            : each.items,
        );
        const saved = done.flatMap((each) => (each.file ? [each.file] : []));
        const lines = [...madeLines(t, done), ...items.slice(0, ITEMS_SHOWN).map(itemText)];
        const more = items.length - Math.min(items.length, ITEMS_SHOWN);
        const going = done.every((each) => each.window?.running);
        return (
          <div key={run} data-run={run}>
            <div className="mind-changes-head">
              {going ? (
                <span aria-hidden="true" className="mind-changes-icon" />
              ) : (
                <CheckLineIcon aria-hidden="true" className="mind-changes-icon" />
              )}
              <p className="mind-changes-line">
                <span
                  data-testid="command-changes-title"
                  title={saved.map((file) => file.path).join("\n") || undefined}
                  className="mind-changes-title"
                >
                  {runText(t, done)}
                </span>
                {undone[run] ? (
                  <>
                    <Dot />
                    <span data-testid="command-changes-undone" className="mind-changes-count">
                      {t("mindChanges.undone")}
                    </span>
                    {(kept[run]?.length ?? 0) > 0 && (
                      <span data-testid="command-changes-kept" className="mind-changes-count">
                        {" "}
                        {keptWords(kept[run] ?? [])(t)}
                      </span>
                    )}
                  </>
                ) : (
                  here[run] &&
                  undoable(done) && (
                    <>
                      <Dot />
                      <button
                        type="button"
                        data-testid="command-changes-undo"
                        onClick={() => void undoRun(run)}
                        className="mind-changes-review"
                      >
                        {t("edit.applied.undo")}
                      </button>
                    </>
                  )
                )}
                {saved.map((file) => (
                  <span key={file.path}>
                    <Dot />
                    <button
                      type="button"
                      data-testid="command-changes-show"
                      onClick={() =>
                        void files
                          .showSavedFile(file.path)
                          .catch(useAppStore.getState().reportError)
                      }
                      className="mind-changes-review"
                    >
                      {t(showFileLabelKey(navigator.platform))}
                    </button>
                  </span>
                ))}
              </p>
            </div>
            {done.map((each) =>
              each.command === "documents.organize" && each.into ? (
                <OrganizeLine
                  key={`${run}-organize`}
                  ids={each.items.map((item) => item.id)}
                  folderId={each.into.id}
                  folder={each.into.name}
                  undone={undone[run] === true}
                />
              ) : null,
            )}
            {lines.map((line, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: two things changed may have the same name.
                key={index}
                data-testid="command-changes-item"
                className="mind-changes-row"
              >
                <span className="mind-changes-name" title={line}>
                  {line}
                </span>
              </div>
            ))}
            {more > 0 && (
              <div data-testid="command-changes-more" className="mind-changes-row">
                <span className="mind-changes-count">{t("commands.more", { count: more })}</span>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function openYours(what: Yours): void {
  const app = useAppStore.getState();
  switch (what) {
    case "keys":
      app.openSettings("models");
      return;
    case "privacy":
      app.openSettings("privacy", "local-mode");
      return;
    case "approvals":
      app.openSettings("privacy");
      return;
    case "spending":
      app.openSettings("general");
      return;
    case "permanent":
      app.openLibrary(LIBRARY_DELETED);
      return;
  }
}

/**
 * A request for what only the User changes (#1421): one line saying it is theirs and where it
 * is, with the one button that opens that page when it is a page. Nothing changed.
 */
function YoursLine({ what, folder }: { what: Yours; folder?: CommandDone["folder"] }) {
  const t = useT();
  const { said, open } = yoursWordsOf(what, folder);
  return (
    <div data-testid="command-yours" data-yours={what} className="mind-changes-head">
      <ShieldLineIcon aria-hidden="true" className="mind-changes-icon" />
      <p className="mind-changes-line">
        <span className="mind-changes-title">{t(said, { folder: folder?.name ?? "" })}</span>
        {open !== null && (
          // The dot goes with its button when the line wraps.
          <span className="whitespace-nowrap">
            <Dot />
            <button
              type="button"
              data-testid="command-yours-open"
              onClick={() => (folder ? openFolderMenu(folder.id) : openYours(what))}
              className="mind-changes-review"
            >
              {t(open)}
            </button>
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * How Organize's sorting of what the assistant asked for goes (#1421), from the Library as it is:
 * reading, then how many wait in To review for the Folder the request named, with Review; none
 * moves until the User accepts it there.
 */
function OrganizeLine({
  ids,
  folderId,
  folder,
  undone,
}: {
  ids: readonly string[];
  folderId: string;
  folder: string;
  undone: boolean;
}) {
  const t = useT();
  const assignments = useAppStore((state) => state.library?.assignments);
  const { reading, waiting, elsewhere } = useMemo(() => {
    const mine = new Set(ids);
    const rows = (assignments ?? []).filter((each) => mine.has(each.documentId));
    return {
      reading: rows.some((each) => each.status === "pending" || each.status === "classifying"),
      waiting: rows.filter((each) => each.suggested && each.groupId === folderId).length,
      elsewhere: rows.filter((each) => each.suggested && each.groupId !== folderId).length,
    };
  }, [assignments, ids, folderId]);
  if (undone || ids.length === 0) return null;
  const said = reading
    ? t("commands.organize.reading")
    : waiting === 0 && elsewhere === 0
      ? t("commands.organize.none", { folder })
      : [
          ...(waiting > 0
            ? [
                t(waiting === 1 ? "commands.organize.waiting.one" : "commands.organize.waiting", {
                  count: waiting,
                  folder,
                }),
              ]
            : []),
          ...(elsewhere > 0
            ? [
                t(
                  elsewhere === 1
                    ? "commands.organize.elsewhere.one"
                    : "commands.organize.elsewhere",
                  { count: elsewhere },
                ),
              ]
            : []),
        ].join(" · ");
  return (
    <div
      data-testid="command-organize"
      data-reading={reading || undefined}
      className="mind-changes-row"
    >
      <span className="mind-changes-count">{said}</span>
      {!reading && waiting + elsewhere > 0 && (
        <>
          <Dot />
          <button
            type="button"
            data-testid="command-organize-review"
            onClick={() => useAppStore.getState().openLibrary("review")}
            className="mind-changes-review"
          >
            {t("library.review.review")}
          </button>
        </>
      )}
    </div>
  );
}
