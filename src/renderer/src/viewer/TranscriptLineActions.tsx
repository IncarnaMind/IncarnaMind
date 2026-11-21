import { useRef } from "react";
import { clockTime } from "../../../shared/clock";
import { MoreLineIcon } from "../components/lineIcons";
import { menuClass, menuItemClass } from "../components/ui";
import { usePopoverMenu } from "../components/usePopoverMenu";
import { useT } from "../i18n";
import type { PartRow } from "./transcriptTurnRows";

export function TranscriptLineActions({
  row,
  focusedRow,
  top,
  onPointerEnter,
  onAddToNote,
  onAddAction,
  focusLine,
}: {
  row: PartRow;
  focusedRow: PartRow | undefined;
  top: number;
  onPointerEnter(): void;
  onAddToNote(row: PartRow): void;
  onAddAction(row: PartRow): void;
  focusLine(id: string): void;
}) {
  const t = useT();
  const menu = usePopoverMenu({ align: "end", focus: "first" });
  const picked = useRef(row);
  const select = (run: (row: PartRow) => void) => {
    menu.close();
    focusLine(picked.current.id);
    run(picked.current);
  };
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        tabIndex={focusedRow ? 0 : -1}
        data-testid="transcript-line-actions"
        data-quote-skip=""
        aria-label={t("transcript.action.menu.line", {
          time: clockTime(row.part.startMs),
          text: row.part.text,
        })}
        title={t("transcript.action.menu")}
        onPointerEnter={onPointerEnter}
        onClick={(event) => {
          picked.current = event.detail === 0 ? (focusedRow ?? row) : row;
        }}
        style={{ marginTop: top }}
        className="transcript-add transcript-line-actions"
      >
        <MoreLineIcon className="size-3.5" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("transcript.action.menu")}
        data-testid="transcript-line-menu"
        data-quote-skip=""
        className={menuClass}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => select(onAddToNote)}
          className={`${menuItemClass} pl-2`}
        >
          {t("transcript.addToNote")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => select(onAddAction)}
          className={`${menuItemClass} pl-2`}
        >
          {t("transcript.action.add")}
        </button>
      </div>
    </>
  );
}
