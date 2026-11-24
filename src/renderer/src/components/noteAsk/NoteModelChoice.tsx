import { useEffect, useState } from "react";
import type { NoteModel } from "../../../../core/api";
import { core } from "../../core";
import { useT } from "../../i18n";
import { useNoteAsks, useNoteColumns, useNoteTrails } from "../../ownAiInNote";
import { useAppStore } from "../../store";
import { CheckLineIcon, ChevronRightLineIcon } from "../lineIcons";
import { menuClass } from "../ui";
import { usePopoverMenu } from "../usePopoverMenu";
import { shortModel } from "./NoteColumn";

/**
 * The model this Note's conversation runs on, inside its input before Send (#3677), from the list
 * the User's AI gave a request's run: nothing until a request has run since IncarnaMind started.
 * While a request runs it shows the model and can't be changed.
 */
export function NoteModelChoice({ mindId, busy }: { mindId: string; busy: boolean }) {
  const t = useT();
  const [models, setModels] = useState<readonly NoteModel[]>([]);
  const chosen = useNoteColumns((state) => state.model[mindId]);
  const menu = usePopoverMenu({ align: "end", side: "above" });
  // A run hears the list before it names its model, so each run that names one, and each that
  // ends, may bring a list.
  const runsNamed = useNoteTrails(
    (state) => Object.values(state.byTurn).filter((trail) => trail.model !== null).length,
  );
  const ended = useNoteAsks((state) => state.byMind[mindId]?.state !== "working");
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again as each run names its model and as it ends.
  useEffect(() => {
    let current = true;
    core.noteModels(mindId).then((listed) => {
      if (!current) return;
      setModels(listed);
      // A model no longer offered isn't sent: the agent's own default answers instead.
      const { model } = useNoteColumns.getState();
      const kept = model[mindId];
      if (kept !== undefined && !listed.some((each) => each.value === kept)) {
        const { [mindId]: _gone, ...rest } = model;
        useNoteColumns.setState({ model: rest });
      }
    }, useAppStore.getState().reportError);
    return () => {
      current = false;
    };
  }, [mindId, runsNamed, ended]);
  if (models.length === 0) return null;
  const current = models.find((each) => each.value === chosen) ?? models[0];
  const label = current?.resolvedModel
    ? shortModel(current.resolvedModel)
    : (current?.displayName ?? "");
  const named = `${t("noteColumn.model")}: ${label}`;
  if (models.length === 1) {
    return (
      <span data-testid="note-ask-model-only" className="note-ask-model" title={named}>
        <span className="note-ask-model-name">{label}</span>
      </span>
    );
  }
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="note-ask-model"
        aria-label={named}
        title={busy ? t("noteAsk.modelBusy") : named}
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        className="note-ask-model note-ask-model--button"
      >
        <span className="note-ask-model-name">{label}</span>
        <ChevronRightLineIcon className="size-3 flex-none rotate-90" aria-hidden="true" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("noteColumn.model")}
        data-testid="note-ask-models"
        className={menuClass}
      >
        {menu.open &&
          models.map((each) => (
            <button
              key={each.value}
              type="button"
              role="menuitemradio"
              aria-checked={each.value === current?.value}
              onClick={() => {
                menu.close();
                useNoteColumns.setState((state) => ({
                  model: { ...state.model, [mindId]: each.value },
                }));
              }}
              className="note-column-model-item"
            >
              <span className="note-column-model-check">
                {each.value === current?.value && <CheckLineIcon className="size-3.5" />}
              </span>
              <span className="flex min-w-0 flex-col items-start">
                <span className="text-ink">{each.displayName}</span>
                <span className="text-ink-meta">{each.description}</span>
              </span>
            </button>
          ))}
      </div>
    </>
  );
}
