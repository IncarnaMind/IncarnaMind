import { useSyncExternalStore } from "react";
import type { WordRunLook } from "../../../core/api";

type Script = "latin" | "zh-Hans" | "zh-Hant" | "ja" | "ko";
type Kind = "serif" | "sans" | "mono" | "song" | "hei" | "kai" | "fangsong";

export interface FontClass {
  script: Script;
  kind: Kind;
}

/**
 * East Asian faces by their English and their own names, the more particular first: a
 * Traditional Chinese Ming before any Song, a Japanese Gothic before any Hei.
 */
const EAST_ASIAN: readonly (readonly [RegExp, Script, Kind])[] = [
  [/標楷|dfkai|biaukai|kaiti tc/i, "zh-Hant", "kai"],
  [/細明|mingliu|songti tc|lisong|serif (cjk )?tc|han serif tc/i, "zh-Hant", "song"],
  [/正黑|jhenghei|pingfang tc|heiti tc|sans (cjk )?tc|han sans tc/i, "zh-Hant", "hei"],
  [/仿宋|fangsong/i, "zh-Hans", "fangsong"],
  [/楷|kaiti|ukai/i, "zh-Hans", "kai"],
  [/宋|song|simsun|serif (cjk )?sc|han serif sc|uming/i, "zh-Hans", "song"],
  [
    /黑|等线|苹方|simhei|heiti|xihei|yahei|dengxian|pingfang|hiragino sans gb|sans (cjk )?sc|han sans sc|wenquanyi/i,
    "zh-Hans",
    "hei",
  ],
  [/明朝|mincho|serif (cjk )?jp|han serif jp/i, "ja", "song"],
  [
    /ゴシック|メイリオ|ヒラギノ角|^ms p?gothic|^yu gothic|meiryo|hiragino (kaku gothic|sans)|sans (cjk )?jp|han sans jp/i,
    "ja",
    "hei",
  ],
  [/batang|바탕|gungsuh|궁서|myungjo|명조|serif (cjk )?kr|han serif k/i, "ko", "song"],
  [
    /gulim|굴림|dotum|돋움|malgun|맑은|apple sd gothic|nanum ?gothic|나눔고딕|sans (cjk )?kr|han sans k/i,
    "ko",
    "hei",
  ],
];

const SANS =
  /sans|gothic|arial|helvetica|calibri|carlito|candara|corbel|segoe|verdana|tahoma|trebuchet|aptos|roboto|lato|franklin|futura|univers|frutiger|myriad/i;
const MONO = /mono|courier|consolas|menlo|lucida console|cousine/i;

/** What a font is: the script it was made for, and its kind (serif or sans; for Chinese, Song, Hei, Kai or Fangsong). */
export function fontClass(name: string): FontClass {
  for (const [pattern, script, kind] of EAST_ASIAN) {
    if (pattern.test(name)) return { script, kind };
  }
  if (/\p{Script=Hangul}/u.test(name)) return { script: "ko", kind: "hei" };
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)) return { script: "ja", kind: "hei" };
  if (/\p{Script=Han}/u.test(name)) return { script: "zh-Hans", kind: "song" };
  if (MONO.test(name)) return { script: "latin", kind: "mono" };
  return { script: "latin", kind: SANS.test(name) ? "sans" : "serif" };
}

/**
 * Faces drawn the same size, line for line: the open fonts made to Microsoft's
 * metrics (Carlito and Caladea ship with the app, `wordFonts.css`), then the
 * look-alikes each system has.
 */
const SUBSTITUTES: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^calibri$/i, ["Carlito"]],
  [/^cambria$/i, ["Caladea"]],
  [/^times new roman$/i, ["Liberation Serif", "Tinos", "Times"]],
  [/^arial$/i, ["Liberation Sans", "Arimo", "Helvetica"]],
  [/^courier new$/i, ["Liberation Mono", "Cousine", "Courier"]],
  [/^helvetica$/i, ["Arial", "Liberation Sans", "Arimo"]],
  [/^times$/i, ["Times New Roman", "Liberation Serif", "Tinos"]],
  [
    /^(book antiqua|palatino linotype|palatino)$/i,
    ["Palatino Linotype", "Book Antiqua", "Palatino", "TeX Gyre Pagella", "URW Palladio L", "P052"],
  ],
  [/^garamond$/i, ["EB Garamond", "Adobe Garamond Pro", "Garamond Premier Pro"]],
  [/^century( schoolbook)?$/i, ["Century Schoolbook", "TeX Gyre Schola", "C059"]],
  [/^bookman old style$/i, ["TeX Gyre Bonum", "URW Bookman", "Bookman"]],
  [/^century gothic$/i, ["TeX Gyre Adventor", "URW Gothic", "Avenir"]],
];

const NEAREST: Readonly<Record<Script, Partial<Record<Kind, readonly string[]>>>> = {
  latin: {
    serif: [
      "Times New Roman",
      "Times",
      "Liberation Serif",
      "Tinos",
      "Georgia",
      "Noto Serif",
      "DejaVu Serif",
      "Caladea",
    ],
    sans: ["Arial", "Helvetica", "Liberation Sans", "Arimo", "Noto Sans", "DejaVu Sans", "Carlito"],
    mono: [
      "Courier New",
      "Courier",
      "Liberation Mono",
      "Cousine",
      "Menlo",
      "Consolas",
      "DejaVu Sans Mono",
    ],
  },
  "zh-Hans": {
    song: [
      "SimSun",
      "宋体",
      "NSimSun",
      "STSong",
      "Songti SC",
      "STZhongsong",
      "华文中宋",
      "Noto Serif CJK SC",
      "Noto Serif SC",
      "Source Han Serif SC",
      "思源宋体",
      "AR PL UMing CN",
    ],
    hei: [
      "SimHei",
      "黑体",
      "Microsoft YaHei",
      "微软雅黑",
      "DengXian",
      "等线",
      "PingFang SC",
      "Heiti SC",
      "STHeiti",
      "Hiragino Sans GB",
      "Noto Sans CJK SC",
      "Noto Sans SC",
      "Source Han Sans SC",
      "思源黑体",
      "WenQuanYi Micro Hei",
    ],
    kai: [
      "KaiTi",
      "楷体",
      "KaiTi_GB2312",
      "楷体_GB2312",
      "STKaiti",
      "华文楷体",
      "Kaiti SC",
      "AR PL UKai CN",
    ],
    fangsong: ["FangSong", "仿宋", "FangSong_GB2312", "仿宋_GB2312", "STFangsong", "华文仿宋"],
  },
  "zh-Hant": {
    song: [
      "PMingLiU",
      "新細明體",
      "MingLiU",
      "細明體",
      "Songti TC",
      "LiSong Pro",
      "Noto Serif CJK TC",
      "Source Han Serif TC",
    ],
    hei: [
      "Microsoft JhengHei",
      "微軟正黑體",
      "PingFang TC",
      "Heiti TC",
      "Noto Sans CJK TC",
      "Source Han Sans TC",
    ],
    kai: ["DFKai-SB", "標楷體", "BiauKai", "Kaiti TC"],
  },
  ja: {
    song: [
      "Yu Mincho",
      "游明朝",
      "MS Mincho",
      "ＭＳ 明朝",
      "Hiragino Mincho ProN",
      "ヒラギノ明朝 ProN",
      "Noto Serif CJK JP",
      "Source Han Serif JP",
    ],
    hei: [
      "Yu Gothic",
      "游ゴシック",
      "Meiryo",
      "メイリオ",
      "MS Gothic",
      "ＭＳ ゴシック",
      "Hiragino Sans",
      "Hiragino Kaku Gothic ProN",
      "ヒラギノ角ゴ ProN",
      "Noto Sans CJK JP",
      "Source Han Sans JP",
    ],
  },
  ko: {
    song: ["Batang", "바탕", "AppleMyungjo", "Noto Serif CJK KR", "Source Han Serif K"],
    hei: [
      "Malgun Gothic",
      "맑은 고딕",
      "Gulim",
      "굴림",
      "Dotum",
      "돋움",
      "Apple SD Gothic Neo",
      "Noto Sans CJK KR",
      "Source Han Sans K",
      "NanumGothic",
    ],
  },
};

/** Where a Kai or Fangsong face is missing, a Song is the nearer of the others. */
const NEXT_KIND: Partial<Record<Kind, Kind>> = { kai: "song", fangsong: "song" };

/** The faces to draw a font's text in where it isn't installed, nearest first: the same script and kind. */
export function nearestFonts(name: string): string[] {
  const { script, kind } = fontClass(name);
  const own = SUBSTITUTES.find(([pattern]) => pattern.test(name.trim()))?.[1] ?? [];
  const next = NEXT_KIND[kind];
  const kinds = [NEAREST[script][kind] ?? [], next ? (NEAREST[script][next] ?? []) : []];
  return [...new Set([...own, ...kinds.flat()])].filter((each) => each !== name);
}

const quoted = (font: string) => `"${font.replace(/["\\]/g, "")}"`;

const GENERIC: Record<Kind, string> = {
  serif: "var(--font-serif)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
  song: "var(--font-serif)",
  kai: "var(--font-serif)",
  fangsong: "var(--font-serif)",
  hei: "var(--font-sans)",
};

/**
 * A run's `font-family`: the file's own faces, each followed by the nearest of the same script
 * and kind, so the first one installed draws it, as Word substitutes a missing font. Latin
 * faces come before East Asian ones, so a Latin run's letters never fall to a Chinese face's
 * Latin glyphs while a Latin face is there; nothing is downloaded.
 */
export function fontStack(look: WordRunLook): string | null {
  const own = [...new Set([look.font, look.eastAsia])].filter((each): each is string =>
    Boolean(each),
  );
  if (own.length === 0) return null;
  const first = own[0] as string;
  const families = [...new Set(own.flatMap((font) => [font, ...nearestFonts(font)]))];
  return `${families.map(quoted).join(", ")}, ${GENERIC[fontClass(first).kind]}`;
}

const PROBES: Record<Script, string> = {
  latin: "mmmmmmmmmmlliI10WQg@&",
  "zh-Hans": "永和九年岁在癸丑暮春之初会于会稽",
  "zh-Hant": "永和九年歲在癸丑暮春之初會於會稽",
  ja: "あいうえおアイウエオ永和九年",
  ko: "가나다라마바사아자차카타파하",
};

const installed = new Map<string, boolean>();
let measure: CanvasRenderingContext2D | null | undefined;

/** How many times the window has finished loading fonts since one was found missing. */
let fontLoads = 0;
const fontLoadListeners = new Set<() => void>();
let watchingLoads = false;

/**
 * A font found missing may only not have loaded yet, as the app's own faces load when first
 * drawn: it is looked for again once the window has loaded fonts.
 */
function watchFontLoads(): void {
  if (watchingLoads || typeof document === "undefined" || !document.fonts) return;
  watchingLoads = true;
  document.fonts.addEventListener("loadingdone", () => {
    for (const [name, found] of installed) if (!found) installed.delete(name);
    fontLoads++;
    for (const listener of fontLoadListeners) listener();
  });
}

function onFontLoads(listener: () => void): () => void {
  fontLoadListeners.add(listener);
  return () => fontLoadListeners.delete(listener);
}

/** Draws the caller again once the window has loaded fonts, so what it says is missing is current. */
export function useFontLoads(): number {
  return useSyncExternalStore(onFontLoads, () => fontLoads);
}

/**
 * Whether a font is on this computer, as `font-family` would find it. Its own script's text is
 * measured with it before three different generic faces: an installed font draws all three the
 * same, and differently from at least one generic face alone.
 */
export function fontInstalled(name: string): boolean {
  const known = installed.get(name);
  if (known !== undefined) return known;
  if (measure === undefined) measure = document.createElement("canvas").getContext("2d");
  // Nothing to measure with: say nothing is missing rather than guess.
  if (!measure) return true;
  const context = measure;
  const text = PROBES[fontClass(name).script];
  const width = (family: string) => {
    context.font = `40px ${family}`;
    return context.measureText(text).width;
  };
  const generics = ["monospace", "serif", "sans-serif"];
  const drawn = generics.map((generic) => width(`${quoted(name)}, ${generic}`));
  const alone = generics.map(width);
  const result =
    drawn.every((each) => each === drawn[0]) && drawn.some((each, at) => each !== alone[at]);
  installed.set(name, result);
  if (!result) watchFontLoads();
  return result;
}

export const missingFonts = (fonts: readonly string[]): string[] =>
  fonts.filter((font) => !fontInstalled(font));
