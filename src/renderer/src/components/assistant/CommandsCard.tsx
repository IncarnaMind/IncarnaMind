import { useMemo } from "react";
import type { CommandDone, CommandItem, ConversationAnswer } from "../../../../core/api";
import { keptWords, undoRun, useCommandRuns } from "../../assistantCommands";
import { commandCallText, commandRuns, runText, undoable } from "../../commandFacts";
import { files } from "../../core";
import { showFileLabelKey } from "../../fileInfo";
import { useT } from "../../i18n";
import type { Translate } from "../../objects";
import { useAppStore } from "../../store";
import { CheckLineIcon } from "../lineIcons";
import { Dot } from "./AskedChangesCard";

const ITEMS_SHOWN = 8;

const itemText = (item: CommandItem) =>
  item.renamed ? `${item.name} → ${item.renamed}` : item.name;

function madeLines(t: Translate, done: readonly CommandDone[]): string[] {
  return done.flatMap((each) =>
    each.into?.made
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
  const { here, undone, kept } = useCommandRuns();
  if (streaming || (runs.length === 0 && unrun.length === 0)) return null;
  return (
    <section data-testid="command-changes" className="mind-changes">
      {unrun.map((call) => (
        <div key={call.id} data-testid="command-changes-unrun" className="mind-changes-head">
          <p className="mind-changes-line mind-changes-count">{commandCallText(t, call)}</p>
        </div>
      ))}
      {runs.map(({ run, done }) => {
        const items = done.flatMap((each) => (each.command === "mind.export" ? [] : each.items));
        const saved = done.flatMap((each) => (each.file ? [each.file] : []));
        const lines = [...madeLines(t, done), ...items.slice(0, ITEMS_SHOWN).map(itemText)];
        const more = items.length - Math.min(items.length, ITEMS_SHOWN);
        return (
          <div key={run} data-run={run}>
            <div className="mind-changes-head">
              <CheckLineIcon aria-hidden="true" className="mind-changes-icon" />
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
