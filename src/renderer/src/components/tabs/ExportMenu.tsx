import { Fragment, type ReactNode, useEffect } from "react";
import { type DocumentKind, EXPORT_FORMATS, type ExportFormat } from "../../../../core/api";
import type { CommandId } from "../../../../shared/commands";
import { useChecks } from "../../checks";
import { useMindFormatting } from "../../citationFormatting";
import { useCitationStylePicker, useStyleLabel } from "../../citationStylePicker";
import { shortcutLabel } from "../../commands/keymap";
import { commands } from "../../commands/registry";
import { ClaimMarkIcon } from "../../editor/icons";
import { takeExportMenuRequest, useExportMenuRequests } from "../../exportMenuRequest";
import { FORMAT_LABELS, useExports } from "../../exports";
import { useMindNoteStates } from "../../home";
import { useLanguage, useT } from "../../i18n";
import { showCheckCard, startCheckThisMind } from "../../mindCheck";
import { noteStateParts } from "../../noteState";
import { useAppStore } from "../../store";
import {
  ChevronRightLineIcon,
  DocumentLineIcon,
  ExportLineIcon,
  MoreLineIcon,
  SettingsLineIcon,
} from "../lineIcons";
import { menuClass, menuItemClass, menuRuleClass, tallMenuItemClass } from "../ui";
import { usePopoverMenu, useSubmenu } from "../usePopoverMenu";

const MAIN_FORMATS: readonly ExportFormat[] = ["docx", "pdf"];

function exportChoices(last: ExportFormat): { shown: ExportFormat[]; more: ExportFormat[] } {
  const shown = [last, ...MAIN_FORMATS.filter((format) => format !== last)];
  return { shown, more: EXPORT_FORMATS.filter((format) => !shown.includes(format)) };
}

const ICON_KIND: Readonly<Record<ExportFormat, DocumentKind>> = {
  docx: "docx",
  pdf: "pdf",
  "source-pack": "pdf",
  html: "web",
  "share-page": "web",
  markdown: "markdown",
};

function FormatIcon({ format }: { format: ExportFormat }) {
  return <DocumentLineIcon kind={ICON_KIND[format]} className="size-4 shrink-0 text-ink-meta" />;
}

function Item({
  testId,
  icon,
  label,
  hint,
  onClick,
}: {
  testId: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={onClick}
      // A long hint (a style's name) wraps under itself rather than being cut short.
      className={`${tallMenuItemClass} pl-2`}
    >
      {icon}
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {hint && (
        <span className="max-w-56 min-w-0 pl-4 text-right text-[13px] leading-5 break-keep text-ink-meta">
          {hint}
        </span>
      )}
    </button>
  );
}

export function ExportMenu({ mindId }: { mindId: string }) {
  const t = useT();
  const language = useLanguage();
  const menu = usePopoverMenu({ focus: "first", align: "end" });
  const submenu = useSubmenu();
  const last = useAppStore((state) => state.settings?.user.exportOptions.format ?? "docx");
  const saving = useExports(
    (state) => state.result?.mindId === mindId && state.result.state === "saving",
  );
  // The style the export is written in, as the Mind's editor last formatted it.
  const formatting = useMindFormatting(mindId);
  const styleName = useStyleLabel(formatting?.style, formatting?.formatted?.unavailable === true);
  const { shown, more } = exportChoices(last);
  // Where the note stands (D266), read only while its menu is open.
  const mind = useAppStore((state) => state.minds.find((each) => each.id === mindId) ?? null);
  const states = useMindNoteStates(menu.open && mind ? [mind] : []);
  const noteState = mind ? (states.get(mind.id) ?? null) : null;
  const running = useChecks((state) => state.running[mindId] !== undefined);
  // The state's own line, never a block on the export (D266): a run in flight opens the card at
  // its progress, not checked starts a Check, and needs a look opens the card at its marks.
  const stateLine = running
    ? {
        label: `${t("export.running")} · ${t("export.show")}`,
        run: () => showCheckCard(mindId),
      }
    : noteState === null || noteState.kind === "checked"
      ? null
      : noteState.kind === "needs-look"
        ? {
            label: `${noteStateParts(noteState, t, language).join(" · ")} · ${t("export.show")}`,
            run: () => showCheckCard(mindId),
          }
        : {
            label: t("export.checkFirst"),
            run: () => {
              startCheckThisMind(mindId).catch(useAppStore.getState().reportError);
            },
          };

  // "Export…" in a Mind's menus: this Mind's button opens its menu, as if it had been clicked.
  const asked = useExportMenuRequests((state) => state.request);
  const button = menu.buttonProps.ref;
  useEffect(() => {
    if (asked?.mindId === mindId && takeExportMenuRequest(mindId)) button.current?.click();
  }, [asked, mindId, button]);

  const run = (id: CommandId) => {
    menu.close();
    commands
      .run(id, { focus: { kind: "mind", id: mindId }, surface: "mind" })
      .catch(useAppStore.getState().reportError);
  };
  // The last format is "mind.export", with its keys; "mind.exportAs" isn't offered for it.
  const exportAs = (format: ExportFormat) =>
    run(format === last ? "mind.export" : `mind.exportAs.${format}`);
  const formatItem = (format: ExportFormat, hint?: string) => (
    <Item
      key={format}
      testId={`export-as-${format}`}
      icon={<FormatIcon format={format} />}
      label={t(FORMAT_LABELS[format])}
      {...(hint && { hint })}
      onClick={() => exportAs(format)}
    />
  );

  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="export-mind"
        data-format={last}
        aria-busy={saving || undefined}
        className="tab-export"
      >
        <ExportLineIcon />
        <span>{t("export.action")}</span>
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("export.action")}
        data-testid="export-menu"
        className={menuClass}
      >
        {menu.open && (
          <>
            {shown.map((format, index) => (
              <Fragment key={format}>
                {formatItem(format, index === 0 ? shortcutLabel("mind.export") : undefined)}
                {format === "docx" && stateLine !== null && (
                  // Under Word, one entry for the note's state; it never blocks the export (D266).
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="export-note-state"
                    data-state={running ? "running" : noteState?.kind}
                    className={`${tallMenuItemClass} pl-2 text-[13px] leading-5 text-ink-secondary`}
                    onClick={() => {
                      menu.close();
                      stateLine.run();
                    }}
                  >
                    <ClaimMarkIcon state="not-checked" className="size-4 shrink-0" />
                    <span className="flex-1">{stateLine.label}</span>
                  </button>
                )}
              </Fragment>
            ))}
            <button
              {...submenu.itemProps}
              type="button"
              data-testid="export-more"
              className={`${menuItemClass} pl-2 aria-expanded:bg-hover`}
            >
              <MoreLineIcon className="size-4 shrink-0 text-ink-meta" />
              <span className="flex-1">{t("export.more")}</span>
              <ChevronRightLineIcon className="size-3.5 text-ink-meta" />
            </button>
            <div className={menuRuleClass} />
            <Item
              testId="export-citation-style-menu"
              icon={<span aria-hidden="true" className="size-4 shrink-0" />}
              label={t("export.citationStyle")}
              {...(styleName && { hint: styleName })}
              onClick={() => {
                const button = menu.buttonProps.ref.current;
                menu.close();
                useCitationStylePicker.getState().show(mindId, button);
              }}
            />
            <Item
              testId="export-options"
              icon={<SettingsLineIcon className="size-4 shrink-0 text-ink-meta" />}
              label={t("export.options")}
              onClick={() => run("mind.exportOptions")}
            />
          </>
        )}
      </div>
      <div
        {...submenu.menuProps}
        role="menu"
        aria-label={t("export.more")}
        data-testid="export-more-menu"
        className={menuClass}
      >
        {more.map((format) => formatItem(format))}
      </div>
    </>
  );
}
