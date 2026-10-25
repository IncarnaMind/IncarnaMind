import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  cssString,
  FONT_PRESETS,
  type FontPreset,
  familyOf,
  fontFamilyList,
  type LineSpacing,
  lineSpacingOf,
  sameFont,
  sameStyle,
  TEXT_SIZES,
} from "../../../shared/mindStyle";
import { CustomSpacing } from "../editor/FormatMenu";
import { LINE_SPACINGS } from "../editor/formatCommands";
import { useT } from "../i18n";
import { useMindStylePanel } from "../mindStylePanel";
import {
  chooseFont,
  chooseLineSpacing,
  chooseSize,
  installedFamilies,
  lineSpacingLabel,
  makeDefaultForNewMinds,
  SIZE_LABELS,
  useFontInstalled,
  useMindStyle,
  useNewMindStyle,
} from "../mindStyles";
import { CheckLineIcon } from "./lineIcons";
import { SearchPicker } from "./SearchPicker";
import {
  menuClass,
  menuItemClass,
  menuItemUnavailableClass,
  menuRuleClass,
  menuTitleClass,
  tallMenuItemClass,
} from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

const PRESET_LABELS = {
  default: "mindStyle.font.default",
  serif: "mindStyle.font.serif",
  mono: "mindStyle.font.mono",
} as const satisfies Record<FontPreset, string>;

const PRESET_FACES: Record<FontPreset, string> = {
  default: "var(--font-system)",
  serif: "var(--font-serif)",
  mono: "var(--font-mono)",
};

/**
 * Style: the font and text size of one Mind (DESIGN.md › Typography). A menu that opens beside
 * the button that asked for it, from the Mind's ⋯ and from ⌘K (`useMindStylePanel`);
 * `MindStyleChoices` is its contents.
 */
export function MindStyleHost() {
  const t = useT();
  const open = useMindStylePanel((state) => state.open);
  const picking = useMindStylePanel((state) => state.fonts);
  const menu = usePopoverMenu({ focus: "checked" });
  const fallback = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    menu.buttonProps.ref.current = open.anchor?.isConnected ? open.anchor : fallback.current;
    if (!menu.menuProps.ref.current?.matches(":popover-open")) {
      menu.menuProps.ref.current?.showPopover();
    }
  }, [open, menu.buttonProps.ref, menu.menuProps.ref]);

  const spacing = useMindStylePanel((state) => state.spacing);
  // Each opens beside the button that asked for Style once the menu is gone, as the menu would close under it.
  const besideAnchor = (show: (shown: { mindId: string; anchor: HTMLButtonElement }) => void) => {
    if (!open) return;
    const anchor = menu.buttonProps.ref.current;
    menu.close();
    if (anchor) requestAnimationFrame(() => show({ mindId: open.mindId, anchor }));
  };
  const pickFont = () =>
    besideAnchor(({ mindId, anchor }) => useMindStylePanel.getState().pickFont(mindId, anchor));

  return (
    <>
      <button
        ref={fallback}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none fixed top-12 left-1/2 size-0 p-0"
      />
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("mindStyle.title")}
        data-testid="mind-style"
        className={`${menuClass} w-[280px] max-w-[280px]`}
        onToggle={(event) => {
          menu.menuProps.onToggle(event);
          if (event.newState === "closed") {
            const { open: closed, fonts } = useMindStylePanel.getState();
            useMindStylePanel.getState().close();
            // Closed for Other fonts…, the list takes the focus, whichever of them comes first.
            if (!fonts && closed?.anchor?.isConnected) closed.anchor.focus();
          }
        }}
      >
        {open && (
          <MindStyleChoices
            mindId={open.mindId}
            close={menu.close}
            onOtherFonts={pickFont}
            onCustomLineSpacing={() =>
              besideAnchor(({ mindId, anchor }) =>
                useMindStylePanel.getState().typeSpacing(mindId, anchor),
              )
            }
          />
        )}
      </div>
      {spacing && (
        <CustomLineSpacing
          mindId={spacing.mindId}
          anchor={spacing.anchor}
          onClose={() => useMindStylePanel.getState().closeSpacing()}
        />
      )}
      {picking && (
        <FontPicker
          mindId={picking.mindId}
          anchor={picking.anchor}
          onClose={() => useMindStylePanel.getState().closeFonts()}
        />
      )}
    </>
  );
}

/** What Style is set to, as a menu shows it beside Style: the font, and the size unless it is the default. */
export function useStyleValue(mindId: string): string {
  const t = useT();
  const { font, size } = useMindStyle(mindId);
  const name = typeof font === "string" ? t(PRESET_LABELS[font]) : font.family;
  return size === "default" ? name : `${name} · ${t(SIZE_LABELS[size])}`;
}

/**
 * What Style offers, as menu items: the three fonts, the other fonts, the text size, and the
 * default for new Minds. A choice of font or size shows on the Mind's page at once and stays
 * open for the next; `close` is for what is done with.
 */
export function MindStyleChoices({
  mindId,
  close,
  onOtherFonts,
  onCustomLineSpacing,
}: {
  mindId: string;
  close(): void;
  onOtherFonts(): void;
  onCustomLineSpacing(): void;
}) {
  return (
    <>
      <FontChoices mindId={mindId} onOtherFonts={onOtherFonts} />
      <div className={menuRuleClass} />
      <SizeChoice mindId={mindId} />
      <div className={menuRuleClass} />
      <LineSpacingChoice mindId={mindId} onCustom={onCustomLineSpacing} />
      <div className={menuRuleClass} />
      <MakeDefault mindId={mindId} close={close} />
    </>
  );
}

function FontChoices({ mindId, onOtherFonts }: { mindId: string; onOtherFonts(): void }) {
  const t = useT();
  const { font } = useMindStyle(mindId);
  const installed = useFontInstalled(font);
  const family = familyOf(font);
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a menu's radio items are grouped by role; a fieldset is for a form's. */}
      <div role="group" aria-label={t("mindStyle.font")} className="grid grid-cols-3 gap-1 px-1">
        {FONT_PRESETS.map((preset) => {
          const chosen = font === preset;
          return (
            <button
              key={preset}
              type="button"
              role="menuitemradio"
              aria-checked={chosen}
              data-testid={`mind-style-font-${preset}`}
              onClick={() => void chooseFont(mindId, preset)}
              className={`flex h-16 flex-col items-center justify-center gap-0.5 rounded-md text-[12px] leading-4 -outline-offset-2 hover:bg-hover ${
                chosen
                  ? "text-ink shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
                  : "text-ink-secondary"
              }`}
            >
              <span
                className="text-[22px] leading-7 text-ink"
                style={{ fontFamily: PRESET_FACES[preset] }}
              >
                Ag
              </span>
              <span>{t(PRESET_LABELS[preset])}</span>
            </button>
          );
        })}
      </div>
      {family !== null && (
        <button
          type="button"
          role="menuitemradio"
          aria-checked="true"
          data-testid="mind-style-font-other-chosen"
          data-installed={installed}
          className={`${tallMenuItemClass} mt-1 pl-2`}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <CheckLineIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span
              className="block truncate"
              title={family}
              style={{ fontFamily: fontFamilyList(font, installed) }}
            >
              {family}
            </span>
            {!installed && (
              <span className="block text-[12px] leading-4 text-ink-meta">
                {t("mindStyle.font.missing")}
              </span>
            )}
          </span>
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        data-testid="mind-style-other-fonts"
        onClick={onOtherFonts}
        className={`${menuItemClass} mt-1 px-2`}
      >
        <span className="min-w-0 flex-1 truncate">{t("mindStyle.font.other")}</span>
      </button>
    </>
  );
}

function SizeChoice({ mindId }: { mindId: string }) {
  const t = useT();
  const { size } = useMindStyle(mindId);
  return (
    <>
      <p className={menuTitleClass}>{t("mindStyle.size")}</p>
      {/* biome-ignore lint/a11y/useSemanticElements: a menu's radio items are grouped by role; a fieldset is for a form's. */}
      <div
        role="group"
        aria-label={t("mindStyle.size")}
        className="mx-2 mt-0.5 mb-1.5 grid grid-cols-3 gap-0.5 rounded-lg bg-chip p-0.5"
      >
        {TEXT_SIZES.map((each) => {
          const chosen = size === each;
          return (
            <button
              key={each}
              type="button"
              role="menuitemradio"
              aria-checked={chosen}
              data-testid={`mind-style-size-${each}`}
              onClick={() => void chooseSize(mindId, each)}
              className={`h-6 truncate rounded-md px-1 text-[13px] leading-5 -outline-offset-2 ${
                chosen
                  ? "bg-sheet font-semibold text-ink shadow-[0_0_0_1px_var(--color-rule),0_1px_2px_rgb(23_25_28/0.08)]"
                  : "text-ink-secondary hover:text-ink"
              }`}
            >
              {t(SIZE_LABELS[each])}
            </button>
          );
        })}
      </div>
    </>
  );
}

const LINE_SPACING_CHOICES: readonly LineSpacing[] = ["default", ...LINE_SPACINGS];

/** As Text size is chosen, so Style stays short enough to open beside its item in the page's ⋯. */
function LineSpacingChoice({ mindId, onCustom }: { mindId: string; onCustom(): void }) {
  const t = useT();
  const lineSpacing = lineSpacingOf(useMindStyle(mindId));
  const typed = !LINE_SPACING_CHOICES.includes(lineSpacing);
  return (
    <>
      <p className={menuTitleClass}>{t("mindStyle.lineSpacing")}</p>
      {/* biome-ignore lint/a11y/useSemanticElements: a menu's radio items are grouped by role; a fieldset is for a form's. */}
      <div
        role="group"
        aria-label={t("mindStyle.lineSpacing")}
        className="mx-2 mt-0.5 mb-1 flex gap-0.5 rounded-lg bg-chip p-0.5"
      >
        {LINE_SPACING_CHOICES.map((each) => {
          const chosen = lineSpacing === each;
          return (
            <button
              key={each}
              type="button"
              role="menuitemradio"
              aria-checked={chosen}
              data-testid={`mind-style-line-${each}`}
              onClick={() => void chooseLineSpacing(mindId, each)}
              className={`h-6 flex-auto truncate rounded-md px-1 text-[13px] leading-5 -outline-offset-2 ${
                chosen
                  ? "bg-sheet font-semibold text-ink shadow-[0_0_0_1px_var(--color-rule),0_1px_2px_rgb(23_25_28/0.08)]"
                  : "text-ink-secondary hover:text-ink"
              }`}
            >
              {lineSpacingLabel(each)}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={typed}
        data-testid="mind-style-line-custom"
        onClick={onCustom}
        className={`${menuItemClass} px-2`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {typed && <CheckLineIcon className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {`${t("format.lineSpacing.custom")}${typed ? ` ${lineSpacing}` : ""}`}
        </span>
      </button>
    </>
  );
}

function CustomLineSpacing({
  mindId,
  anchor,
  onClose,
}: {
  mindId: string;
  anchor: HTMLButtonElement;
  onClose(): void;
}) {
  const lineSpacing = lineSpacingOf(useMindStyle(mindId));
  return (
    <CustomSpacing
      anchor={anchor}
      current={typeof lineSpacing === "number" ? lineSpacing : null}
      onApply={(multiple) => {
        onClose();
        void chooseLineSpacing(mindId, multiple);
      }}
      onClose={() => {
        onClose();
        if (anchor.isConnected) anchor.focus();
      }}
    />
  );
}

function MakeDefault({ mindId, close }: { mindId: string; close(): void }) {
  const t = useT();
  const style = useMindStyle(mindId);
  const already = sameStyle(style, useNewMindStyle());
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={already || undefined}
      data-testid="mind-style-make-default"
      title={already ? t("mindStyle.makeDefault.already") : undefined}
      onClick={() => {
        if (already) return;
        close();
        void makeDefaultForNewMinds(style);
      }}
      className={`${menuItemClass} ${menuItemUnavailableClass} px-2`}
    >
      <span className="min-w-0 flex-1 truncate">{t("mindStyle.makeDefault")}</span>
    </button>
  );
}

function FontPicker({
  mindId,
  anchor,
  onClose,
}: {
  mindId: string;
  anchor: HTMLButtonElement;
  onClose(): void;
}) {
  const t = useT();
  const { font } = useMindStyle(mindId);
  return (
    <InstalledFontPicker
      anchor={anchor}
      current={familyOf(font)}
      currentLabel={t("mindStyle.font.current")}
      onChoose={(family) => {
        if (!sameFont(font, { family })) void chooseFont(mindId, { family });
      }}
      onClose={onClose}
      testId="mind-style-font"
    />
  );
}

/** The fonts installed on this computer, each name in its own face, found by typing. */
export function InstalledFontPicker({
  anchor,
  current,
  currentLabel,
  onChoose,
  onClose,
  testId,
}: {
  anchor: HTMLElement;
  current: string | null;
  currentLabel: string;
  onChoose(family: string): void;
  onClose(): void;
  testId: string;
}) {
  const t = useT();
  const [families, setFamilies] = useState<readonly string[] | null>(null);
  useEffect(() => {
    void installedFamilies().then(setFamilies);
  }, []);

  const options = (families ?? []).map((family) => ({
    id: family,
    label: family,
    labelStyle: { fontFamily: `${cssString(family)}, var(--font-system)` },
    data: { "data-font": family },
  }));
  return (
    <SearchPicker<string>
      anchor={anchor}
      title={t("mindStyle.font.pickerTitle")}
      searchLabel={t("mindStyle.font.search")}
      noMatch={(query) =>
        families === null
          ? t("mindStyle.font.loading")
          : families.length === 0
            ? t("mindStyle.font.none")
            : t("mindStyle.font.noMatch", { query })
      }
      options={options}
      current={current ?? undefined}
      currentLabel={currentLabel}
      onChoose={onChoose}
      onClose={onClose}
      testId={testId}
      className="w-72"
    />
  );
}
