import type { HTMLAttributes, ReactNode } from "react";
import { dotAfter } from "./metaDot";

/** What a selection across the parts of `line` copies as, on one line: "A · B · C"; null where the browser's copy is right. */
function selectedAsOneLine(line: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!line.contains(range.commonAncestorContainer)) return null;
  const copy = range.cloneContents();
  if (copy.children.length < 2 || copy.querySelector("ul")) return null;
  return [...copy.children]
    .map((part) => {
      part.querySelector(":scope > .meta-dot")?.remove();
      return part.textContent?.trim() ?? "";
    })
    .filter(Boolean)
    .reduce((text, part) => `${text}${dotAfter(text)}${part}`);
}

/**
 * A line of parts joined by middle dots ("Checked 4 claims · 3 need a look ·
 * Check again"). It wraps only between parts, and no line starts or ends with
 * a dot: each dot is drawn in the gap before its part and clipped where that
 * part starts a line (`.meta-line` in styles.css). Use it, or `.meta-line`
 * and `.meta-part` on a flex row, wherever parts are joined by dots.
 * After a full-width stop or closing bracket the text reads "。· 重试", as Chinese sets it.
 * `children` follow the parts as flex items of the row, for a part that
 * draws its own dot because a list opens under it (`.mind-unread`).
 */
export function MetaLine({
  parts,
  as: Tag = "p",
  className = "",
  children,
  ...rest
}: { parts: readonly ReactNode[]; as?: "p" | "div" } & HTMLAttributes<HTMLElement>) {
  const shown = parts.filter(
    (part) => part !== null && part !== undefined && part !== false && part !== "",
  );
  return (
    <Tag
      {...rest}
      className={`meta-line ${className}`}
      onCopy={(event) => {
        const text = selectedAsOneLine(event.currentTarget);
        if (text === null) return;
        event.clipboardData.setData("text/plain", text);
        event.preventDefault();
      }}
    >
      {shown.map((part, index) => {
        const before = shown[index - 1];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts have no identity, and the line is rebuilt whole.
          <span key={index} className="meta-part">
            {index > 0 && (
              <span className="meta-dot" aria-hidden="true">
                {typeof before === "string" ? dotAfter(before) : " · "}
              </span>
            )}
            {part}
          </span>
        );
      })}
      {children}
    </Tag>
  );
}
