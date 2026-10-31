import type { BlockOrigin } from "../../../core/api";
import { MENU_COMMANDS } from "../../../shared/commands";
import { signInAgain } from "../chatGptSignIn";
import { useChecks } from "../checks";
import { useCitationStylePicker } from "../citationStylePicker";
import { claudeSignInOffered } from "../claudeSignIn";
import { startContradictionCheck } from "../contradictions";
import { blockMenuOpeners } from "../editor/blockMenuOpeners";
import { originOf } from "../editor/blockOrigins";
import { goToCitation } from "../editor/citationMark";
import { blockAt, noteHolding } from "../editor/noteKeymap";
import { openOrigin } from "../editor/originActions";
import { tieOutFigures } from "../figures";
import { useFindSources } from "../findSources";
import { useHistory } from "../history";
import { translateNow } from "../i18n";
import { startSkillFromMind } from "../makeSkill";
import { checkFromAssistant, showCheckCard } from "../mindCheck";
import { useMindTools } from "../mindTools";
import { forgetNewMindKeys, holdNewMindKeys } from "../newMindKeys";
import { citationStepOpen } from "../nudges";
import { useReferenceImport } from "../referenceImport";
import { useAppStore } from "../store";
import { verifyDocument } from "../verify";
import { useWordImport } from "../wordImport";
import { addDocumentCommands } from "./addDocuments";
import { analysisCommands } from "./analysis";
import { answerTableCommands } from "./answerTables";
import { assistantCommands } from "./assistant";
import { bibliographyCommands } from "./bibliography";
import { chartCommands } from "./charts";
import { checkCommands } from "./checks";
import { comparisonCommands } from "./comparisons";
import { deletedCommands } from "./deleted";
import { editCommands } from "./edit";
import { evidenceCommands } from "./evidence";
import { exampleCommands } from "./examples";
import { exportCommands } from "./exports";
import { feedbackCommands } from "./feedback";
import { figureCommands, figureScheduleCommands } from "./figures";
import { fileCommands } from "./fileInfo";
import { footnoteCommands } from "./footnotes";
import { formatCommands } from "./format";
import {
  citationHandle,
  citedVersionInUse,
  findHandle,
  homeNextHandle,
  readMindHandle,
  sidebarHandle,
} from "./handles";
import { languageCommands } from "./language";
import { libraryCommands } from "./library";
import { linkCommands } from "./links";
import { meetingHelpCommands } from "./meetingHelp";
import { meetingCommands } from "./meetings";
import { newFolderCommands } from "./newFolder";
import { noteBasicsCommands } from "./noteBasics";
import {
  answerCommands,
  citationCommands,
  documentCommands,
  folderCommands,
  linkedFolderCommands,
  mindCommands,
  mixedSelectionCommands,
  tagCommands,
} from "./objects";
import { pageCommands } from "./page";
import { pageBreakCommands } from "./pageBreaks";
import { paletteCommands } from "./palette";
import { peekCommands } from "./peek";
import { pictureCommands } from "./pictures";
import { proposalCommands } from "./proposals";
import { researchCommands } from "./research";
import { reviewCommands } from "./review";
import { sortCommands } from "./sort";
import { suggestionCommands } from "./suggestions";
import "./objectMenus";
import { type Command, type CommandContext, commands, fromMenu } from "./registry";
import { selectionCommands } from "./selection";
import { settingsPageCommands } from "./settings";
import { styleCommands } from "./style";
import { tableCommands } from "./tables";
import { tabCommands } from "./tabs";
import { taggingCommands } from "./tagging";
import { mindInFront, mindShown, onlyOne } from "./targets";
import { taskCommands } from "./tasks";
import { viewerSelectionCommands } from "./viewerSelection";
import { webPageCommands } from "./webPages";
import { wordLookCommands } from "./wordLook";

/** What opens the menu of the Block with this ID, if its Mind is open. */
function blockMenuFor(blockId: string) {
  const editor = noteHolding(blockId);
  return (editor && blockMenuOpeners.get(editor)) ?? null;
}

/** Where the Block a menu names, or else the one the cursor is in, was added from; null if nowhere. */
function originShown(ctx: CommandContext): BlockOrigin | null {
  if (ctx.focus?.kind === "block") {
    const editor = noteHolding(ctx.focus.id);
    return editor && originOf(editor.state, ctx.focus.id);
  }
  const editor = readMindHandle.current?.editor;
  if (!editor || editor.isDestroyed) return null;
  const block = blockAt(editor.state.selection);
  return block ? originOf(editor.state, block.id) : null;
}

/** The Mind a command acts on: the one a menu names, else the one in front (⌘K, the assistant). */
function mindOf(ctx: CommandContext): string | null {
  const targets = ctx.selection.length > 0 ? ctx.selection : ctx.focus ? [ctx.focus] : [];
  return targets.find((each) => each.kind === "mind")?.id ?? mindInFront();
}

const appCommands: readonly Command[] = [
  {
    ...fromMenu("mind.new"),
    shortcut: { keys: MENU_COMMANDS["mind.new"].keys, also: "CmdOrCtrl+N" },
    group: "main",
    top: 20,
    reversible: true,
    run: async () => {
      holdNewMindKeys(translateNow("mind.opening"));
      if ((await useAppStore.getState().createMind({ titled: true })) === null) forgetNewMindKeys();
    },
  },
  {
    id: "home.open",
    label: "home.title",
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openHome(),
  },
  {
    id: "firstOpen.checkCitation",
    label: "firstOpen.step.citation.title",
    group: "open",
    reversible: true,
    when: () => citationStepOpen(useAppStore.getState().settings?.device.gettingStarted),
    run: () => goToCitation(),
  },
  {
    id: "word.import",
    // It waits for the User's choice in a file picker.
    assistant: false,
    label: "wordImport.command",
    group: "main",
    reversible: true,
    run: () => useWordImport.getState().pick(),
  },
  {
    id: "verify.document",
    // It waits for the User's choice in a file picker.
    assistant: false,
    label: "verify.command",
    purpose: "verify.command.purpose",
    keywords: ["verify.command.keywords"],
    group: "main",
    // It adds the PDF and makes a Mind of it, each deleted as any other is.
    reversible: true,
    run: () => verifyDocument(),
  },
  ...addDocumentCommands,
  ...editCommands,
  ...selectionCommands,
  ...mindCommands,
  ...documentCommands,
  ...peekCommands,
  ...suggestionCommands,
  ...folderCommands,
  ...mixedSelectionCommands,
  ...taggingCommands,
  ...newFolderCommands,
  ...tagCommands,
  ...linkedFolderCommands,
  ...deletedCommands,
  ...libraryCommands,
  ...languageCommands,
  ...answerCommands,
  ...citationCommands,
  ...figureCommands,
  ...figureScheduleCommands,
  ...tabCommands,
  ...meetingCommands,
  ...meetingHelpCommands,
  ...webPageCommands,
  ...viewerSelectionCommands,
  ...feedbackCommands,
  ...exampleCommands,
  ...sortCommands,
  ...fileCommands,
  ...evidenceCommands,
  ...comparisonCommands,
  ...researchCommands,
  ...analysisCommands,
  ...exportCommands,
  ...taskCommands,
  ...wordLookCommands,
  ...pageCommands,
  ...styleCommands,
  {
    ...fromMenu("settings.open"),
    group: "open",
    reversible: true,
    run: () => useAppStore.getState().openSettings(),
  },
  ...settingsPageCommands,
  ...paletteCommands,
  {
    id: "chatgpt.continue",
    assistant: { never: "keys" },
    label: "chatgpt.continue",
    group: "main",
    reversible: true,
    // Signs in, then shows the plan in Settings → Models, where its model is chosen; a failure says why there.
    run: async () => {
      const { openSettings } = useAppStore.getState();
      if (await signInAgain(openSettings)) openSettings("models");
    },
  },
  {
    id: "claude.signIn",
    assistant: { never: "keys" },
    label: "claudePlan.signIn",
    group: "main",
    reversible: true,
    when: claudeSignInOffered,
    // The words come before any request, so it opens the Claude row in Settings › Models.
    run: () => useAppStore.getState().openSettings("models", "claude-account"),
  },
  {
    ...fromMenu("sidebar.toggle"),
    label: (_ctx, t) => t(sidebarHandle.current?.hidden ? "menu.showSidebar" : "menu.hideSidebar"),
    group: "main",
    reversible: true,
    when: () => sidebarHandle.current !== null,
    run: () => sidebarHandle.current?.toggle(),
  },
  {
    id: "sources.find",
    label: "command.sources.find",
    keywords: ["command.sources.find.keywords"],
    group: "main",
    reversible: true,
    run: () => useFindSources.getState().show(),
  },
  ...assistantCommands,
  ...answerTableCommands,
  {
    id: "citation.open",
    label: "command.citation.open",
    shortcut: { keys: "CmdOrCtrl+Alt+O" },
    group: "open",
    reversible: true,
    // While a Citation's card shows (hovered, focused or clicked), or from its menu.
    when: (ctx) => ctx.here?.["citation.open"] !== undefined || citationHandle.current !== null,
    run: (ctx) => (ctx.here?.["citation.open"] ?? citationHandle.current?.open)?.(),
  },
  {
    id: "viewer.openCurrentVersion",
    label: "command.viewer.openCurrentVersion",
    group: "open",
    reversible: true,
    when: () => citedVersionInUse(useAppStore.getState().layout) !== null,
    run: () => citedVersionInUse(useAppStore.getState().layout)?.openCurrent(),
  },
  // A Citation that needs re-check (#99), while its card shows or from its menu: the note's ⌘Z takes each back.
  ...(["update", "keepOld"] as const).map(
    (choice): Command => ({
      id: `citation.${choice}`,
      label: `citation.${choice}`,
      group: "main",
      reversible: true,
      when: (ctx) =>
        ctx.here?.[`citation.${choice}`] !== undefined ||
        (citationHandle.current?.choices()[choice] ?? null) !== null,
      run: (ctx) =>
        (ctx.here?.[`citation.${choice}`] ?? citationHandle.current?.choices()[choice])?.(),
    }),
  ),
  {
    // The Mind in front's citation style (#289): the same picker as its References' button.
    id: "mind.citationStyle",
    label: "citationStyle.command",
    keywords: ["citationStyle.keywords", "references.title"],
    group: "main",
    // The picker's choice is taken back with Undo.
    reversible: true,
    // A Mind's row in the sidebar picks for that Mind.
    when: (ctx) =>
      onlyOne(ctx) && (ctx.here?.["mind.citationStyle"] !== undefined || mindInFront() !== null),
    run: (ctx) => {
      if (ctx.here?.["mind.citationStyle"]) return ctx.here["mind.citationStyle"]();
      const mindId = mindInFront();
      if (!mindId) return;
      const button = document.querySelector<HTMLElement>(
        `article[data-mind-id="${mindId}"] [data-testid="references-style"]`,
      );
      useCitationStylePicker.getState().show(mindId, button);
    },
  },
  {
    id: "mind.history",
    label: "history.command",
    menuLabel: "history.menu",
    keywords: ["history.keywords"],
    group: "main",
    // Opening it changes nothing; its Restore is taken back with Undo.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    run: (ctx) => {
      const mindId = mindShown(ctx);
      if (mindId) useHistory.getState().open(mindId);
    },
  },
  {
    id: "home.nextStep",
    label: (_ctx, t) => homeNextHandle.current?.label ?? t("home.next.command"),
    group: "main",
    top: 9,
    reversible: true,
    when: () => homeNextHandle.current !== null && !homeNextHandle.current.busy,
    run: () => homeNextHandle.current?.run(),
  },
  {
    id: "mind.tieOut",
    label: "figures.command",
    group: "main",
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    run: (ctx) => {
      const mindId = mindShown(ctx);
      if (mindId) return tieOutFigures(mindId);
    },
  },
  {
    id: "mind.check",
    label: "mindCheck.command",
    purpose: "mindCheck.command.purpose",
    keywords: ["mindCheck.command.keywords"],
    group: "main",
    top: 12,
    // It changes no words: its marks go with Check again, or when the sentence is edited.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    enabled: (ctx) => {
      const mindId = mindShown(ctx);
      return mindId && useChecks.getState().running[mindId]
        ? { reason: "mindCheck.alreadyChecking" }
        : true;
    },
    run: (ctx) => {
      const mindId = mindShown(ctx);
      if (mindId) return checkFromAssistant(mindId);
    },
  },
  {
    id: "mind.checkEverySentence",
    label: "mindCheck.every",
    keywords: ["mindCheck.command.keywords"],
    group: "main",
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    run: (ctx) => {
      const mindId = mindShown(ctx);
      if (mindId) return checkFromAssistant(mindId, true);
    },
  },
  {
    id: "mind.checks",
    label: "health.label",
    keywords: ["badge.command.keywords"],
    group: "main",
    // Opening the card changes nothing.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    run: async (ctx) => {
      const mindId = mindShown(ctx);
      if (!mindId) return;
      await useAppStore.getState().openMind(mindId);
      showCheckCard(mindId);
    },
  },
  {
    id: "mind.checkContradictions",
    label: "contradictions.command",
    purpose: "contradictions.command.purpose",
    keywords: ["contradictions.command.keywords"],
    group: "main",
    // It changes no words: its marks go with Check again, or when the sentence is edited.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    run: (ctx) => {
      const mindId = mindShown(ctx);
      if (mindId) return startContradictionCheck(mindId);
    },
  },
  {
    // The AI drafts it in the Mind's card; nothing is saved until the User saves it.
    id: "skill.fromMind",
    label: "skills.make.command",
    keywords: ["skills.settings.title"],
    group: "main",
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindOf(ctx) !== null,
    run: (ctx) => {
      const mindId = mindOf(ctx);
      if (mindId) return startSkillFromMind(mindId);
    },
  },
  {
    id: "references.import",
    // It waits for the User's choice in a file picker.
    assistant: false,
    label: "references.import.menu",
    group: "file",
    // The import is taken back with Undo.
    reversible: true,
    enabled: () =>
      useReferenceImport.getState().phase === "running"
        ? { reason: "references.import.running.reason" }
        : true,
    run: () => useReferenceImport.getState().start(),
  },
  {
    // Suggest as I write (#282): on asks for consent first, as the switch in Settings does.
    id: "suggestions.toggle",
    assistant: { never: "privacy" },
    label: (_ctx, t) =>
      t(
        useAppStore.getState().settings?.user.suggestWhileWriting
          ? "command.suggestions.off"
          : "command.suggestions.on",
      ),
    keywords: ["suggestions.settings.switch"],
    group: "main",
    reversible: true,
    when: () => useAppStore.getState().settings !== null,
    run: () => {
      const on = useAppStore.getState().settings?.user.suggestWhileWriting ?? false;
      return useAppStore.getState().updateSettings({ user: { suggestWhileWriting: !on } });
    },
  },
  {
    id: "block.delete",
    label: "editor.block.delete",
    shortcut: { keys: "CmdOrCtrl+Shift+Backspace" },
    group: "danger",
    destructive: true,
    appliesTo: ["block", "answer", "chart"],
    // The note's own undo (⌘Z) brings it back.
    reversible: true,
    run(ctx) {
      // An Answer's or a chart's menu deletes it, wherever the cursor is.
      if (ctx.here?.["block.delete"]) return ctx.here["block.delete"]();
      // The Blocks the note's selection touches, the focused one among them.
      if (ctx.focus) noteHolding(ctx.focus.id)?.commands.deleteBlock();
    },
  },
  {
    id: "block.menu",
    label: "editor.block.menu",
    shortcut: { keys: "Shift+F10" },
    group: "main",
    appliesTo: ["block"],
    reversible: true,
    when: (ctx) => ctx.focus?.kind === "block" && blockMenuFor(ctx.focus.id) !== null,
    run(ctx) {
      if (ctx.focus?.kind === "block") blockMenuFor(ctx.focus.id)?.(ctx.focus.id);
    },
  },
  {
    id: "block.openSource",
    label: "origin.open",
    group: "open",
    // Opening a conversation changes nothing.
    reversible: true,
    when: (ctx) => originShown(ctx) !== null,
    run(ctx) {
      const origin = originShown(ctx);
      if (origin) void openOrigin(origin);
    },
  },
  {
    id: "mind.outline",
    label: "editor.outline.title",
    keywords: ["editor.slash.heading1"],
    shortcut: { keys: "CmdOrCtrl+Alt+L" },
    group: "main",
    // Opening it changes nothing.
    reversible: true,
    when: (ctx) => onlyOne(ctx) && mindShown(ctx) !== null,
    run: (ctx) => {
      const mindId = mindShown(ctx);
      if (!mindId) return;
      // A Mind's row in the sidebar opens the Mind, which then shows its outline.
      if (mindId !== mindInFront()) useAppStore.getState().openMind(mindId);
      useMindTools.getState().showOutline(mindId);
    },
  },
  {
    id: "mind.find",
    label: "editor.find.label",
    shortcut: { keys: "CmdOrCtrl+F" },
    group: "main",
    reversible: true,
    when: () => mindInFront() !== null,
    run: () => {
      const mindId = mindInFront();
      if (mindId) useMindTools.getState().showFind(mindId);
    },
  },
  {
    id: "mind.replace",
    label: "editor.replace.label",
    shortcut: { keys: "CmdOrCtrl+Alt+F" },
    group: "main",
    reversible: true,
    when: () => mindInFront() !== null,
    run: () => {
      const mindId = mindInFront();
      if (mindId) useMindTools.getState().showFind(mindId, { replace: true });
    },
  },
  {
    id: "mind.findNext",
    label: "command.mind.findNext",
    shortcut: { keys: "CmdOrCtrl+G" },
    group: "main",
    reversible: true,
    when: () => findHandle.current !== null,
    run: () => findHandle.current?.next(),
  },
  {
    id: "mind.findPrevious",
    label: "command.mind.findPrevious",
    shortcut: { keys: "CmdOrCtrl+Shift+G" },
    group: "main",
    reversible: true,
    when: () => findHandle.current !== null,
    run: () => findHandle.current?.previous(),
  },
  ...footnoteCommands,
  ...noteBasicsCommands,
  ...pageBreakCommands,
  ...pictureCommands,
  ...formatCommands,
  ...linkCommands,
  ...bibliographyCommands,
  ...tableCommands,
  ...chartCommands,
  ...proposalCommands,
  ...reviewCommands,
  ...checkCommands,
];

for (const command of appCommands) commands.register(command);
