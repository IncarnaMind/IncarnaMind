import type { WordLook, WordParagraphLook, WordRunLook } from "../../../core/api";
import { lineHeightCss } from "../../../shared/paragraphFormat";
import { attribute, border, pt, rule } from "./wordCss";
import { DEFAULT_BODY, pageWidth, wordLookZoomCss } from "./wordLookZoom";
import { WORD_LOOK_DOM_ATTRIBUTE, WORD_RUN_DOM_ATTRIBUTE } from "./wordSchema";
import { wordTableCss } from "./wordTableCss";
import { alignsColumns, DEFAULT_TAB_STOP } from "./wordTabStops";
import { WORD_TAB_DOM_ATTRIBUTE } from "./wordTabs";

const LEADERS = [
  ["dot", "."],
  ["hyphen", "-"],
  ["underscore", "_"],
  ["heavy", "_"],
  ["middleDot", "·"],
] as const;
const LEADER_LENGTH = 400;

/** Word draws super- and subscript at about two thirds of the size. */
const RAISED_SIZE = 0.66;

const HIGHLIGHTS = new Map([
  ["yellow", "#FFFF00"],
  ["green", "#00FF00"],
  ["cyan", "#00FFFF"],
  ["magenta", "#FF00FF"],
  ["blue", "#0000FF"],
  ["red", "#FF0000"],
  ["darkBlue", "#000080"],
  ["darkCyan", "#008080"],
  ["darkGreen", "#008000"],
  ["darkMagenta", "#800080"],
  ["darkRed", "#800000"],
  ["darkYellow", "#808000"],
  ["darkGray", "#808080"],
  ["lightGray", "#C0C0C0"],
  ["black", "#000000"],
  ["white", "#FFFFFF"],
]);

/** The family name decides the fallback's kind: sans, mono, else the Mind's serif. */
const SANS =
  /sans|gothic|arial|helvetica|calibri|carlito|segoe|verdana|tahoma|trebuchet|aptos|roboto|lato|yahei|雅黑|黑体|hei\b|dengxian|等线|pingfang|苹方/i;
const MONO = /mono|courier|consolas|menlo/i;

export const wordLookScope = (mindId: string) => `word-look-${mindId}`;

const escapedClass = (name: string) => name.replace(/[^\w-]/g, (character) => `\\${character}`);

const quoted = (font: string) => `"${font.replace(/["\\]/g, "")}"`;

function fontFamily(look: WordRunLook): string | null {
  const fonts = [...new Set([look.font, look.eastAsia])].filter((each): each is string =>
    Boolean(each),
  );
  if (fonts.length === 0) return null;
  const fallback = fonts.some((font) => MONO.test(font))
    ? "var(--font-mono)"
    : fonts.some((font) => SANS.test(font))
      ? "var(--font-sans)"
      : "var(--font-serif)";
  return `${fonts.map(quoted).join(", ")}, ${fallback}`;
}

/**
 * What a run's look sets, every property so a run never keeps its
 * paragraph's; never bold, italic, underline or strike, which the text's own
 * marks carry so the editor's toggles act on them.
 */
function runDeclarations(look: WordRunLook): string[] {
  const size = look.vertical && look.size !== undefined ? look.size * RAISED_SIZE : look.size;
  const family = fontFamily(look);
  return [
    family ? `font-family: ${family}` : "",
    size !== undefined ? `font-size: ${pt(size)}` : "",
    `text-transform: ${look.caps ? "uppercase" : "none"}`,
    `font-variant-caps: ${look.smallCaps ? "small-caps" : "normal"}`,
    `letter-spacing: ${look.letterSpacing ? pt(look.letterSpacing) : "normal"}`,
    look.color ? `color: #${look.color}` : "",
  ].filter(Boolean);
}

function inlineDeclarations(look: WordRunLook): string[] {
  const background = look.highlight
    ? HIGHLIGHTS.get(look.highlight)
    : look.shade && `#${look.shade}`;
  return [
    background ? `background-color: ${background}` : "",
    look.vertical ? `vertical-align: ${look.vertical === "superscript" ? "super" : "sub"}` : "",
  ].filter(Boolean);
}

function paragraphDeclarations(look: WordParagraphLook): string[] {
  return [
    `text-align: ${look.align === "distribute" ? "justify" : (look.align ?? "left")}`,
    look.align === "distribute" ? "text-align-last: justify" : "",
    `margin-left: ${look.left ? pt(look.left) : "0"}`,
    `margin-right: ${look.right ? pt(look.right) : "0"}`,
    `text-indent: ${look.firstLine ? pt(look.firstLine) : "0"}`,
    `margin-top: ${look.before ? pt(look.before) : "0"}`,
    `margin-bottom: ${look.after ? pt(look.after) : "0"}`,
    `line-height: ${lineHeightCss(look.line, pt)}`,
    look.characterSize ? `--word-char: ${pt(look.characterSize)}` : "",
    // A heading's bold is the app's; the text's own marks carry the file's.
    "font-weight: 400",
    "font-style: normal",
    look.shade ? `background-color: #${look.shade}` : "",
    ...(["top", "bottom", "left", "right"] as const).flatMap((side) => {
      const value = look.borders?.[side];
      return value
        ? [`border-${side}: ${border(value)}`, `padding-${side}: ${pt(value.space)}`]
        : [];
    }),
  ].filter(Boolean);
}

/** Sizes and lengths are relative to the file's body size, which takes the Mind's writing size. */
export function wordLookCss(mindId: string, look: WordLook): string {
  const scope = `.${escapedClass(wordLookScope(mindId))}`;
  const tab = pt(look.defaultTab ?? DEFAULT_TAB_STOP);
  const rules = [
    `${scope} { --word-pt: calc(var(--text-body) / ${look.body ?? DEFAULT_BODY}); }`,
    pageWidth(look) ? `${scope} { max-width: ${pt(pageWidth(look))}; }` : "",
    // A table reaching past the text's width widens the page; the text keeps its own.
    look.width && pageWidth(look) > look.width
      ? `${scope} .mind-editor > :not(.tableWrapper) { max-width: ${pt(look.width)}; }`
      : "",
    // A list draws its own indents, over a paragraph's own format too.
    `${scope} li > [${WORD_LOOK_DOM_ATTRIBUTE}] { margin-left: 0 !important; margin-right: 0 !important; text-indent: 0 !important; }`,
    // The look's space before is all the space a paragraph takes, as in Word.
    `${scope} [${WORD_LOOK_DOM_ATTRIBUTE}] { --block-gap: 0px; }`,
    // Until measured, a tab takes one default stop. overflow: clip, unlike hidden, leaves the baseline where it is.
    `${scope} [${WORD_TAB_DOM_ATTRIBUTE}] { display: inline-block; position: relative; width: ${tab}; tab-size: ${tab}; white-space: pre; text-indent: 0; text-align: left; overflow: clip; }`,
    // Out of the flow, so the tab character still starts the box.
    `${scope} [${WORD_TAB_DOM_ATTRIBUTE}][data-leader]::before { position: absolute; inset: 0; overflow: clip; pointer-events: none; }`,
    ...LEADERS.map(
      ([leader, character]) =>
        `${scope} [${WORD_TAB_DOM_ATTRIBUTE}][data-leader="${leader}"]::before { content: "${character.repeat(LEADER_LENGTH)}"; }`,
    ),
  ];
  for (const [key, paragraph] of Object.entries(look.paragraphs)) {
    const run =
      paragraph.run && Object.hasOwn(look.runs, paragraph.run)
        ? look.runs[paragraph.run]
        : undefined;
    const selector = `${scope} ${attribute(WORD_LOOK_DOM_ATTRIBUTE, key)}`;
    rules.push(
      rule(selector, [...paragraphDeclarations(paragraph), ...(run ? runDeclarations(run) : [])]),
    );
    if (alignsColumns(paragraph)) {
      rules.push(
        rule(`${selector}:has([${WORD_TAB_DOM_ATTRIBUTE}])`, [
          "white-space: pre",
          "overflow-x: auto",
          "overflow-y: hidden",
        ]),
      );
    }
    if (paragraph.contextual) {
      const same = attribute(WORD_LOOK_DOM_ATTRIBUTE, key);
      rules.push(
        rule(`${selector} + ${same}, ${scope} li:has(> ${same}) + li > ${same}`, ["margin-top: 0"]),
      );
      rules.push(
        rule(`${selector}:has(+ ${same}), ${scope} li:has(+ li > ${same}) > ${same}`, [
          "margin-bottom: 0",
        ]),
      );
    }
  }
  // As after any Answer (styles.css); a paragraph's own space before would otherwise win.
  rules.push(`${scope} :where(.node-answer) + [${WORD_LOOK_DOM_ATTRIBUTE}] { margin-top: 24px; }`);
  for (const [key, run] of Object.entries(look.runs)) {
    rules.push(
      rule(`${scope} span${attribute(WORD_RUN_DOM_ATTRIBUTE, key)}`, [
        ...runDeclarations(run),
        ...inlineDeclarations(run),
      ]),
    );
  }
  rules.push(
    `${scope} :is(code, a) [${WORD_RUN_DOM_ATTRIBUTE}] { font-family: inherit; color: inherit; }`,
    `${scope} [${WORD_LOOK_DOM_ATTRIBUTE}] :is([contenteditable="false"], .citation-marker) { text-indent: 0; letter-spacing: normal; text-transform: none; font-variant-caps: normal; }`,
  );
  rules.push(...wordTableCss(scope, look), ...wordLookZoomCss(scope, look));
  return rules.filter(Boolean).join("\n");
}
