import { registerMenu, registerMixedMenu } from "./menus";

// Later features add their items with registerMenu: Move to… (#229, #212), Add to note (#201), History (#300), Tag colour and merge (#205).

/**
 * Export… (the Export button's short menu: the formats, its options), then the AI use statement
 * (#739) and the check record (#738). The formats themselves are in that menu and in ⌘K.
 */
const EXPORTS = ["mind.exportMenu", "mind.aiUseStatement", "mind.checkRecord"] as const;

registerMenu("mind", [
  "mind.open",
  "mind.openTab",
  "mind.openChat",
  "mind.outline",
  ...EXPORTS,
  "mind.history",
  "mind.check",
  "mind.tieOut",
  "mind.checkContradictions",
  "mind.citationStyle",
  "mind.style",
  "skill.fromMind",
  "mind.moveTo",
  "folder.newWith",
  "mind.rename",
  "mind.delete",
]);

registerMenu("document", [
  "document.open",
  "document.openTab",
  "document.peek",
  "document.openMind",
  "document.ask",
  "document.startMind",
  "document.accept",
  "document.reject",
  "document.moveTo",
  "folder.newWith",
  "document.tags",
  "document.retry",
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

registerMenu("folder", [
  "folder.open",
  "folder.newMind",
  "folder.new",
  "folder.ask",
  "folder.organize",
  "folder.tagWithAi",
  "folder.editDescription",
  "folder.keepInside",
  "folder.sort",
  "folder.rename",
  "file.info",
  "folder.delete",
]);

registerMenu("tag", ["tag.open", "tag.manage", "tag.rename", "tag.delete"]);

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
    "mind.outline",
    "mind.look.word",
    "mind.look.plain",
    "mind.openOriginal",
    ...EXPORTS,
    "mind.history",
    "mind.check",
    "mind.tieOut",
    "mind.checkContradictions",
    "mind.style",
    "mind.moveTo",
  ],
  0,
);
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

registerMenu("check", [
  "check.anyway",
  "check.chooseSource",
  "check.correctSource",
  "check.correctPeriod",
  "check.useDocumentWording",
  "check.findSources",
]);

registerMenu("citation", [
  "citation.open",
  "citation.update",
  "citation.keepOld",
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
  "comparison.table.rename",
  "comparison.table.refillAll",
  "comparison.table.refillProblems",
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
