import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { TextRange } from "../../../shared/quoteMatch";
import { lowlight } from "../editor/codeLanguages";
import { useT } from "../i18n";
import { loadDocumentPicture } from "./documentPicture";
import { type Block, type Inline, type ListItem, sectionHeadings } from "./markdown";

/** The Markdown Document shown, whose pictures beside it its images load. */
export const MarkdownDocumentContext = createContext<string | null>(null);

/** What every part of a rendered Markdown file needs: its source, the quote's ranges, its headings. */
interface Rendering {
  source: string;
  highlight: readonly TextRange[];
  /** Section headings' indexes among the file's headings, which the outline and Citations go to. */
  headings: ReadonlyMap<Block, number>;
}

/** A span of the source, with the parts inside `highlight` (ranges in order) marked. */
export function Slice({
  source,
  start,
  end,
  highlight,
}: {
  source: string;
  start: number;
  end: number;
  highlight: readonly TextRange[];
}) {
  const inside = highlight.filter((range) => range.end > start && range.start < end);
  // Where it starts in the file, so a selection reads the file's own characters (`sourceSelection`).
  if (inside.length === 0) return <span data-at={start}>{source.slice(start, end)}</span>;
  const parts: ReactNode[] = [];
  let at = start;
  for (const range of inside) {
    const from = Math.max(at, range.start);
    const to = Math.min(end, range.end);
    if (from >= to) continue;
    parts.push(source.slice(at, from));
    // A part split across inlines (e.g. at a line break) joins up square at the seam.
    const joins = `${from > range.start ? " quote-highlight--joins-before" : ""}${
      to < range.end ? " quote-highlight--joins-after" : ""
    }`;
    parts.push(
      <mark key={from} data-quote-highlight="" className={`quote-highlight${joins}`}>
        {source.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  parts.push(source.slice(at, end));
  return <span data-at={start}>{parts}</span>;
}

function renderInlines(inlines: readonly Inline[], rendering: Rendering): ReactNode[] {
  return inlines.map((inline, index) => renderInline(inline, index, rendering));
}

function renderInline(inline: Inline, key: number, rendering: Rendering): ReactNode {
  const { source, highlight } = rendering;
  switch (inline.kind) {
    case "text":
      return (
        <Slice
          key={key}
          source={source}
          start={inline.start}
          end={inline.end}
          highlight={highlight}
        />
      );
    case "code":
      return (
        <code key={key}>
          <Slice source={source} start={inline.start} end={inline.end} highlight={highlight} />
        </code>
      );
    case "strong":
      return <strong key={key}>{renderInlines(inline.children, rendering)}</strong>;
    case "em":
      return <em key={key}>{renderInlines(inline.children, rendering)}</em>;
    case "strike":
      return <del key={key}>{renderInlines(inline.children, rendering)}</del>;
    case "break":
      return <br key={key} />;
    case "image":
      return <MarkdownImage key={key} src={inline.src} alt={inline.alt} />;
    case "link":
      return inline.href ? (
        // Opens in the User's browser: the main process sends every new window there.
        <a key={key} href={inline.href} target="_blank" rel="noreferrer">
          {renderInlines(inline.children, rendering)}
        </a>
      ) : (
        <span key={key}>{renderInlines(inline.children, rendering)}</span>
      );
  }
}

/** Code, highlighted by its language (lowlight, as the Mind's code blocks are), with the quote marked. */
function Code({
  start,
  end,
  language,
  rendering,
}: {
  start: number;
  end: number;
  language: string | undefined;
  rendering: Rendering;
}) {
  const { source, highlight } = rendering;
  const code = source.slice(start, end);
  if (!language || !lowlight.registered(language)) {
    return <Slice source={source} start={start} end={end} highlight={highlight} />;
  }
  // The highlighted tree's text is the code itself, in order: each piece keeps its place in the source.
  let at = start;
  type Node = ReturnType<typeof lowlight.highlight>["children"][number];
  const render = (nodes: readonly Node[]): ReactNode[] =>
    nodes.map((node, index) => {
      if (node.type === "text") {
        const from = at;
        at += node.value.length;
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces never reorder
        return <Slice key={index} source={source} start={from} end={at} highlight={highlight} />;
      }
      if (node.type !== "element") return null;
      const className = node.properties?.className;
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: the pieces never reorder
        <span key={index} className={Array.isArray(className) ? className.join(" ") : undefined}>
          {render(node.children as Node[])}
        </span>
      );
    });
  try {
    return <>{render(lowlight.highlight(language, code).children)}</>;
  } catch {
    return <Slice source={source} start={start} end={end} highlight={highlight} />;
  }
}

function Item({ item, rendering }: { item: ListItem; rendering: Rendering }) {
  return (
    <li className={item.checked === null ? undefined : "document-task"}>
      {item.checked !== null && (
        <input type="checkbox" checked={item.checked} disabled readOnly tabIndex={-1} />
      )}
      {renderInlines(item.inlines, rendering)}
      {item.children.map((child, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks never reorder
        <MarkdownBlock key={index} block={child} rendering={rendering} />
      ))}
    </li>
  );
}

function MarkdownBlock({ block, rendering }: { block: Block; rendering: Rendering }) {
  const { source, highlight } = rendering;
  switch (block.kind) {
    case "heading": {
      const Heading = `h${block.level}` as const;
      return (
        <Heading data-heading={rendering.headings.get(block)}>
          {renderInlines(block.inlines, rendering)}
        </Heading>
      );
    }
    case "paragraph":
      return <p>{renderInlines(block.inlines, rendering)}</p>;
    case "quote":
      return (
        <blockquote>
          {block.blocks.map((child, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the blocks never reorder
            <MarkdownBlock key={index} block={child} rendering={rendering} />
          ))}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the items never reorder
        <Item key={index} item={item} rendering={rendering} />
      ));
      const tasks = block.items.some((item) => item.checked !== null);
      return block.ordered ? (
        <ol start={block.start === 1 ? undefined : block.start}>{items}</ol>
      ) : (
        <ul className={tasks ? "document-tasks" : undefined}>{items}</ul>
      );
    }
    case "verbatim":
      return (
        <pre data-language={block.language}>
          <code>
            <Code
              start={block.start}
              end={block.end}
              language={block.language}
              rendering={rendering}
            />
          </code>
        </pre>
      );
    case "frontMatter":
      return (
        <pre className="document-front-matter">
          <Slice source={source} start={block.start} end={block.end} highlight={highlight} />
        </pre>
      );
    case "table":
      return (
        <div className="document-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, column) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
                  <th key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                    {renderInlines(cell, rendering)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
                <tr key={index}>
                  {row.map((cell, column) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions
                    <td key={column} style={{ textAlign: block.align[column] ?? undefined }}>
                      {renderInlines(cell, rendering)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr />;
  }
}

/** A Markdown file rendered: its blocks, with the quote marked and its section headings numbered. */
export function MarkdownBlocks({
  blocks,
  source,
  highlight,
}: {
  blocks: readonly Block[];
  source: string;
  highlight: readonly TextRange[];
}) {
  const rendering: Rendering = { source, highlight, headings: sectionHeadings(blocks) };
  return (
    <div className="document-markdown">
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the blocks never reorder
        <MarkdownBlock key={index} block={block} rendering={rendering} />
      ))}
    </div>
  );
}

type ImageState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "web" }
  | { kind: "missing" };

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;

/** A picture's path as written in Markdown, as a path in the file's folder: decoded, without "#…". */
function pictureBeside(src: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("/")) return null;
  const path = src.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * An image in a Markdown file: a picture beside the file is shown; one from
 * the web isn't loaded (the app loads nothing from the network to show a
 * Document), so a labelled placeholder stands for it, as for a missing one.
 */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const documentId = useContext(MarkdownDocumentContext);
  const [state, setState] = useState<ImageState>(() =>
    DATA_IMAGE.test(src)
      ? { kind: "ready", url: src }
      : pictureBeside(src) === null || !documentId
        ? { kind: "web" }
        : { kind: "loading" },
  );
  useEffect(() => {
    const path = pictureBeside(src);
    if (DATA_IMAGE.test(src) || path === null || !documentId) return;
    const controller = new AbortController();
    loadDocumentPicture(documentId, path, controller.signal).then(
      (url) => {
        if (!controller.signal.aborted) setState({ kind: "ready", url });
      },
      () => {
        if (!controller.signal.aborted) setState({ kind: "missing" });
      },
    );
    return () => controller.abort();
  }, [src, documentId]);

  if (state.kind === "ready") {
    return (
      <img
        src={state.url}
        alt={alt}
        className="document-image"
        data-testid="viewer-markdown-image"
      />
    );
  }
  if (state.kind === "loading") return <span className="document-image-loading" />;
  return (
    <span
      className="document-image-placeholder"
      data-testid="viewer-markdown-image-placeholder"
      data-reason={state.kind}
      title={src}
    >
      <span className="document-image-placeholder-label">{alt || t("viewer.markdown.image")}</span>
      <span className="document-image-placeholder-note">
        {state.kind === "web" ? t("viewer.markdown.imageWeb") : t("viewer.markdown.imageMissing")}
      </span>
    </span>
  );
}
