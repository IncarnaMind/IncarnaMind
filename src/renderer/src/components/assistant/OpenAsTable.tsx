import type { Editor } from "@tiptap/react";
import { type RefObject, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { NodeJSON } from "../../../../shared/blockJson";
import { TABLE_SLOT_CLASS, TABLE_SLOT_INDEX, tablesOf } from "../../editor/answerTables";
import { ExpandIcon } from "../../editor/icons";
import { useT } from "../../i18n";
import { scrollsSideways } from "../useTableFades";

interface TableSlot {
  slot: HTMLElement;
  wide: boolean;
}

function useTableSlots(frame: RefObject<HTMLElement | null>): TableSlot[] {
  const [slots, setSlots] = useState<TableSlot[]>([]);
  useEffect(() => {
    const root = frame.current;
    if (!root) return;
    const find = () => {
      const found = [...root.querySelectorAll<HTMLElement>(`.${TABLE_SLOT_CLASS}`)].map((slot) => {
        const table = slot.nextElementSibling;
        return { slot, wide: table instanceof HTMLElement && scrollsSideways(table) };
      });
      setSlots((shown) =>
        shown.length === found.length &&
        shown.every((each, at) => each.slot === found[at]?.slot && each.wide === found[at]?.wide)
          ? shown
          : found,
      );
    };
    find();
    const changed = new MutationObserver(find);
    changed.observe(root, { childList: true, subtree: true });
    const resized = new ResizeObserver(find);
    resized.observe(root);
    return () => {
      changed.disconnect();
      resized.disconnect();
    };
  }, [frame]);
  return slots;
}

/**
 * An icon-only Expand on the top-right corner of each table wider than the Answer, greyed out
 * and still the first Tab stop until the Answer is written. It takes no layout space, so a table
 * that widens while rows arrive gains it without moving (DESIGN.md, Answers).
 */
export function OpenAsTable({
  frame,
  editor,
  streaming,
  onOpen,
}: {
  frame: RefObject<HTMLElement | null>;
  editor: Editor;
  streaming: boolean;
  onOpen(table: NodeJSON): void;
}) {
  const t = useT();
  const slots = useTableSlots(frame);
  return slots.map(({ slot, wide }) => {
    if (!wide) return null;
    const index = Number(slot.getAttribute(TABLE_SLOT_INDEX));
    return createPortal(
      <>
        <span aria-hidden className="answer-table-fade" />
        <button
          type="button"
          data-testid="answer-open-table"
          className="answer-table-open"
          aria-label={t("answer.table.open")}
          title={t("answer.table.open")}
          aria-disabled={streaming}
          // Keeps a selection in the Answer as it is.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (streaming) return;
            const table = tablesOf(editor.state.doc)[index];
            if (table) onOpen(table);
          }}
        >
          <ExpandIcon className="size-3.5" />
        </button>
      </>,
      slot,
      `table-${index}`,
    );
  });
}
