import { useMemo } from "react";
import type { CommandDone, CommandItem, ConversationAnswer } from "../../../../core/api";
import { type Yours, yoursWordsOf } from "../../../../shared/commands";
import { keptWords, undoRun, useCommandRuns } from "../../assistantCommands";
import {
  checkWaiting,
  commandCallText,
  commandRuns,
  refusalsOf,
  runText,
  saidInReply,
  undoable,
} from "../../commandFacts";
import { files } from "../../core";
import { LIBRARY_DELETED } from "../../deletedItems";
import { showFileLabelKey } from "../../fileInfo";
import { openFolderMenu } from "../../folderMenu";
import { useT } from "../../i18n";
import { useMindCheck } from "../../mindCheck";
import type { Translate } from "../../objects";
import { openReview } from "../../organizeReview";
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
 * Run, as ⌘Z does; a file saved can be shown where it is, and what Organize proposed opens in
 * its Review (#1569). A command that failed, or that the User
 * didn't allow, says so on a line of its own.
 */
export function CommandsCard({
  answer,
  streaming,
}: {
  answer: Pick<ConversationAnswer, "id" | "text" | "toolCalls">;
  streaming: boolean;
}) {
  const t = useT();
  const asking = useMindCheck((state) => state.asking);
  const runs = useMemo(() => commandRuns(answer), [answer]);
  const unrun = answer.toolCalls.filter(
    (call) => call.tool === "run_command" && call.status === "failed",
  );
  // A refusal the reply already says keeps only its button, so it is said once; one with no
  // button then shows nothing here.
  const yours = refusalsOf(answer).flatMap((each) => {
    const said = saidInReply(answer.text, each.what, each.folder);
    return said && yoursWordsOf(each.what, each.folder).open === null ? [] : [{ ...each, said }];
  });
  const { here, undone, kept } = useCommandRuns();
  const changed = runs.filter(({ done }) => done.some((each) => !each.yours));
  if (streaming || (changed.length === 0 && unrun.length === 0 && yours.length === 0)) return null;
  return (
    <section data-testid="command-changes" className="mind-changes">
      {yours.map(({ what, folder, said }) => (
        <YoursLine key={`${what} ${folder?.id ?? ""}`} what={what} folder={folder} inReply={said} />
      ))}
      {unrun.map((call) => (
        <div key={call.id} data-testid="command-changes-unrun" className="mind-changes-head">
          <p className="mind-changes-line mind-changes-count">{commandCallText(t, call)}</p>
        </div>
      ))}
      {changed.map(({ run, done: all }) => {
        const done = all.filter((each) => !each.yours);
        // A Check alone, waiting on the Note's question, says so until the answer changes its line.
        const waits = done.length === 1 && checkWaiting(done, asking);
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
        const proposed = !undone[run] && done.some((each) => (each.review?.count ?? 0) > 0);
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
                  {waits ? t("mindCheck.waitingForOk") : runText(t, done)}
                </span>
                {proposed && (
                  <>
                    <Dot />
                    <span
                      data-testid="command-changes-nothing-moved"
                      className="mind-changes-count"
                    >
                      {t("organizeReview.nothingMoved")}
                    </span>
                  </>
                )}
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
                {proposed && (
                  <>
                    <Dot />
                    <button
                      type="button"
                      data-testid="command-changes-review"
                      onClick={openReview}
                      className="mind-changes-review"
                    >
                      {t("library.review")}
                    </button>
                  </>
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
      app.openSettings("ai");
      return;
    case "privacy":
      app.openSettings("ai", "local-mode");
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
 * is, with the one button that opens that page when it is a page; only the button when the reply
 * says it (`inReply`). Nothing changed.
 */
function YoursLine({
  what,
  folder,
  inReply,
}: {
  what: Yours;
  folder?: CommandDone["folder"];
  inReply: boolean;
}) {
  const t = useT();
  const { said, open } = yoursWordsOf(what, folder);
  return (
    <div data-testid="command-yours" data-yours={what} className="mind-changes-head">
      <ShieldLineIcon aria-hidden="true" className="mind-changes-icon" />
      <p className="mind-changes-line">
        {!inReply && (
          <span className="mind-changes-title">{t(said, { folder: folder?.name ?? "" })}</span>
        )}
        {open !== null && (
          // The dot goes with its button when the line wraps.
          <span className="whitespace-nowrap">
            {!inReply && <Dot />}
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
