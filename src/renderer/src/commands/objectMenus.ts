import { registerMenu, registerMixedMenu, registerMore } from "./menus";
import type { CommandContext } from "./registry";

// A feature adds its items with registerMenu, where they belong in the shared order.

// What a Note's menu holds one step further, under More ›: ⌘K lists each by name.
const MIND_MORE = [
  "mind.outline",
  "mind.checkContradictions",
  "mind.useAsSource",
  "mind.updateSourceSnapshot",
  "mind.removeAsSource",
  "mind.dontCiteTranscript",
  "mind.citeTranscriptAgain",
  "skill.fromMind",
  "mind.tidy",
  "folder.newWith",
] as const;

// With several selected, New Folder with these is a row of the menu, as Finder's is.
const SEVERAL = { "folder.newWith": (ctx: CommandContext) => ctx.selection.length > 1 };

registerMenu("mind", [
  "mind.open",
  "mind.openTab",
  "mind.openChat",
  "mind.duplicate",
  "mind.check",
  "mind.tieOut",
  "mind.exportMenu",
  "mind.history",
  "mind.moveTo",
  "mind.rename",
  "mind.delete",
]);
registerMore("mind", MIND_MORE, SEVERAL);

registerMenu("document", [
  "document.open",
  "document.openTab",
  "document.peek",
  "document.openMind",
  "document.ask",
  "document.startMind",
  "document.showAnnotations",
  "document.exportAnnotations",
  "document.moveTo",
  "folder.newWith",
  "document.tags",
  "document.retry",
  "document.readHiddenSheets",
  "document.unlock",
  "document.fetchAgain",
  "document.countAsEvidence",
  "document.leaveOutOfEvidence",
  "document.dontCite",
  "document.citeAgain",
  "document.rename",
  "document.openExternally",
  "document.showInFolder",
  "file.copyPath",
  "document.openLivePage",
  "document.copyAddress",
  "file.info",
  "document.forgetPassword",
  "document.delete",
]);

registerMenu("annotation", [
  "annotation.editNote",
  "annotation.colour.yellow",
  "annotation.colour.pink",
  "annotation.colour.purple",
  "annotation.addToNote",
  "annotation.collect",
  "annotation.export",
  "annotation.delete",
]);

registerMenu("folder", [
  "folder.open",
  "folder.newMind",
  "folder.addDocuments",
  "folder.newInside",
  "folder.ask",
  "folder.organize",
  "folder.tagWithAi",
  "folder.editDescription",
  "folder.keepInside",
  "folder.sort",
  "folder.moveTo",
  "folder.rename",
  "file.info",
  "folder.delete",
]);

registerMenu("tag", [
  "tag.open",
  "tag.colour",
  "tag.editDescription",
  "tag.merge",
  "tag.rename",
  "tag.delete",
]);

registerMixedMenu(["selection.moveTo", "selection.delete"]);

registerMenu("linkedFolder", [
  "linkedFolder.pause",
  "folder.sort",
  "linkedFolder.download",
  "linkedFolder.reveal",
  "file.copyPath",
  "file.info",
  "linkedFolder.locate",
  "linkedFolder.unlink",
]);

registerMenu("deleted", ["deleted.restore", "deleted.deletePermanently"]);

// A tab's menu is its Mind's, then the tab's own.
registerMenu(
  "tab",
  [
    "mind.openChat",
    "mind.duplicate",
    "mind.look.word",
    "mind.look.plain",
    "mind.openOriginal",
    "mind.check",
    "mind.tieOut",
    "mind.exportMenu",
    "mind.history",
    "mind.moveTo",
  ],
  0,
);
registerMore("tab", MIND_MORE, SEVERAL);
registerMenu(
  "tab",
  [
    "tab.split",
    "tab.keep",
    "tab.pin",
    "tab.moveEarlier",
    "tab.moveLater",
    "tab.moveLeft",
    "tab.moveRight",
    "tab.rename",
    "tab.close",
    "tab.closeOthers",
    "tab.closeToTheRight",
  ],
  1,
);
// Delete is last, after the tab's own items.
registerMenu("tab", ["mind.delete"], 2);

registerMenu("answer", ["answer.copy", "answer.regenerate", "block.delete"]);

registerMenu("check", ["check.anyway", "check.useDocumentWording", "check.findSources"]);

registerMenu("citation", [
  "citation.open",
  "citation.update",
  "citation.keepOld",
  "citation.pageChecked",
  "citation.signOff",
  "citation.signOffRemove",
  "citation.remove",
]);

registerMenu("comparisonColumn", [
  "comparison.column.edit",
  "comparison.column.insertLeft",
  "comparison.column.insertRight",
  "comparison.column.duplicate",
  "comparison.column.reviewed",
  "comparison.column.moveLeft",
  "comparison.column.moveRight",
  "comparison.column.hide",
  "comparison.column.remove",
]);

registerMenu("comparisonTable", [
  "comparison.table.addDocuments",
  "comparison.table.refillAll",
  "comparison.table.refillAllIncludingMine",
  "comparison.table.refillProblems",
  "comparison.table.duplicate",
  "comparison.table.useColumns",
  "comparison.table.rename",
  "comparison.table.plain",
  "comparison.exportExcel",
  "comparison.exportCsv",
  "comparison.table.delete",
]);

registerMenu("comparisonCell", [
  "comparison.cell.open",
  "comparison.cell.refill",
  "comparison.cell.edit",
  "comparison.cell.reviewed",
  "comparison.cell.copy",
]);

registerMenu("comparisonRow", [
  "comparisonRow.open",
  "comparisonRow.moveUp",
  "comparisonRow.moveDown",
  "comparison.row.refill",
  "comparisonRow.remove",
]);

registerMenu("chart", [
  "chart.table",
  "chart.kind.bar",
  "chart.kind.line",
  "chart.kind.pie",
  "chart.kind.scatter",
  "chart.switch",
  "chart.update",
  "chart.rename",
  "block.delete",
]);
