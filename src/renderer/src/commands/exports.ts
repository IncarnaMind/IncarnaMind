import { EXPORT_FORMATS } from "../../../core/api";
import { exportAiUseStatement } from "../aiUseStatement";
import { useExportDialog } from "../exportDialog";
import { requestExportMenu } from "../exportMenuRequest";
import {
  canChangeExport,
  changeExportChoices,
  exportCheckRecord,
  exportMind,
  exportPreferences,
  FORMAT_LABELS,
  useExports,
} from "../exports";
import { currentTabOf } from "../layoutSlice";
import { useAppStore } from "../store";
import { findTab } from "../tabs";
import type { Command, CommandContext } from "./registry";
import { onlyOne } from "./targets";

/**
 * The Mind a command exports: the Mind's row or the tab its menu was opened on, else the Mind in
 * the tab the User is in (⇧⌘E, ⌘K). One Mind at a time: none for several selected.
 */
function mindOf(ctx: CommandContext): string | null {
  const targets = ctx.selection.length > 0 ? ctx.selection : ctx.focus ? [ctx.focus] : [];
  if (targets.length > 1) return null;
  const [target] = targets;
  if (target?.kind === "mind") return target.id;
  const { layout } = useAppStore.getState();
  const tab =
    target === undefined
      ? currentTabOf(layout)
      : target.kind === "tab"
        ? findTab(layout, target.id)
        : undefined;
  return tab?.item.kind === "mind" ? tab.item.mindId : null;
}

/**
 * Exporting a Mind (#100): ⇧⌘E exports in the last format, as the tab strip's Export does; each
 * other format has its own item, which becomes the last; and Export options… opens the sheet.
 * In ⌘K, and in the Mind's and its tab's menus (./objectMenus).
 */
export const exportCommands: readonly Command[] = [
  {
    // The Mind's menus have this one item for exporting: it shows the Mind and opens the
    // Export button's menu, whose list is the short one.
    id: "mind.exportMenu",
    label: "export.menu",
    keywords: ["export.keywords"],
    group: "main",
    top: 14,
    // Only opens a menu; nothing is saved until a format is chosen.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null,
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (!mindId) return;
      useAppStore.getState().openMind(mindId);
      requestExportMenu(mindId);
    },
  },
  {
    id: "mind.export",
    label: (_ctx, t) => t("export.as", { format: t(FORMAT_LABELS[exportPreferences().format]) }),
    keywords: ["export.keywords"],
    shortcut: { keys: "CmdOrCtrl+Shift+E" },
    group: "main",
    // A new file under a free name: nothing is replaced, and the file stays the User's to delete.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null,
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (mindId) return exportMind(mindId);
    },
  },
  ...EXPORT_FORMATS.map(
    (format): Command => ({
      id: `mind.exportAs.${format}`,
      label: (_ctx, t) => t("export.as", { format: t(FORMAT_LABELS[format]) }),
      keywords: ["export.keywords"],
      group: "main",
      reversible: true,
      // The last format is "mind.export", with its keys.
      when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null && exportPreferences().format !== format,
      run: (ctx) => {
        const mindId = mindOf(ctx);
        if (mindId) return exportMind(mindId, format);
      },
    }),
  ),
  {
    // The same Change the Saved line offers, for the keys and ⌘K: only while that line holds a
    // file whose choices can still be changed, which is a Word or PDF export (#1945).
    id: "mind.exportChangeChoices",
    label: "export.change.command",
    keywords: ["export.change.command.keywords"],
    shortcut: { keys: "CmdOrCtrl+Alt+E" },
    group: "main",
    reversible: true,
    when: (ctx) => {
      const mindId = mindOf(ctx);
      const result = useExports.getState().result;
      return (
        mindId !== null &&
        result?.mindId === mindId &&
        result.state === "saved" &&
        canChangeExport(result.format) &&
        result.changing === undefined
      );
    },
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (mindId) changeExportChoices(mindId);
    },
  },
  {
    id: "mind.exportOptions",
    label: "export.options",
    keywords: ["export.keywords"],
    group: "main",
    // Only opens the sheet; what it saves is the User's choice of options.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null,
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (mindId) useExportDialog.getState().open(mindId);
    },
  },
  {
    // The statement opens as a new Mind beside this one, to edit and attach to a thesis (#739).
    id: "mind.aiUseStatement",
    label: "aiStatement.command",
    keywords: ["aiStatement.keywords"],
    group: "main",
    // Undo sends the new Mind to Recently deleted, as for any Mind made.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null,
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (mindId) return exportAiUseStatement(mindId);
    },
  },
  {
    id: "mind.checkRecord",
    label: "checkRecord.command",
    keywords: ["checkRecord.keywords"],
    group: "main",
    // Two new files under free names: nothing is replaced, and the files stay the User's to delete.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null,
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (mindId) return exportCheckRecord(mindId);
    },
  },
];
