/**
 * A Mind's citation style and its font and text size (#1421), set as the Mind's own Citation
 * style… and Style… set them, each taken back with Undo.
 */
import { CITATION_STYLES, type CitationStyleId } from "../../../shared/citationStyles";
import { translate } from "../../../shared/i18n";
import {
  FONT_PRESETS,
  isFontFamily,
  type MindFont,
  type MindStyle,
  TEXT_SIZES,
  type TextSize,
} from "../../../shared/mindStyle";
import { mindName } from "../../../shared/naming";
import { InvalidInputError } from "../../errors";
import {
  type Checker,
  type CommandsCore,
  inApp,
  mindItem,
  mindsOf,
  needs,
  onlyOne,
  same,
} from "./run";

/** The names the command's description gives as examples: each is one the app knows (#2252). */
export const STYLE_EXAMPLES = ["APA 7", "Chicago", "MLA", "GB/T 7714"] as const;

/** "Chicago 17", "APA 6th edition": a style's name, then the edition the request names. */
const EDITION = /^(.+?)\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s+(?:edition|ed\.?))?$/i;

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

const commonNamed = (given: string) =>
  CITATION_STYLES.find((style) =>
    [
      style.id,
      translate("en", style.label),
      translate("zh-CN", style.label),
      ...style.aliases,
    ].some((name) => same(name, given)),
  );

/**
 * A style by its id, its name in either language, another of its names, or its title in the pack;
 * or a common style's name with an edition: its own when its name gives that number ("APA 7th
 * edition"), else the earlier edition the pack keeps beside it ("Chicago 17"), never another
 * edition in its place.
 */
async function styleNamed(
  core: CommandsCore,
  given: string,
): Promise<{ id: CitationStyleId; name: string }> {
  const common = commonNamed(given);
  if (common) return { id: common.id, name: translate("en", common.label) };
  const { styles } = await core.listCitationStyles();
  const found = styles.find(
    (style) =>
      same(style.id, given) ||
      same(style.title, given) ||
      (style.short !== undefined && same(style.short, given)),
  );
  if (found) return { id: found.id, name: found.title };
  const [, base = "", number = ""] = EDITION.exec(given.trim()) ?? [];
  const named = base ? commonNamed(base) : undefined;
  if (named) {
    const label = translate("en", named.label);
    if (label.split(/\D+/).includes(number)) return { id: named.id, name: label };
    const earlier = styles.find(
      (style) => style.id === `${named.packId}-${ordinal(Number(number))}-edition`,
    );
    if (earlier) return { id: earlier.id, name: earlier.title };
  }
  throw new InvalidInputError({ key: "error.commands.noStyleNamed", values: { style: given } });
}

const fontOf = (given: string): MindFont => {
  const preset = FONT_PRESETS.find((each) => same(each, given));
  if (preset) return preset;
  if (!isFontFamily(given)) {
    throw new InvalidInputError({ key: "error.commands.noFont", values: { font: given } });
  }
  return { family: given.trim() };
};

const sizeOf = (given: string): TextSize => {
  const size = TEXT_SIZES.find((each) => same(each, given));
  if (!size) throw new InvalidInputError({ key: "error.commands.noSize", values: { size: given } });
  return size;
};

const fontSaid = (font: MindFont) => (typeof font === "string" ? font : font.family);

const styleSaid = (style: MindStyle) => `${fontSaid(style.font)}, ${style.size}`;

export const STYLE_CHECKERS = {
  "mind.citationStyle": async (input, { core }) => {
    const mind = onlyOne(await mindsOf(core, input.ids));
    const style = await styleNamed(core, needs(input.style, "error.commands.noStyle"));
    return inApp("mind.citationStyle", [mindItem(mind)], style.name, async () => {
      const before = await core.getMindCitationStyle(mind.id);
      await core.setMindCitationStyle(mind.id, style.id);
      return {
        done: {
          items: [mindItem(mind)],
          setting: { name: "citationStyle", from: before.style, to: style.name },
        },
        step: {
          undo: async () => {
            await core.setMindCitationStyle(mind.id, before.chosen ? before.style : null, {
              folderDefault: before.folderDefault,
            });
            return null;
          },
          redo: async () => {
            await core.setMindCitationStyle(mind.id, style.id);
          },
        },
        said: `The Note “${mindName(mind)}” now cites in ${style.name}.`,
      };
    });
  },

  "mind.style": async (input, { core }) => {
    const mind = onlyOne(await mindsOf(core, input.ids));
    const font = input.font === null ? null : fontOf(input.font);
    const size = input.size === null ? null : sizeOf(input.size);
    if (font === null && size === null) {
      throw new InvalidInputError({ key: "error.commands.noFontOrSize" });
    }
    return inApp("mind.style", [mindItem(mind)], null, async () => {
      const before = await core.getMindStyle(mind.id);
      const wanted: MindStyle = { ...before, ...(font && { font }), ...(size && { size }) };
      const after = await core.setMindStyle(mind.id, wanted);
      return {
        done: {
          items: [mindItem(mind)],
          setting: { name: "style", from: styleSaid(before), to: styleSaid(after) },
        },
        step: {
          undo: async () => {
            await core.setMindStyle(mind.id, before);
            return null;
          },
          redo: async () => {
            await core.setMindStyle(mind.id, after);
          },
        },
        said: `The Note “${mindName(mind)}” is now in the ${fontSaid(after.font)} font, ${after.size} size.`,
      };
    });
  },
} satisfies Record<string, Checker>;
