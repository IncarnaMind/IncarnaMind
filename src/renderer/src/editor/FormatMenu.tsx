import type { VirtualElement } from "@floating-ui/dom";
import { type Editor, useEditorState } from "@tiptap/react";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { SUBSCRIPT_MARK, SUPERSCRIPT_MARK } from "../../../core/api";
import type { CommandId } from "../../../shared/commands";
import type { MessageKey } from "../../../shared/i18n";
import { exportedFamily, FONT_PRESETS, type FontPreset } from "../../../shared/mindStyle";
import { keysHere } from "../commands/keymap";
import { commands } from "../commands/registry";
import { ChevronIcon } from "../components/icons";
import { CheckLineIcon } from "../components/lineIcons";
import { InstalledFontPicker } from "../components/MindStyle";
import { buttonStyle, fieldClass } from "../components/ui";
import { useT } from "../i18n";
import {
  ALIGNS,
  type Align,
  changeIndent,
  formatState,
  LINE_SPACINGS,
  setAlign,
  setLineSpacing,
  setTextColor,
  setTextFont,
  setTextSize,
  shownSize,
  TEXT_COLORS,
  TEXT_SIZES,
  toggleFirstLineIndent,
  toggleRaise,
  toggleSpaceAfter,
  toggleSpaceBefore,
} from "./formatCommands";
import { keepSelection, submenuOpensOnRight, useMenuKeys } from "./menuKeys";
import { NumberingChoices, SCHEME_NAMES, schemePreview } from "./NumberingMenu";
import { numberingState } from "./numbering";
import { Popover } from "./Popover";

const ALIGN_LABELS = {
  left: "format.align.left",
  center: "format.align.center",
  right: "format.align.right",
  justify: "format.align.justify",
} as const satisfies Record<Align, MessageKey>;

const ALIGN_COMMANDS = {
  left: "format.alignLeft",
  center: "format.alignCenter",
  right: "format.alignRight",
  justify: "format.justify",
} as const;

const ALIGN_LINES: Record<Align, string> = {
  left: "M4 6h16M4 10h10M4 14h16M4 18h10",
  center: "M4 6h16M7 10h10M4 14h16M7 18h10",
  right: "M4 6h16M10 10h10M4 14h16M10 18h10",
  justify: "M4 6h16M4 10h16M4 14h16M4 18h16",
};

const PRESET_LABELS = {
  default: "mindStyle.font.default",
  serif: "mindStyle.font.serif",
  mono: "mindStyle.font.mono",
} as const satisfies Record<FontPreset, MessageKey>;

const PRESET_FACES: Record<FontPreset, string> = {
  default: "var(--writing-font, var(--font-system))",
  serif: "var(--font-serif)",
  mono: "var(--font-mono)",
};

/** A preset's family as the text's font mark keeps it; null for the paragraph's own. */
const presetFamily = (preset: FontPreset) => (preset === "default" ? null : exportedFamily(preset));

export const spacingLabel = (multiple: number, t: ReturnType<typeof useT>) =>
  multiple === 1
    ? t("format.lineSpacing.single")
    : multiple === 2
      ? t("format.lineSpacing.double")
      : String(multiple);

function Glyph({ d, children }: { d?: string; children?: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4 shrink-0"
    >
      {d && <path d={d} />}
      {children}
    </svg>
  );
}

type Open = "spacing" | "font" | "size" | "custom" | "fonts" | "numbering" | null;

/**
 * The selection menu's Aa (DESIGN.md › Typography): the font and size of the selected text,
 * the alignment, line spacing and indents of the paragraphs it touches, its colour, and
 * superscript and subscript. Each choice applies at once, as one Undo step, and the menu stays
 * open for the next.
 */
export function FormatMenu({
  editor,
  anchor,
  placement,
  focus,
  onClose,
}: {
  editor: Editor;
  anchor: Element | VirtualElement;
  placement: "right-start" | "bottom-start";
  focus: boolean;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      ...formatState(current),
      size: shownSize(current),
      scheme: numberingState(current).scheme,
    }),
  });
  const [open, setOpen] = useState<{ which: Open; anchor: HTMLElement | null; focus: boolean }>({
    which: null,
    anchor: null,
    focus: false,
  });
  const first = useRef<HTMLButtonElement>(null);
  const { menu, onKeyDown } = useMenuKeys(onClose, false);

  const act = (run: () => unknown) => {
    if (editor.view.composing) return;
    run();
  };
  const openBeside = (which: Open, event: { currentTarget: HTMLElement; detail: number }) => {
    // Read now: React empties the event's currentTarget once its handlers have run.
    const anchor = event.currentTarget;
    const focus = event.detail === 0;
    setOpen((now) =>
      now.which === which ? { which: null, anchor: null, focus: false } : { which, anchor, focus },
    );
  };
  const closeSub = (refocus: boolean) => {
    const back = open.anchor;
    setOpen({ which: null, anchor: null, focus: false });
    if (refocus) back?.focus();
  };
  const fontLabel =
    state.font === null
      ? t("mindStyle.font.default")
      : state.font === exportedFamily("serif")
        ? t("mindStyle.font.serif")
        : state.font === exportedFamily("mono")
          ? t("mindStyle.font.mono")
          : state.font;
  const lineValue = state.line?.rule === "auto" ? state.line.value : null;

  return (
    <Popover
      anchor={anchor}
      placement={placement}
      initialFocus={focus ? first : undefined}
      role="menu"
      aria-label={t("format.menu")}
      data-testid="format-menu"
      onDismiss={(how) => {
        if (open.which === null) onClose(how === "escape");
      }}
      onKeyDown={(event) => {
        if (submenuOpensOnRight(event)) return;
        onKeyDown(event);
      }}
      className="editor-menu format-menu"
    >
      <div ref={menu} className="contents">
        <div className="format-menu-pickers">
          <button
            ref={first}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open.which === "font"}
            data-testid="format-font"
            title={t("format.font")}
            onMouseDown={keepSelection}
            onClick={(event) => openBeside("font", event)}
            className="format-menu-picker"
          >
            <span className="min-w-0 truncate">{fontLabel}</span>
            <ChevronIcon className="size-3 shrink-0 rotate-90 text-ink-meta" />
          </button>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open.which === "size"}
            data-testid="format-size"
            title={t("format.size")}
            onMouseDown={keepSelection}
            onClick={(event) => openBeside("size", event)}
            className="format-menu-picker"
          >
            <span className="min-w-0 truncate">{state.size ?? t("format.size.default")}</span>
            <ChevronIcon className="size-3 shrink-0 rotate-90 text-ink-meta" />
          </button>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a menu's radio items are grouped by role; a fieldset is for a form's. */}
        <div role="group" aria-label={t("format.alignment")} className="format-menu-aligns">
          {ALIGNS.map((align) => (
            <button
              key={align}
              type="button"
              role="menuitemradio"
              aria-checked={state.align === align}
              aria-label={t(ALIGN_LABELS[align])}
              data-testid={`format-align-${align}`}
              title={keyedTitle(t(ALIGN_LABELS[align]), ALIGN_COMMANDS[align])}
              onMouseDown={keepSelection}
              onClick={() => act(() => setAlign(editor, align))}
              className="format-menu-align"
            >
              <Glyph d={ALIGN_LINES[align]} />
            </button>
          ))}
        </div>
        <hr className="selection-rule" />
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open.which === "spacing"}
          data-testid="format-line-spacing"
          onMouseDown={keepSelection}
          onClick={(event) => openBeside("spacing", event)}
          className="editor-menu-item format-menu-row"
        >
          <Glyph d="M11 6h9M11 12h9M11 18h9M5.5 4v16m-2-14 2-2 2 2m-4 12 2 2 2-2" />
          <span className="min-w-0 flex-1 truncate">{t("format.lineSpacing")}</span>
          <ChevronIcon className="size-3 shrink-0 text-ink-meta" />
        </button>
        <Row
          testId="format-indent-increase"
          glyph="M4 5h16M11 10h9M11 14h9M4 19h16m0-9.5 3 2.5-3 2.5"
          label={t("format.indent.increase")}
          keys={keysOf("format.indent")}
          onClick={() => act(() => changeIndent(editor, 1))}
        />
        <Row
          testId="format-indent-decrease"
          glyph="M4 5h16M11 10h9M11 14h9M4 19h16M7 9.5 4 12l3 2.5"
          label={t("format.indent.decrease")}
          keys={keysOf("format.outdent")}
          onClick={() => act(() => changeIndent(editor, -1))}
        />
        <Row
          testId="format-first-line"
          glyph="M11 6h9M4 10.5h16M4 15h16M4 19.5h11M4 3.5 7 6 4 8.5"
          label={t("format.firstLine")}
          checked={state.firstLineChars}
          onClick={() => act(() => toggleFirstLineIndent(editor))}
        />
        <button
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open.which === "numbering"}
          data-testid="format-numbering"
          onMouseDown={keepSelection}
          onClick={(event) => openBeside("numbering", event)}
          className="editor-menu-item format-menu-row"
        >
          <Glyph d="M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M4 9h3M4 14.2c.4-.9 2.6-.9 2.6.3 0 1-2.6 1.8-2.6 3.5h2.8" />
          <span className="min-w-0 flex-1 truncate">{t("numbering.menu")}</span>
          <span className="editor-menu-shortcut truncate">
            {state.scheme ? t(SCHEME_NAMES[state.scheme]) : schemePreview("default")}
          </span>
          <ChevronIcon className="size-3 shrink-0 text-ink-meta" />
        </button>
        <hr className="selection-rule" />
        <p aria-hidden="true" className="format-menu-section">
          {t("format.color")}
        </p>
        {/* biome-ignore lint/a11y/useSemanticElements: a menu's radio items are grouped by role; a fieldset is for a form's. */}
        <div role="group" aria-label={t("format.color")}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={state.color === null}
            data-testid="format-color-automatic"
            onMouseDown={keepSelection}
            onClick={() => act(() => setTextColor(editor, null))}
            className="editor-menu-item format-menu-row"
          >
            <span aria-hidden="true" className="format-menu-swatch bg-ink" />
            <span className="min-w-0 flex-1 truncate">{t("format.color.automatic")}</span>
            {state.color === null && <CheckLineIcon className="size-3.5 shrink-0 text-ink-meta" />}
          </button>
          <div className="format-menu-swatches">
            {TEXT_COLORS.map(({ id, color }) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={state.color === color}
                aria-label={t(`format.color.${id}`)}
                title={t(`format.color.${id}`)}
                data-testid={`format-color-${id}`}
                onMouseDown={keepSelection}
                onClick={() => act(() => setTextColor(editor, color))}
                className="format-menu-swatch"
                style={{ backgroundColor: `#${color}` }}
              />
            ))}
          </div>
        </div>
        <hr className="selection-rule" />
        <Row
          testId="format-superscript"
          glyph={<RaisedGlyph raised />}
          label={t("format.superscript")}
          checked={state.superscript}
          onClick={() => act(() => toggleRaise(editor, SUPERSCRIPT_MARK))}
        />
        <Row
          testId="format-subscript"
          glyph={<RaisedGlyph raised={false} />}
          label={t("format.subscript")}
          checked={state.subscript}
          onClick={() => act(() => toggleRaise(editor, SUBSCRIPT_MARK))}
        />
      </div>
      {open.which === "spacing" && open.anchor && (
        <SpacingMenu
          editor={editor}
          anchor={open.anchor}
          focus={open.focus}
          current={lineValue}
          spaceBefore={state.spaceBefore}
          spaceAfter={state.spaceAfter}
          onCustom={() => setOpen((now) => ({ ...now, which: "custom" }))}
          onClose={closeSub}
        />
      )}
      {open.which === "custom" && open.anchor && (
        <CustomSpacing
          anchor={open.anchor}
          current={lineValue}
          onApply={(multiple) => {
            closeSub(true);
            act(() => setLineSpacing(editor, multiple));
          }}
          onClose={closeSub}
        />
      )}
      {open.which === "numbering" && open.anchor && (
        <NumberingChoices
          editor={editor}
          anchor={open.anchor}
          placement="right-start"
          focus={open.focus}
          withOrder
          submenu
          onChosen={() => {
            closeSub(false);
            onClose(true);
          }}
          onClose={closeSub}
        />
      )}
      {open.which === "font" && open.anchor && (
        <ChoiceList
          anchor={open.anchor}
          focus={open.focus}
          label={t("format.font")}
          testId="format-fonts"
          choices={[
            ...FONT_PRESETS.map((preset) => ({
              id: preset,
              label: t(PRESET_LABELS[preset]),
              style: { fontFamily: PRESET_FACES[preset] },
              checked: state.font === presetFamily(preset),
              run: () => act(() => setTextFont(editor, presetFamily(preset))),
            })),
            {
              id: "other",
              label: t("mindStyle.font.other"),
              checked:
                state.font !== null &&
                !FONT_PRESETS.some((each) => presetFamily(each) === state.font),
              run: () => setOpen((now) => ({ ...now, which: "fonts", focus: true })),
            },
          ]}
          onClose={closeSub}
        />
      )}
      {open.which === "fonts" && open.anchor && (
        <InstalledFontPicker
          anchor={open.anchor}
          current={state.font}
          currentLabel={t("format.font.current")}
          onChoose={(family) => act(() => setTextFont(editor, family))}
          onClose={() => closeSub(true)}
          testId="format-font"
        />
      )}
      {open.which === "size" && open.anchor && (
        <ChoiceList
          anchor={open.anchor}
          focus={open.focus}
          label={t("format.size")}
          testId="format-sizes"
          className="format-menu-sizes"
          choices={[
            {
              id: "default",
              label: t("format.size.default"),
              checked: false,
              run: () => act(() => setTextSize(editor, null)),
            },
            ...TEXT_SIZES.map((size) => ({
              id: String(size),
              label: String(size),
              checked: state.size === size,
              run: () => act(() => setTextSize(editor, size)),
            })),
          ]}
          onClose={closeSub}
        />
      )}
    </Popover>
  );
}

function keysOf(id: CommandId): string | undefined {
  const keys = commands.get(id)?.shortcut?.keys;
  return keys ? keysHere(keys) : undefined;
}

function keyedTitle(label: string, id: CommandId): string {
  const keys = keysOf(id);
  return keys ? `${label} (${keys})` : label;
}

function RaisedGlyph({ raised }: { raised: boolean }) {
  return (
    <span aria-hidden="true" className="format-raise">
      x{raised ? <sup>2</sup> : <sub>2</sub>}
    </span>
  );
}

function Row({
  testId,
  glyph,
  label,
  keys,
  checked,
  onClick,
}: {
  testId: string;
  glyph: string | ReactNode;
  label: string;
  keys?: string;
  checked?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      {...(checked === undefined
        ? { role: "menuitem" }
        : { role: "menuitemcheckbox", "aria-checked": checked })}
      aria-keyshortcuts={keys}
      data-testid={testId}
      onMouseDown={keepSelection}
      onClick={onClick}
      className="editor-menu-item format-menu-row"
    >
      {typeof glyph === "string" ? <Glyph d={glyph} /> : glyph}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && <span className="editor-menu-shortcut">{keys}</span>}
      {checked && <CheckLineIcon className="size-3.5 shrink-0 text-ink-meta" />}
    </button>
  );
}

interface Choice {
  id: string;
  label: string;
  style?: CSSProperties;
  checked: boolean;
  run(): void;
}

/** A submenu of choices beside its row; choosing one keeps the Aa menu open. */
function ChoiceList({
  anchor,
  focus,
  label,
  testId,
  choices,
  className = "w-[200px]",
  onClose,
}: {
  anchor: HTMLElement;
  focus: boolean;
  label: string;
  testId: string;
  choices: readonly Choice[];
  className?: string;
  onClose(refocus: boolean): void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  const { menu, onKeyDown } = useMenuKeys(onClose, true);
  const chosen = Math.max(
    0,
    choices.findIndex((choice) => choice.checked),
  );
  return (
    <Popover
      anchor={anchor}
      placement="right-start"
      initialFocus={focus ? first : undefined}
      role="menu"
      aria-label={label}
      data-testid={testId}
      onDismiss={(how) => onClose(how === "escape")}
      onKeyDown={onKeyDown}
      className={`editor-menu ${className}`}
    >
      <div ref={menu} className="contents">
        {choices.map((choice, index) => (
          <button
            key={choice.id}
            ref={index === chosen ? first : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={choice.checked}
            data-testid={`${testId}-${choice.id}`}
            onMouseDown={keepSelection}
            onClick={choice.run}
            className="editor-menu-item"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {choice.checked && <CheckLineIcon className="size-4" />}
            </span>
            <span className="min-w-0 truncate" style={choice.style}>
              {choice.label}
            </span>
          </button>
        ))}
      </div>
    </Popover>
  );
}

function SpacingMenu({
  editor,
  anchor,
  focus,
  current,
  spaceBefore,
  spaceAfter,
  onCustom,
  onClose,
}: {
  editor: Editor;
  anchor: HTMLElement;
  focus: boolean;
  current: number | null;
  spaceBefore: boolean;
  spaceAfter: boolean;
  onCustom(): void;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const first = useRef<HTMLButtonElement>(null);
  const { menu, onKeyDown } = useMenuKeys(onClose, true);
  const custom = current !== null && !LINE_SPACINGS.some((each) => each === current);
  return (
    <Popover
      anchor={anchor}
      placement="right-start"
      initialFocus={focus ? first : undefined}
      role="menu"
      aria-label={t("format.lineSpacing")}
      data-testid="format-line-spacing-menu"
      onDismiss={(how) => onClose(how === "escape")}
      onKeyDown={onKeyDown}
      className="editor-menu w-[240px]"
    >
      <div ref={menu} className="contents">
        {LINE_SPACINGS.map((multiple, index) => (
          <button
            key={multiple}
            ref={index === 0 ? first : undefined}
            type="button"
            role="menuitemradio"
            aria-checked={current === multiple}
            data-testid={`format-line-spacing-${multiple}`}
            onMouseDown={keepSelection}
            onClick={() => setLineSpacing(editor, multiple)}
            className="editor-menu-item"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {current === multiple && <CheckLineIcon className="size-4" />}
            </span>
            <span className="min-w-0 truncate">{spacingLabel(multiple, t)}</span>
          </button>
        ))}
        <button
          type="button"
          role="menuitemradio"
          aria-checked={custom}
          data-testid="format-line-spacing-custom"
          onMouseDown={keepSelection}
          onClick={onCustom}
          className="editor-menu-item"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            {custom && <CheckLineIcon className="size-4" />}
          </span>
          <span className="min-w-0 truncate">
            {t("format.lineSpacing.custom")}
            {custom ? ` ${current}` : ""}
          </span>
        </button>
        <hr className="selection-rule" />
        <button
          type="button"
          role="menuitem"
          data-testid="format-space-before"
          onMouseDown={keepSelection}
          onClick={() => toggleSpaceBefore(editor)}
          className="editor-menu-item"
        >
          <span className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            {t(spaceBefore ? "format.spaceBefore.remove" : "format.spaceBefore.add")}
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          data-testid="format-space-after"
          onMouseDown={keepSelection}
          onClick={() => toggleSpaceAfter(editor)}
          className="editor-menu-item"
        >
          <span className="size-4 shrink-0" />
          <span className="min-w-0 truncate">
            {t(spaceAfter ? "format.spaceAfter.remove" : "format.spaceAfter.add")}
          </span>
        </button>
      </div>
    </Popover>
  );
}

const LEAST_SPACING = 0.5;
const MOST_SPACING = 5;

/** Custom…: a line spacing typed as a multiple, applied with Enter. */
export function CustomSpacing({
  anchor,
  current,
  onApply,
  onClose,
}: {
  anchor: HTMLElement | VirtualElement;
  current: number | null;
  onApply(multiple: number): void;
  onClose(refocus: boolean): void;
}) {
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(current === null ? "" : String(current));
  const [invalid, setInvalid] = useState(false);
  const apply = () => {
    const multiple = Number(typed.trim().replace(",", "."));
    if (!Number.isFinite(multiple) || multiple < LEAST_SPACING || multiple > MOST_SPACING) {
      setInvalid(true);
      field.current?.focus();
      return;
    }
    onApply(Math.round(multiple * 100) / 100);
  };
  return (
    <Popover
      anchor={anchor}
      placement="right-start"
      initialFocus={field}
      aria-label={t("format.lineSpacing.customTitle")}
      data-testid="format-line-spacing-field"
      onDismiss={(how) => onClose(how === "escape")}
      className="editor-menu format-spacing-field"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        className="flex flex-col gap-1.5 p-1"
      >
        <label className="format-menu-section p-0" htmlFor="format-spacing-input">
          {t("format.lineSpacing.customTitle")}
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="format-spacing-input"
            ref={field}
            inputMode="decimal"
            value={typed}
            aria-invalid={invalid || undefined}
            aria-describedby="format-spacing-hint"
            onChange={(event) => {
              setTyped(event.target.value);
              setInvalid(false);
            }}
            className={`${fieldClass} h-7 min-w-0 flex-1`}
          />
          <button type="submit" className={buttonStyle("secondary", "sm")}>
            {t("format.lineSpacing.apply")}
          </button>
        </div>
        <p
          id="format-spacing-hint"
          className={invalid ? "text-[12px] leading-4 text-warning" : "math-hint"}
        >
          {t(invalid ? "format.lineSpacing.customInvalid" : "format.lineSpacing.customHint")}
        </p>
      </form>
    </Popover>
  );
}
