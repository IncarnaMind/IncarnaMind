import { useRef } from "react";
import type { Mind } from "../../../../core/api";
import { mindName } from "../../../../shared/naming";
import { timeAgo } from "../../dates";
import { useDraggedRef, useDragSource } from "../../dragDrop";
import { useExports } from "../../exports";
import {
  homeClick,
  useHomeView,
  useMindNoteStates,
  useMindSnippets,
  useOwnMinds,
} from "../../home";
import { useLanguage, useT } from "../../i18n";
import { onMiddleClick } from "../../middleClick";
import { type NoteState, noteStateParts } from "../../noteState";
import { useSelectable } from "../../selection";
import { moveFromMenu, rowDrag } from "../../sidebarMoves";
import { useAppStore } from "../../store";
import { useRename } from "../../useRename";
import { InlineName } from "../InlineName";
import { MindLineIcon } from "../lineIcons";
import { ObjectMenu, useObjectMenu } from "../ObjectMenu";
import { draggedRowClass } from "../sidebarRows";

const FIRST_ROWS = 6;

const TONE_CLASS: Readonly<Record<NoteState["tone"], string>> = {
  neutral: "text-ink-meta",
  warning: "text-warning",
  error: "text-danger",
  success: "text-success",
};

export function RecentMinds({ now }: { now: Date }) {
  const t = useT();
  const minds = useOwnMinds();
  const snippets = useMindSnippets();
  const all = useHomeView((state) => state.all);
  const shown = all ? minds : minds.slice(0, FIRST_ROWS);
  const states = useMindNoteStates(shown);
  if (minds.length === 0) return null;
  return (
    <section data-testid="home-recent" className="mb-7">
      <h2 className="mb-1.5 text-label font-semibold text-ink-meta">{t("home.recent")}</h2>
      {/* biome-ignore lint/a11y/useSemanticElements: rows of a list that selects as the sidebar does, not a table. */}
      <div
        role="grid"
        aria-multiselectable="true"
        aria-label={t("home.recent")}
        className="border-t border-rule"
      >
        {shown.map((mind) => (
          <RecentRow
            key={mind.id}
            mind={mind}
            snippet={snippets.get(mind.id)}
            state={states.get(mind.id) ?? null}
            now={now}
          />
        ))}
      </div>
      {minds.length > FIRST_ROWS && (
        <button
          type="button"
          data-testid="home-recent-all"
          aria-expanded={all}
          onClick={() => useHomeView.setState({ all: !all })}
          className="mt-2 rounded-sm text-[13px] font-semibold text-ink-secondary hover:text-ink"
        >
          {all ? t("home.showFewer") : t("home.seeAll", { count: minds.length })}
        </button>
      )}
    </section>
  );
}

/**
 * A note's own state (D266): "Not checked", "2 need a look", or "Checked 14:25" and, after an
 * export of it in this session, " · exported as Word". It stands where the snippet did: the
 * state is what Home is for.
 */
function stateLine(
  state: NoteState,
  exportedWord: boolean,
  t: ReturnType<typeof useT>,
  language: ReturnType<typeof useLanguage>,
): string {
  const parts = noteStateParts(state, t, language);
  return [
    ...parts,
    ...(state.kind === "checked" && exportedWord ? [t("home.recent.exported")] : []),
  ].join(" · ");
}

function RecentRow({
  mind,
  snippet,
  state,
  now,
}: {
  mind: Mind;
  snippet?: string;
  state: NoteState | null;
  now: Date;
}) {
  const t = useT();
  const language = useLanguage();
  const object = { kind: "mind", id: mind.id } as const;
  const objectMenu = useObjectMenu(object);
  // F2 and the menu rename it here; a double-click would open it before the second click lands.
  const rename = useRename<HTMLButtonElement>(`home-recent:${mind.id}`);
  const folder = useAppStore(
    (state) => state.library?.groups.find((group) => group.id === mind.folderId)?.name ?? "",
  );
  const title = mindName(mind) || t("mind.untitled");
  const row = useRef<HTMLDivElement>(null);
  const exportedWord = useExports(
    (state) =>
      state.result?.state === "saved" &&
      state.result.mindId === mind.id &&
      state.result.format === "docx",
  );
  const openMind = useAppStore((state) => state.openMind);
  const select = useSelectable(object, "home", () => openMind(mind.id));
  const dragSource = useDragSource(() => rowDrag(object, "home"));
  const dragged = useDraggedRef(object);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of a list that selects as the sidebar does, not a table row.
    // biome-ignore lint/a11y/useFocusableInteractive: its name's button takes the focus.
    <div
      ref={row}
      role="row"
      data-testid="home-recent-row"
      data-mind-id={mind.id}
      data-dragging={dragged || undefined}
      {...select.rowProps}
      {...(rename.renaming ? {} : objectMenu.rowProps)}
      {...(rename.renaming ? {} : dragSource)}
      className={`group relative flex min-h-[52px] items-center border-b border-rule ${
        select.selected
          ? "bg-accent-wash"
          : dragged
            ? ""
            : "hover:bg-frame has-[:focus-visible]:bg-frame"
      } ${dragged ? draggedRowClass : ""}`}
    >
      {rename.renaming ? (
        <span className="flex min-w-0 flex-1 items-center gap-3 px-2">
          <MindLineIcon className="size-4 shrink-0 text-ink-meta" />
          <InlineName
            value={mind.title}
            label={t("mind.renameLabel", { title })}
            placeholder={title}
            clearable
            {...rename.field((name) => useAppStore.getState().renameMind(mind.id, name))}
          />
        </span>
      ) : (
        <button
          type="button"
          ref={rename.nameProps.ref}
          data-row-main
          data-testid="home-recent-open"
          title={title}
          onClick={homeClick(select, () => openMind(mind.id))}
          {...onMiddleClick(() => openMind(mind.id, { behind: true }))}
          onKeyDown={rename.nameProps.onKeyDown}
          className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 rounded-sm py-1.5 pr-1 pl-2 text-left -outline-offset-2"
        >
          <MindLineIcon className="size-4 shrink-0 text-ink-meta" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span data-testid="row-text" className="truncate font-semibold text-ink">
              {title}
            </span>
            {state ? (
              <span
                data-testid="home-recent-state"
                data-state={state.kind}
                data-tone={state.tone}
                className={`truncate text-[13px] leading-[18px] ${TONE_CLASS[state.tone]}`}
              >
                {stateLine(state, exportedWord, t, language)}
              </span>
            ) : (
              snippet && (
                <span
                  data-testid="home-recent-snippet"
                  className="truncate text-[13px] leading-[18px] text-ink-meta"
                >
                  {snippet}
                </span>
              )
            )}
          </span>
          <span
            data-testid="home-recent-folder"
            className="max-w-[180px] min-w-0 shrink truncate text-right text-[13px] text-ink-meta @max-[760px]/home:hidden"
          >
            {folder}
          </span>
          <span
            data-testid="home-recent-time"
            className="w-[76px] shrink-0 text-right text-[13px] whitespace-nowrap text-ink-meta @max-[480px]/home:hidden"
          >
            {timeAgo(new Date(mind.updatedAt), now, language, t)}
          </span>
        </button>
      )}
      {!rename.renaming && (
        <div className="shrink-0 pr-1 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <ObjectMenu
            target={object}
            label={t("mind.more", { title })}
            tabIndex={-1}
            here={{
              "mind.rename": rename.start,
              "mind.moveTo": () => moveFromMenu(row.current, object, "home"),
            }}
          />
        </div>
      )}
    </div>
  );
}
