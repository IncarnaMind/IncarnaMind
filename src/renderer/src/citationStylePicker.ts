/**
 * The one citation style picker (#289), whichever way it was opened: the References block's
 * style button, the export dialog, a Mind's ⋯ menu, or ⌘K's "Citation style…". The picker
 * itself is `CitationStylePickerHost`, mounted once in the window.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { MindCitationStyle } from "../../core/api";
import {
  type CitationStyleId,
  commonCitationStyle,
  type StyleCatalogue,
  type StyleSummary,
} from "../../shared/citationStyles";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { core } from "./core";
import { useT } from "./i18n";
import { useAppStore } from "./store";
import { closeTip } from "./tips";
import { useUndo } from "./undo";

interface PickerState {
  /** The Mind whose style is being chosen, and what the picker opens beside; null: closed. */
  open: { mindId: string; anchor: HTMLElement | null; current: MindCitationStyle | null } | null;
  /** Opens the picker for a Mind beside `anchor` (none: at the top of the window). */
  show(mindId: string, anchor: HTMLElement | null): void;
  close(): void;
}

export const useCitationStylePicker = create<PickerState>()((set, get) => ({
  open: null,
  show(mindId, anchor) {
    set({ open: { mindId, anchor, current: null } });
    core.getMindCitationStyle(mindId).then(
      (current) => {
        const open = get().open;
        if (open?.mindId === mindId) set({ open: { ...open, current } });
      },
      (error: unknown) => useAppStore.getState().reportError(error),
    );
  },
  close: () => set({ open: null }),
}));

interface CatalogueState {
  /** Every style of the pack but the common ones, once asked for; null before. */
  catalogue: StyleCatalogue | null;
  byId: ReadonlyMap<CitationStyleId, StyleSummary>;
  loading: boolean;
  /** Reads the pack's list the first time it is needed: the picker opens, or a Mind is in one. */
  load(): void;
}

let held: { promise: Promise<void>; release(): void } | null = null;

export function holdStyleCatalogue(hold: boolean): void {
  if (!hold) {
    held?.release();
    held = null;
  } else if (!held) {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    held = { promise, release };
  }
}

export const useStyleCatalogue = create<CatalogueState>()((set, get) => ({
  catalogue: null,
  byId: new Map(),
  loading: false,
  load() {
    if (get().catalogue || get().loading) return;
    set({ loading: true });
    Promise.all([core.listCitationStyles(), held?.promise]).then(
      ([catalogue]) =>
        set({
          catalogue,
          byId: new Map(catalogue.styles.map((style) => [style.id, style])),
          loading: false,
        }),
      (error: unknown) => {
        set({ loading: false });
        useAppStore.getState().reportError(error);
      },
    );
  },
}));

type Translate = (key: MessageKey, params?: MessageParams) => string;

function labelOf(
  style: CitationStyleId,
  t: Translate,
  known: StyleSummary | undefined,
  loaded: boolean,
  unavailable: boolean,
): string {
  const common = commonCitationStyle(style);
  if (common) return t(common.label);
  if (known) return known.title;
  return unavailable || loaded ? t("citationStyle.unavailable", { style }) : style;
}

/**
 * A style's name in the interface language: a common style's own, a pack style's title, or, for
 * a style this version doesn't have (`unavailable`, or not in the pack's list), that it isn't.
 */
export function styleLabel(style: CitationStyleId, t: Translate, unavailable = false): string {
  const { catalogue, byId } = useStyleCatalogue.getState();
  return labelOf(style, t, byId.get(style), catalogue !== null, unavailable);
}

/** `styleLabel`, following the pack's list, which it asks for when `style` is one of its own. */
export function useStyleLabel(style: CitationStyleId | null | undefined, unavailable = false) {
  const t = useT();
  const needed = style !== null && style !== undefined && !commonCitationStyle(style);
  const known = useStyleCatalogue((state) => (style ? state.byId.get(style) : undefined));
  const loaded = useStyleCatalogue((state) => state.catalogue !== null);
  useEffect(() => {
    if (needed) useStyleCatalogue.getState().load();
  }, [needed]);
  return style === null || style === undefined
    ? null
    : labelOf(style, t, known, loaded, unavailable);
}

/**
 * Chooses a Mind's citation style, at once, which new Minds in its Folder then start in, and
 * offers Undo, which puts back both as they were (the Mind's "no choice", Numbered, if it had
 * none). Returns false if the core refused.
 */
export async function chooseCitationStyle(
  mindId: string,
  style: CitationStyleId,
  before: MindCitationStyle | null,
): Promise<boolean> {
  const { reportError } = useAppStore.getState();
  try {
    const previous = before ?? (await core.getMindCitationStyle(mindId));
    if (previous.chosen && previous.style === style) return true;
    await core.setMindCitationStyle(mindId, style);
    closeTip("citation-style");
    useUndo.getState().push({
      said: (t) => t("citationStyle.changed", { style: styleLabel(style, t) }),
      undo: async () => {
        await core.setMindCitationStyle(mindId, previous.chosen ? previous.style : null, {
          folderDefault: previous.folderDefault,
        });
      },
      redo: async () => {
        await core.setMindCitationStyle(mindId, style);
      },
    });
    return true;
  } catch (error) {
    reportError(error);
    return false;
  }
}
