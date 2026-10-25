import { Extension, Mark } from "@tiptap/core";
import {
  PARAGRAPH_FORMAT_ATTRIBUTE,
  SUBSCRIPT_MARK,
  SUPERSCRIPT_MARK,
  TEXT_COLOR_MARK,
  TEXT_FONT_MARK,
  TEXT_SIZE_MARK,
} from "../../../core/api";
import { fontFamilyList } from "../../../shared/mindStyle";
import {
  paragraphFormatDeclarations,
  readParagraphFormat,
  readTextColor,
  readTextFont,
  readTextSize,
  storedFormat,
} from "../../../shared/paragraphFormat";
import { pt } from "./wordCss";

export const FORMATTED_TYPES = ["paragraph", "heading"];

const FORMAT_DOM_ATTRIBUTE = "data-paragraph-format";

function formatFromHtml(element: HTMLElement) {
  try {
    return storedFormat(JSON.parse(element.getAttribute(FORMAT_DOM_ATTRIBUTE) ?? "null"));
  } catch {
    return null;
  }
}

/**
 * How the User formatted a paragraph (`PARAGRAPH_FORMAT_ATTRIBUTE`), drawn as its own style so
 * it wins over the Word look. `keepOnSplit`: Enter gives the next paragraph the same, as in
 * Word and Google Docs.
 */
export const ParagraphFormatAttribute = Extension.create({
  name: "paragraphFormatAttribute",

  addGlobalAttributes() {
    return [
      {
        types: FORMATTED_TYPES,
        attributes: {
          [PARAGRAPH_FORMAT_ATTRIBUTE]: {
            default: null,
            keepOnSplit: true,
            parseHTML: formatFromHtml,
            renderHTML: (attributes: Record<string, unknown>) => {
              const format = readParagraphFormat(attributes[PARAGRAPH_FORMAT_ATTRIBUTE]);
              if (Object.keys(format).length === 0) return {};
              return {
                [FORMAT_DOM_ATTRIBUTE]: JSON.stringify(format),
                ...(format.after !== undefined && { "data-space-after": "" }),
                style: paragraphFormatDeclarations(format, pt).join("; "),
              };
            },
          },
        },
      },
    ];
  },
});

export const TextColor = Mark.create({
  name: TEXT_COLOR_MARK,

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => readTextColor(element.dataset.textColor),
        renderHTML: (attributes: Record<string, unknown>) => {
          const color = readTextColor(attributes.color);
          return color ? { "data-text-color": color, style: `--text-color: #${color}` } : {};
        },
      },
    };
  },

  parseHTML: () => [{ tag: "span[data-text-color]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
});

export const TextFont = Mark.create({
  name: TEXT_FONT_MARK,

  addAttributes() {
    return {
      family: {
        default: null,
        parseHTML: (element: HTMLElement) => readTextFont(element.dataset.textFont),
        renderHTML: (attributes: Record<string, unknown>) => {
          const family = readTextFont(attributes.family);
          return family
            ? {
                "data-text-font": family,
                style: `--text-font: ${fontFamilyList({ family }, true)}`,
              }
            : {};
        },
      },
    };
  },

  parseHTML: () => [{ tag: "span[data-text-font]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
});

export const TextSize = Mark.create({
  name: TEXT_SIZE_MARK,

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (element: HTMLElement) => readTextSize(Number(element.dataset.textSize)),
        renderHTML: (attributes: Record<string, unknown>) => {
          const size = readTextSize(attributes.size);
          return size ? { "data-text-size": String(size), style: `font-size: ${pt(size)}` } : {};
        },
      },
    };
  },

  parseHTML: () => [{ tag: "span[data-text-size]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
});

// A footnote's marker is a `sup` too, with its own `data-type`.
export const Superscript = Mark.create({
  name: SUPERSCRIPT_MARK,
  excludes: `${SUPERSCRIPT_MARK} ${SUBSCRIPT_MARK}`,
  parseHTML: () => [{ tag: "sup:not([data-type])" }],
  renderHTML: () => ["sup", 0],
});

export const Subscript = Mark.create({
  name: SUBSCRIPT_MARK,
  excludes: `${SUPERSCRIPT_MARK} ${SUBSCRIPT_MARK}`,
  parseHTML: () => [{ tag: "sub" }],
  renderHTML: () => ["sub", 0],
});
