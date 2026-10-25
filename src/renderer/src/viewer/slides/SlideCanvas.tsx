import { type CSSProperties, type ReactNode, useId } from "react";
import type {
  Box,
  ChartItem,
  Fill,
  GroupItem,
  Item,
  Line,
  Paragraph,
  PictureItem,
  Run,
  Shadow,
  ShapeItem,
  SlideDrawing,
  Spacing,
  TableItem,
  TextBody,
} from "../../../../core/documents/formats/pptxDrawing";
import type { TextRange } from "../../../../shared/quoteMatch";
import { useT } from "../../i18n";
import { HighlightedText } from "../highlightedText";
import { ChartView } from "./ChartView";
import { geometryPaths, isLine, isRectangle, textInsets } from "./geometry";
import { cellPath, childPath, runKey } from "./pieces";
import "./slides.css";

/** What drawing a slide needs besides the slide: its pictures, and the quote's parts. */
interface Context {
  images: ReadonlyMap<string, string | null>;
  ranges: ReadonlyMap<string, TextRange[]> | null;
}

/** PowerPoint's single line spacing, as a multiple of the font size. */
const SINGLE_LINE = 1.2;

/**
 * One slide drawn at its own size in CSS pixels (96 dpi), for its frame to
 * scale: its background, then each item in z-order, absolutely placed.
 * Text stays text, in spans a quote's highlight can wrap.
 */
export function SlideCanvas({
  slide,
  width,
  height,
  images,
  ranges,
}: {
  slide: SlideDrawing;
  width: number;
  height: number;
  images: ReadonlyMap<string, string | null>;
  ranges: ReadonlyMap<string, TextRange[]> | null;
}) {
  const context: Context = { images, ranges };
  return (
    <div
      className="slide-canvas"
      style={{ width, height, ...fillStyle(slide.background, images) }}
      data-testid="viewer-slide-canvas"
    >
      {slide.items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a slide's items never reorder
        <ItemView key={index} item={item} path={String(index)} context={context} />
      ))}
    </div>
  );
}

function fillStyle(fill: Fill, images: ReadonlyMap<string, string | null>): CSSProperties {
  switch (fill.kind) {
    case "solid":
      return { background: fill.colour };
    case "gradient":
      return { background: cssGradient(fill) };
    case "image": {
      const url = images.get(fill.part);
      return url ? { backgroundImage: `url("${url}")`, backgroundSize: "100% 100%" } : {};
    }
    case "none":
      return {};
  }
}

function cssGradient(fill: Extract<Fill, { kind: "gradient" }>): string {
  const stops = fill.stops
    .map((stop) => `${stop.colour} ${Math.round(stop.at * 1000) / 10}%`)
    .join(", ");
  return fill.radial
    ? `radial-gradient(circle at center, ${stops})`
    : `linear-gradient(${fill.angle + 90}deg, ${stops})`;
}

function boxStyle(box: Box): CSSProperties {
  const transforms: string[] = [];
  if (box.rotation) transforms.push(`rotate(${box.rotation}deg)`);
  return {
    position: "absolute",
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    transform: transforms.length > 0 ? transforms.join(" ") : undefined,
  };
}

/** An outer shadow as a CSS filter, which follows the shape's outline. */
const shadowFilter = (shadow: Shadow | null) =>
  shadow
    ? `drop-shadow(${shadow.x}px ${shadow.y}px ${shadow.blur / 2}px ${shadow.colour})`
    : undefined;

const flipTransform = (box: Box) =>
  box.flipH || box.flipV ? `scale(${box.flipH ? -1 : 1}, ${box.flipV ? -1 : 1})` : undefined;

function ItemView({ item, path, context }: { item: Item; path: string; context: Context }) {
  switch (item.kind) {
    case "shape":
      return <ShapeView item={item} path={path} context={context} />;
    case "picture":
      return <PictureView item={item} context={context} />;
    case "group":
      return <GroupView item={item} path={path} context={context} />;
    case "table":
      return <TableView item={item} path={path} context={context} />;
    case "chart":
      return <ChartFrame item={item} />;
  }
}

function GroupView({ item, path, context }: { item: GroupItem; path: string; context: Context }) {
  const style = boxStyle(item.box);
  const transform = [style.transform, flipTransform(item.box)].filter(Boolean).join(" ");
  return (
    <div style={{ ...style, transform: transform || undefined }}>
      {item.children.map((each, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a group's items never reorder
        <ItemView key={index} item={each} path={childPath(path, index)} context={context} />
      ))}
    </div>
  );
}

/** An SVG <defs> for a fill that CSS can't give a path: a gradient or a picture. */
function svgPaint(
  fill: Fill,
  id: string,
  images: ReadonlyMap<string, string | null>,
): { paint: string; defs: ReactNode } {
  switch (fill.kind) {
    case "none":
      return { paint: "none", defs: null };
    case "solid":
      return { paint: fill.colour, defs: null };
    case "gradient": {
      const stops = fill.stops.map((stop, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stops never reorder
        <stop key={index} offset={stop.at} stopColor={stop.colour} />
      ));
      if (fill.radial) {
        return { paint: `url(#${id})`, defs: <radialGradient id={id}>{stops}</radialGradient> };
      }
      // DrawingML measures the angle clockwise from left-to-right, across the box.
      const radians = (fill.angle * Math.PI) / 180;
      const dx = Math.cos(radians) / 2;
      const dy = Math.sin(radians) / 2;
      return {
        paint: `url(#${id})`,
        defs: (
          <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
            {stops}
          </linearGradient>
        ),
      };
    }
    case "image": {
      const url = images.get(fill.part);
      if (!url) return { paint: "none", defs: null };
      return {
        paint: `url(#${id})`,
        defs: (
          <pattern id={id} patternContentUnits="objectBoundingBox" width="1" height="1">
            <image href={url} width="1" height="1" preserveAspectRatio="none" />
          </pattern>
        ),
      };
    }
  }
}

interface Stroke {
  stroke: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  strokeLinejoin?: "round";
}

function strokeOf(line: Line | null): Stroke {
  if (!line) return { stroke: "none" };
  return {
    stroke: line.colour,
    strokeWidth: line.width,
    strokeDasharray: line.dash ? line.dash.map((each) => each * line.width).join(" ") : undefined,
    strokeLinejoin: "round",
  };
}

/** Arrowheads for a line's ends. */
function markers(line: Line | null, id: string): { defs: ReactNode; start?: string; end?: string } {
  if (!line || (!line.head && !line.tail)) return { defs: null };
  const marker = (type: string, markerId: string, reverse: boolean) => {
    const shape =
      type === "oval" ? (
        <circle cx="5" cy="5" r="4" fill={line.colour} />
      ) : type === "diamond" ? (
        <path d="M5 0 L10 5 L5 10 L0 5 Z" fill={line.colour} />
      ) : type === "stealth" ? (
        <path d="M0 0 L10 5 L0 10 L3 5 Z" fill={line.colour} />
      ) : type === "arrow" ? (
        <path d="M0 0 L10 5 L0 10" fill="none" stroke={line.colour} strokeWidth="1.5" />
      ) : (
        <path d="M0 0 L10 5 L0 10 Z" fill={line.colour} />
      );
    const size = Math.max(3, 9 / Math.max(line.width, 1));
    return (
      <marker
        id={markerId}
        viewBox="0 0 10 10"
        refX="5"
        refY="5"
        markerWidth={size}
        markerHeight={size}
        orient={reverse ? "auto-start-reverse" : "auto"}
      >
        {shape}
      </marker>
    );
  };
  return {
    defs: (
      <>
        {line.head && marker(line.head, `${id}-head`, true)}
        {line.tail && marker(line.tail, `${id}-tail`, false)}
      </>
    ),
    start: line.head ? `url(#${id}-head)` : undefined,
    end: line.tail ? `url(#${id}-tail)` : undefined,
  };
}

function ShapeView({ item, path, context }: { item: ShapeItem; path: string; context: Context }) {
  const id = useId().replaceAll(":", "");
  const { box } = item;
  const line = isLine(item.geometry);
  const drawn = item.fill.kind !== "none" || item.line !== null;
  const paths = drawn ? geometryPaths(item.geometry, box.w, box.h) : [];
  const paint = svgPaint(line ? { kind: "none" } : item.fill, `${id}-fill`, context.images);
  const ends = markers(item.line, `${id}-line`);
  const stroke = strokeOf(item.line);
  // The text goes in the shape's text rectangle: SmartArt's own, or its geometry's.
  const inset = textInsets(item.geometry, box.w, box.h);
  const textBox = item.textBox
    ? {
        left: item.textBox.x - box.x,
        top: item.textBox.y - box.y,
        width: item.textBox.w,
        height: item.textBox.h,
      }
    : {
        left: inset.left,
        top: inset.top,
        width: Math.max(0, box.w - inset.left - inset.right),
        height: Math.max(0, box.h - inset.top - inset.bottom),
      };
  return (
    <div style={boxStyle(box)}>
      {paths.length > 0 && (
        <svg
          className="slide-shape"
          width={Math.max(box.w, 1)}
          height={Math.max(box.h, 1)}
          style={{ transform: flipTransform(box), filter: shadowFilter(item.shadow) }}
          aria-hidden="true"
        >
          {(paint.defs || ends.defs) && (
            <defs>
              {paint.defs}
              {ends.defs}
            </defs>
          )}
          {paths.map((each, index) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: a geometry's paths never reorder
              key={index}
              d={each.d}
              fill={each.fill ? paint.paint : "none"}
              fillRule="evenodd"
              markerStart={ends.start}
              markerEnd={ends.end}
              {...(each.stroke ? stroke : { stroke: "none" })}
            />
          ))}
        </svg>
      )}
      {item.text && hasText(item.text) && (
        <TextBodyView
          body={item.text}
          path={path}
          context={context}
          style={{ position: "absolute", ...textBox }}
        />
      )}
    </div>
  );
}

const hasText = (body: TextBody) =>
  body.paragraphs.some((paragraph) =>
    paragraph.runs.some((run) => run.text !== "" && !run.lineBreak),
  );

function PictureView({ item, context }: { item: PictureItem; context: Context }) {
  const t = useT();
  const { box, crop } = item;
  const url = item.part ? context.images.get(item.part) : null;
  const loading = item.part !== null && !context.images.has(item.part);
  const shown = 1 - crop.left - crop.right;
  const shownHeight = 1 - crop.top - crop.bottom;
  const clip = isRectangle(item.geometry)
    ? undefined
    : `path("${geometryPaths(item.geometry, box.w, box.h)[0]?.d ?? ""}")`;
  const line = item.line;
  return (
    <div style={{ ...boxStyle(box), filter: shadowFilter(item.shadow) }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          clipPath: clip,
          transform: flipTransform(box),
        }}
      >
        {url ? (
          <img
            src={url}
            alt={item.alt}
            draggable={false}
            style={{
              position: "absolute",
              left: shown > 0 ? (-crop.left / shown) * box.w : 0,
              top: shownHeight > 0 ? (-crop.top / shownHeight) * box.h : 0,
              width: shown > 0 ? box.w / shown : box.w,
              height: shownHeight > 0 ? box.h / shownHeight : box.h,
              maxWidth: "none",
            }}
          />
        ) : loading ? null : (
          <div className="slide-picture-missing" title={item.alt || undefined}>
            <span>{t("viewer.slide.picture")}</span>
          </div>
        )}
      </div>
      {line && (
        <svg
          className="slide-shape"
          width={Math.max(box.w, 1)}
          height={Math.max(box.h, 1)}
          aria-hidden="true"
        >
          {geometryPaths(item.geometry, box.w, box.h).map((each, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a geometry's paths never reorder
            <path key={index} d={each.d} fill="none" {...strokeOf(line)} />
          ))}
        </svg>
      )}
    </div>
  );
}

function borderOf(line: Line | null): string | undefined {
  if (!line) return undefined;
  return `${Math.max(line.width, 0.75)}px ${line.dash ? "dashed" : "solid"} ${line.colour}`;
}

function TableView({ item, path, context }: { item: TableItem; path: string; context: Context }) {
  const width = item.columns.reduce((sum, each) => sum + each, 0);
  return (
    <div style={{ ...boxStyle(item.box), width: Math.max(width, item.box.w), height: "auto" }}>
      <table className="slide-table" style={{ width: Math.max(width, 1) }}>
        <colgroup>
          {item.columns.map((column, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder
            <col key={index} style={{ width: column }} />
          ))}
        </colgroup>
        <tbody>
          {item.rows.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
            <tr key={r} style={{ height: row.height }}>
              {row.cells.map((cell, c) =>
                cell.merged ? null : (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells never reorder
                    key={c}
                    colSpan={cell.columnSpan > 1 ? cell.columnSpan : undefined}
                    rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                    style={{
                      ...fillStyle(cell.fill, context.images),
                      borderLeft: borderOf(cell.borders.left),
                      borderRight: borderOf(cell.borders.right),
                      borderTop: borderOf(cell.borders.top),
                      borderBottom: borderOf(cell.borders.bottom),
                      padding: `${cell.text.insets.top}px ${cell.text.insets.right}px ${cell.text.insets.bottom}px ${cell.text.insets.left}px`,
                      verticalAlign:
                        cell.text.anchor === "middle"
                          ? "middle"
                          : cell.text.anchor === "bottom"
                            ? "bottom"
                            : "top",
                    }}
                  >
                    <Paragraphs body={cell.text} path={cellPath(path, r, c)} context={context} />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartFrame({ item }: { item: ChartItem }) {
  const t = useT();
  return (
    <div style={boxStyle(item.box)}>
      {item.chart ? (
        <ChartView chart={item.chart} width={item.box.w} height={item.box.h} />
      ) : (
        <figure className="slide-chart-missing">
          <figcaption>{t("viewer.slide.chart")}</figcaption>
          {item.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a chart's lines never reorder
            <p key={index}>{line}</p>
          ))}
        </figure>
      )}
    </div>
  );
}

function TextBodyView({
  body,
  path,
  context,
  style,
}: {
  body: TextBody;
  path: string;
  context: Context;
  style: CSSProperties;
}) {
  const vertical = body.vertical !== "horizontal";
  return (
    <div
      className="slide-text"
      style={{
        ...style,
        paddingLeft: body.insets.left,
        paddingTop: body.insets.top,
        paddingRight: body.insets.right,
        paddingBottom: body.insets.bottom,
        justifyContent:
          body.anchor === "middle"
            ? "center"
            : body.anchor === "bottom"
              ? "flex-end"
              : "flex-start",
        writingMode: vertical ? "vertical-rl" : undefined,
        transform: body.vertical === "vertical270" ? "rotate(180deg)" : undefined,
        whiteSpace: body.wrap ? "pre-wrap" : "pre",
      }}
    >
      <Paragraphs body={body} path={path} context={context} />
    </div>
  );
}

/** A spacing before or after a paragraph, CSS pixels: a percentage is of a line. */
const spacingPx = (spacing: Spacing | null, size: number) =>
  spacing ? ("px" in spacing ? spacing.px : spacing.percent * size * SINGLE_LINE) : 0;

function Paragraphs({ body, path, context }: { body: TextBody; path: string; context: Context }) {
  return (
    <>
      {body.paragraphs.map((paragraph, index) => (
        <ParagraphView
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs never reorder
          key={index}
          paragraph={paragraph}
          index={index}
          path={path}
          context={context}
          first={index === 0}
        />
      ))}
    </>
  );
}

function ParagraphView({
  paragraph,
  index,
  path,
  context,
  first,
}: {
  paragraph: Paragraph;
  index: number;
  path: string;
  context: Context;
  first: boolean;
}) {
  const textRuns = paragraph.runs.filter((run) => !run.lineBreak && run.text !== "");
  const size =
    textRuns.length > 0 ? Math.max(...textRuns.map((run) => run.size)) : paragraph.endSize;
  const lineHeight = paragraph.lineSpacing
    ? "px" in paragraph.lineSpacing
      ? `${paragraph.lineSpacing.px}px`
      : String(paragraph.lineSpacing.percent * SINGLE_LINE)
    : String(SINGLE_LINE);
  const { bullet } = paragraph;
  return (
    <p
      className="slide-paragraph"
      style={{
        paddingLeft: paragraph.marginLeft,
        textIndent: paragraph.indent,
        textAlign: paragraph.align,
        lineHeight,
        // PowerPoint leaves out the first paragraph's space before.
        marginTop: first ? 0 : spacingPx(paragraph.spaceBefore, size),
        marginBottom: spacingPx(paragraph.spaceAfter, size),
        direction: paragraph.rtl ? "rtl" : undefined,
        // The line's strut: the largest run's size, so a small run's line isn't taller than PowerPoint's.
        fontSize: size,
        fontFamily: (textRuns[0] ?? paragraph.runs[0])?.fontFamily,
      }}
    >
      {bullet && (
        <span
          data-quote-skip=""
          className="slide-bullet"
          aria-hidden="true"
          style={{
            minWidth: paragraph.indent < 0 ? -paragraph.indent : undefined,
            paddingRight: paragraph.indent < 0 ? undefined : "0.5em",
            fontFamily: bullet.fontFamily,
            color: bullet.colour,
            fontSize: bullet.size,
          }}
        >
          {bullet.text}
        </span>
      )}
      {paragraph.runs.map((run, at) =>
        run.lineBreak ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs never reorder
          <br key={at} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs never reorder
          <RunView key={at} run={run} ranges={context.ranges?.get(runKey(path, index, at))} />
        ),
      )}
      {textRuns.length === 0 && <br />}
    </p>
  );
}

const DECORATION: Record<string, string> = {
  dbl: "double",
  dotted: "dotted",
  dottedHeavy: "dotted",
  dash: "dashed",
  dashHeavy: "dashed",
  dashLong: "dashed",
  dashLongHeavy: "dashed",
  wavy: "wavy",
  wavyHeavy: "wavy",
  wavyDbl: "wavy",
};

function RunView({ run, ranges }: { run: Run; ranges: TextRange[] | undefined }) {
  const lines = [run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(
    Boolean,
  );
  const raised = run.baseline !== 0;
  return (
    <span
      style={{
        fontSize: raised ? run.size * 0.66 : run.size,
        fontFamily: run.fontFamily,
        fontWeight: run.bold ? 700 : 400,
        fontStyle: run.italic ? "italic" : undefined,
        color: run.colour,
        textDecorationLine: lines.length > 0 ? lines.join(" ") : undefined,
        textDecorationStyle: run.underline
          ? ((DECORATION[run.underline] as CSSProperties["textDecorationStyle"]) ?? undefined)
          : run.strike === "double"
            ? "double"
            : undefined,
        textTransform: run.caps === "all" ? "uppercase" : undefined,
        fontVariantCaps: run.caps === "small" ? "small-caps" : undefined,
        letterSpacing: run.spacing ? run.spacing : undefined,
        verticalAlign: raised ? run.baseline * run.size : undefined,
        background: run.highlight ?? undefined,
      }}
    >
      <HighlightedText text={run.text} ranges={ranges} />
    </span>
  );
}
