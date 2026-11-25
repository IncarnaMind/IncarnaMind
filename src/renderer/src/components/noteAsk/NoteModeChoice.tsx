import { useEffect, useState } from "react";
import { NOTE_MODES, type NoteMode } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useNoteAsks } from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { CheckLineIcon, ChevronRightLineIcon } from "../lineIcons";
import { menuClass, menuTitleClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";

/** The modes Claude Code names, each with its own word on the pill. */
const NAMED = new Set(["default", "auto", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]);
const REFUSED = new Set([
  "auto_mode_settings",
  "auto_mode_model",
  "auto_mode_unavailable",
  "auto_mode_circuit_breaker",
  "auto_mode_fast_mode",
]);

const isOffered = (mode: string): mode is NoteMode =>
  (NOTE_MODES as readonly string[]).includes(mode);

/**
 * Whether the User's own AI asks before it acts or works on its own, by the input after the model
 * (#3765). It starts on the User's own settings for the AI and names the mode they say, whichever
 * it is; a choice holds for this conversation only and writes nothing into the AI's own settings,
 * and while a request runs the AI takes it from its next step. Nothing until a request has named
 * the AI's mode.
 */
export function NoteModeChoice({ mindId }: { mindId: string }) {
  const t = useT();
  const agent = useNoteAsks((state) => state.byMind[mindId]?.agent) || "Claude Code";
  const menu = usePopoverMenu({ align: "end", side: "above" });
  const [seen, setSeen] = useState<{
    mode: string | null;
    chosen: boolean;
    refused: string | null;
  }>({ mode: null, chosen: false, refused: null });
  const [reads, setReads] = useState(0);
  // The mode a running request is in, as it names it, and each request's end bring it again.
  const running = useNoteAsks((state) => {
    const ask = state.byMind[mindId];
    return ask?.state === "working" ? (ask.mode ?? "") : null;
  });
  // A choice in another window, or the running request's answer to one, is read here too.
  useEffect(
    () =>
      core.on("agents.noteMode", (changed) => {
        if (changed.mindId === mindId) setReads((count) => count + 1);
      }),
    [mindId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as a run names its mode, as it ends, and as one is chosen.
  useEffect(() => {
    let current = true;
    core.noteModels(mindId).then(({ mode, chosen, refused }) => {
      if (current) setSeen({ mode, chosen, refused });
    }, useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [mindId, running, reads]);
  const mode = seen.mode;
  if (mode === null) return null;
  const nameOf = (each: string) =>
    NAMED.has(each) ? t(`noteAsk.mode.${each}` as MessageKey) : each;
  const choose = (next: NoteMode | null) => {
    menu.close();
    core
      .chooseNoteMode(mindId, next)
      .then(() => setReads((count) => count + 1))
      .catch(useAppStore.getState().reportError);
  };
  const refused = seen.refused
    ? t(
        `noteAsk.mode.refused.${REFUSED.has(seen.refused) ? seen.refused : "other"}` as MessageKey,
        { agent },
      )
    : null;
  const row = (
    testId: string,
    name: string,
    about: string,
    ticked: boolean,
    onPick: () => void,
    note?: string | null,
  ) => (
    <button
      key={testId}
      type="button"
      role="menuitemradio"
      data-testid={testId}
      aria-checked={ticked}
      onClick={onPick}
      className="note-column-model-item"
    >
      <span className="note-column-model-check">
        {ticked && <CheckLineIcon className="size-3.5" />}
      </span>
      <span className="flex min-w-0 flex-col items-start">
        <span className="text-ink">{name}</span>
        <span className="text-ink-meta">{about}</span>
        {note && <span className="text-ink-meta">{note}</span>}
      </span>
    </button>
  );
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="note-ask-mode-choice"
        data-mode={mode}
        title={t("noteAsk.mode.title", { agent })}
        onMouseDown={(event) => event.preventDefault()}
        className="note-ask-model note-ask-model--button"
      >
        <span className="note-ask-model-name">{nameOf(mode)}</span>
        <ChevronRightLineIcon className="size-3 flex-none rotate-90" aria-hidden="true" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("noteAsk.mode.title", { agent })}
        data-testid="note-ask-modes"
        className={`${menuClass} max-w-80`}
      >
        {menu.open && (
          <>
            <p className={menuTitleClass}>{t("noteAsk.mode.title", { agent })}</p>
            {/* The User's own setting for the AI, named as itself when it is neither of the two. */}
            {!seen.chosen &&
              !isOffered(mode) &&
              row(
                "note-ask-mode-yours",
                `${nameOf(mode)} · ${t("noteAsk.mode.yours")}`,
                t("noteAsk.mode.yours.about", { agent }),
                true,
                () => menu.close(),
              )}
            {NOTE_MODES.map((each) =>
              row(
                `note-ask-mode-${each}`,
                nameOf(each),
                t(`noteAsk.mode.${each}.about` as MessageKey),
                mode === each,
                () => choose(each),
                each === "auto" ? refused : null,
              ),
            )}
            {seen.chosen &&
              row(
                "note-ask-mode-yours",
                t("noteAsk.mode.yours"),
                t("noteAsk.mode.yours.about", { agent }),
                false,
                () => choose(null),
              )}
          </>
        )}
      </div>
    </>
  );
}
