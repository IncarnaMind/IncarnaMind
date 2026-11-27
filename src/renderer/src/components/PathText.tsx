import { Fragment } from "react";

/**
 * A path inside a sentence, in mono: it breaks after each slash (`/` or `\`),
 * and in the middle of a name only when that name alone is wider than the
 * line, so the words around it never break.
 */
export function InlinePath({ path }: { path: string }) {
  return (
    <code className="font-mono text-small [overflow-wrap:anywhere]">
      {[...path.matchAll(/[^/\\]+[/\\]?|[/\\]/g)].map((piece) => (
        <Fragment key={piece.index}>
          {piece[0]}
          <wbr />
        </Fragment>
      ))}
    </code>
  );
}

/**
 * A path on one line that, when it doesn't fit, is cut at its start, so the
 * folder's own name stays in view ("…/Documents/IncarnaMind"); the whole path
 * is its tooltip. The right-to-left box puts the ellipsis on the left; the
 * path inside it stays left to right.
 */
export function PathText({
  path,
  testId,
  className = "",
}: {
  path: string;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      dir="rtl"
      data-testid={testId}
      title={path}
      className={`block min-w-0 truncate text-left ${className}`}
    >
      <span dir="ltr">{path}</span>
    </span>
  );
}
