/**
 * The font and text size of each Mind as this window knows them. A Mind's page reads its
 * style from here; the editor keeps it current from the Mind's document, and a choice made in
 * Style is written through the core, so a Mind that isn't open takes it too.
 */
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { create } from "zustand";
import { MIND_SETTINGS_FIELD } from "../../core/api";
import {
  DEFAULT_MIND_STYLE,
  familyOf,
  isFontFamily,
  type LineSpacing,
  type MindFont,
  type MindStyle,
  mindStyleOf,
  sameStyle,
  type TextSize,
  writingProperties,
  writingType,
} from "../../shared/mindStyle";
import { core } from "./core";
import { logCaught } from "./errorLog";
import { translateNow } from "./i18n";
import type { Words } from "./lineNames";
import type { Translate } from "./objects";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

interface MindStylesState {
  byMind: Readonly<Record<string, MindStyle>>;
  know(mindId: string, style: MindStyle): void;
}

const useMindStyles = create<MindStylesState>()((set) => ({
  byMind: {},
  know: (mindId, style) =>
    set((state) => {
      const known = state.byMind[mindId];
      return known && sameStyle(known, style)
        ? state
        : { byMind: { ...state.byMind, [mindId]: style } };
    }),
}));

/** The Mind's style as the window has it: the default until the core has said. */
export function useMindStyle(mindId: string): MindStyle {
  const known = useMindStyles((state) => state.byMind[mindId]);
  const listed = useAppStore((state) => state.minds.some((mind) => mind.id === mindId));
  useEffect(() => {
    if (known || !listed) return;
    core.getMindStyle(mindId).then(
      (style) => useMindStyles.getState().know(mindId, style),
      (error: unknown) => useAppStore.getState().reportError(error),
    );
  }, [mindId, known, listed]);
  return known ?? DEFAULT_MIND_STYLE;
}

/** The custom properties the Mind's writing takes (styles.css): the font and sizes of its style. */
export function useWritingProperties(mindId: string): CSSProperties {
  const style = useMindStyle(mindId);
  const installed = useFontInstalled(style.font);
  return useMemo(() => writingProperties(writingType(style, installed)), [style, installed]);
}

/** Keeps the window's copy of a Mind's style current from its open document. Returns how to stop. */
export function followMindStyle(mindId: string, doc: Y.Doc): () => void {
  const settings = doc.getMap(MIND_SETTINGS_FIELD);
  const publish = () => useMindStyles.getState().know(mindId, mindStyleOf(settings));
  publish();
  settings.observe(publish);
  return () => settings.unobserve(publish);
}

export const useNewMindStyle = (): MindStyle =>
  useAppStore((state) => state.settings?.user.newMindStyle) ?? DEFAULT_MIND_STYLE;

const FONT_LABELS = {
  default: "mindStyle.font.default",
  serif: "mindStyle.font.serif",
  mono: "mindStyle.font.mono",
} as const;

export const SIZE_LABELS = {
  small: "mindStyle.size.small",
  default: "mindStyle.size.default",
  large: "mindStyle.size.large",
} as const satisfies Record<TextSize, string>;

const fontLabel = (font: MindFont, t: Translate): string =>
  typeof font === "string" ? t(FONT_LABELS[font]) : font.family;

async function currentStyle(mindId: string): Promise<MindStyle> {
  return useMindStyles.getState().byMind[mindId] ?? (await core.getMindStyle(mindId));
}

async function apply(mindId: string, style: MindStyle): Promise<void> {
  useMindStyles.getState().know(mindId, await core.setMindStyle(mindId, style));
}

async function change(
  mindId: string,
  update: (style: MindStyle) => MindStyle,
  said: Words,
): Promise<void> {
  const before = await currentStyle(mindId);
  const next = update(before);
  if (sameStyle(before, next)) return;
  const { know } = useMindStyles.getState();
  know(mindId, next);
  try {
    await apply(mindId, next);
  } catch (error) {
    know(mindId, before);
    useAppStore.getState().reportError(error);
    return;
  }
  useUndo.getState().push({
    said,
    undo: () => apply(mindId, before),
    redo: () => apply(mindId, next),
  });
}

export const chooseFont = (mindId: string, font: MindFont) =>
  change(
    mindId,
    (style) => ({ ...style, font }),
    (t) => t("mindStyle.fontChanged", { font: fontLabel(font, t) }),
  );

export const chooseSize = (mindId: string, size: TextSize) =>
  change(
    mindId,
    (style) => ({ ...style, size }),
    (t) => t("mindStyle.sizeChanged", { size: t(SIZE_LABELS[size]) }),
  );

/** A line spacing as menus say it: Default, Single, 1.15, 1.5, Double, or the multiple typed. */
export function lineSpacingLabel(lineSpacing: LineSpacing): string {
  if (lineSpacing === "default") return translateNow("format.lineSpacing.default");
  if (lineSpacing === 1) return translateNow("format.lineSpacing.single");
  if (lineSpacing === 2) return translateNow("format.lineSpacing.double");
  return String(lineSpacing);
}

export const chooseLineSpacing = (mindId: string, lineSpacing: LineSpacing) =>
  change(
    mindId,
    (style) => ({ ...style, lineSpacing }),
    (t) => t("mindStyle.lineSpacingChanged", { spacing: lineSpacingLabel(lineSpacing) }),
  );

/** Makes `style` the one new Minds start in; Undo puts the one before back. */
export async function makeDefaultForNewMinds(style: MindStyle): Promise<void> {
  const { settings, updateSettings, reportError } = useAppStore.getState();
  const before = settings?.user.newMindStyle ?? DEFAULT_MIND_STYLE;
  if (sameStyle(before, style)) return;
  try {
    await updateSettings({ user: { newMindStyle: style } });
  } catch (error) {
    reportError(error);
    return;
  }
  useUndo.getState().push({
    said: (t) => t("mindStyle.defaultSet"),
    undo: () => updateSettings({ user: { newMindStyle: before } }),
    redo: () => updateSettings({ user: { newMindStyle: style } }),
  });
}

const PROBE_TEXT = "mmmmmmmmmmlliWwQq0O1,.中文字体";
const PROBE_BASES = ["monospace", "serif", "sans-serif"] as const;

type Measure = (font: string, text: string) => number;

const canvasMeasure = (): Measure | null => {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  return (font, text) => {
    context.font = `72px ${font}`;
    return context.measureText(text).width;
  };
};

/**
 * Whether a family is on this computer. The page can't ask, so it draws a line in the family
 * ahead of each generic family: a family that isn't there is drawn as the generic one is.
 * When the page can't draw at all, the answer is yes, so a font is never called missing wrongly.
 */
export function isFontInstalled(family: string, measure = canvasMeasure()): boolean {
  if (!measure) return true;
  const quoted = `"${family.replace(/["\\]/g, "")}"`;
  return PROBE_BASES.some(
    (base) => measure(`${quoted}, ${base}`, PROBE_TEXT) !== measure(base, PROBE_TEXT),
  );
}

/** Whether the font can be drawn here; checked again when the window is back in front. */
export function useFontInstalled(font: MindFont): boolean {
  const family = familyOf(font);
  const [installed, setInstalled] = useState(() => family === null || isFontInstalled(family));
  useEffect(() => {
    const check = () => setInstalled(family === null || isFontInstalled(family));
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [family]);
  return installed;
}

/**
 * Every family installed on this computer, once each, in the interface's order. Electron grants
 * the page this without asking; when it can't be read all the same, the list is empty, which
 * Style takes as "no other fonts" rather than as something for the User to fix.
 */
export async function installedFamilies(): Promise<string[]> {
  try {
    const fonts = await window.queryLocalFonts();
    const families = new Set(fonts.map((font) => font.family));
    return [...families]
      .filter((family) => isFontFamily(family) && !family.startsWith("."))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    logCaught(error);
    return [];
  }
}
