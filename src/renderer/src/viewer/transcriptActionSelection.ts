import { type RefObject, useEffect, useState } from "react";
import type { TextRange } from "../../../core/api";
import { paletteOpen } from "../commands/handles";
import { markQuote, textNodes } from "./domQuote";
import { selectionEnd } from "./selectedText";
import type { PartRow } from "./transcriptTurnRows";

export function useTranscriptActionSelection(
  list: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [selected, setSelected] = useState<{
    lineId: string;
    lineText: string;
    excerpt: TextRange;
    anchor: { contextElement: Element; getBoundingClientRect(): DOMRect };
  } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setSelected(null);
      return;
    }
    const read = () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) {
        if (
          !paletteOpen.current &&
          !document.activeElement?.closest(
            '[data-testid="transcript-line-actions"], [data-testid="transcript-line-menu"], [data-transcript-selection]',
          )
        )
          setSelected(null);
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      const line = element?.closest<HTMLElement>("[data-line]");
      if (!line?.dataset.line || !list.current?.contains(line)) {
        if (!paletteOpen.current) setSelected(null);
        return;
      }
      const lineText = line.textContent ?? "";
      const prefix = range.cloneRange();
      prefix.selectNodeContents(line);
      prefix.setEnd(range.startContainer, range.startOffset);
      const start = prefix.toString().length;
      const words = range.toString();
      const end = start + words.length;
      if (!words.trim() || lineText.slice(start, end) !== words) {
        setSelected(null);
        return;
      }
      setSelected({
        lineId: line.dataset.line,
        lineText,
        excerpt: { start, end },
        anchor: { contextElement: line, getBoundingClientRect: () => selectionEnd(range) },
      });
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [enabled, list]);
  return [selected, () => setSelected(null)] as const;
}

export function markTranscriptExcerpt(
  lines: HTMLElement[],
  parts: readonly PartRow[],
  bounds: { startMs: number; endMs: number; part?: true },
  excerpt: TextRange,
  words: string,
) {
  const rows = parts.filter((row) => {
    const at = bounds.part ? row.part : row.cue;
    return at.startMs === bounds.startMs && at.endMs === bounds.endMs;
  });
  const first = rows[0];
  if (!first || rows.length !== lines.length || rows.some((row) => row.cue !== first.cue))
    return null;
  const original = bounds.part ? first.part.text : first.cue.text;
  if (original.slice(excerpt.start, excerpt.end) !== words) return null;
  return lines.flatMap((line, index) => {
    const row = rows[index];
    if (!row || row.id !== line.dataset.line || line.textContent !== row.part.text) return [];
    const offset = bounds.part ? 0 : original.indexOf(row.part.text, row.part.at);
    if (offset < 0) return [];
    const start = Math.max(0, excerpt.start - offset);
    const end = Math.min(row.part.text.length, excerpt.end - offset);
    return start < end
      ? (markQuote(textNodes(line), row.part.text.slice(start, end), { start, end }) ?? [])
      : [];
  });
}
