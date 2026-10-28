import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GAP, isSide, RAIL, SIDE_MIN, shownDock } from "./assistantPlace";
import { useEditMenu } from "./commands/edit";
import { sidebarHandle, useHandle } from "./commands/handles";
import { useKeymap } from "./commands/keymap";
import { AddWebPageDialog } from "./components/AddWebPageDialog";
import { AppShell, useRememberSidebarWidth } from "./components/AppShell";
import { Workbench } from "./components/assistant/Workbench";
import { CitationStylePickerHost } from "./components/CitationStylePicker";
import { CommandPalette } from "./components/CommandPalette";
import { ConsentDialog } from "./components/ConsentDialog";
import { DropLabel } from "./components/DropLabel";
import { ErrorNotices } from "./components/ErrorNotices";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { DropOverlay, useFileDrop } from "./components/FileDrop";
import { FileWriteDialog } from "./components/FileWriteDialog";
import { HistoryView } from "./components/history/HistoryView";
import { InfoPanel } from "./components/InfoPanel";
import { DocumentMoveTo } from "./components/library/DocumentMoveTo";
import { MeetingNoticeDialog } from "./components/MeetingNoticeDialog";
import { MindStyleHost } from "./components/MindStyle";
import { PanelBoundary } from "./components/PanelBoundary";
import { Peek } from "./components/Peek";
import { ProblemMark } from "./components/ProblemLine";
import { ChatGptWelcomeDialog } from "./components/providers/ChatGptSignIn";
import { RequestedDialogs } from "./components/RequestedDialogs";
import { ResizeRod } from "./components/ResizeRod";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { SidebarControlContext } from "./components/SidebarToggle";
import { SortMenu } from "./components/SortMenu";
import { TagsDialog } from "./components/TagsDialog";
import { WordImportDialog } from "./components/WordImportDialog";
import { files } from "./core";
import { useDragState } from "./dragDrop";
import { useEscapeToDismiss } from "./escapeDismiss";
import { useExamplesMenu, useExportMenu } from "./exportMenu";
import { useLanguage, useT } from "./i18n";
import { useMeetingHelpInWindow } from "./meetingHelp";
import { useMeetings } from "./meetings";
import { setMotionPreference } from "./motion";
import { importReferenceFile, isReferenceFile } from "./referenceImport";
import { useAppStore } from "./store";
import { useSidebarSlide } from "./useSidebarSlide";
import { useWindowWidth } from "./useWindowWidth";
import { useWebPages } from "./webPages";

/** The card's distance from the sidebar, and from the window's top, right and bottom edges. */
const CARD_GAP = 8;
const SIDEBAR = { min: 165, max: 480 };
/** What the card keeps beside the sidebar (and an assistant docked beside it), at least. */
const CARD_MIN = 300;

export function App() {
  const status = useAppStore((state) => state.status);
  const load = useAppStore((state) => state.load);
  const language = useLanguage();
  const t = useT();

  useEffect(() => {
    void load();
    void useMeetings.getState().load();
  }, [load]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  // How the window moves: the User's choice, kept on this device, once the settings have loaded.
  const motion = useAppStore((state) => state.settings?.device.motion ?? "system");
  useEffect(() => setMotionPreference(motion), [motion]);

  // The frame shows at once; the data fills it in as it arrives.
  if (status.kind === "loading") return <AppShell />;
  if (status.kind === "failed") {
    return (
      <p role="alert" className="p-6 text-ui text-ink">
        <ProblemMark />
        {t("error.load", { message: status.message })}
      </p>
    );
  }
  return <Workspace />;
}

/**
 * Hiding and showing the sidebar (#219): ⌘\ (Ctrl+\) and View > Hide Sidebar
 * (the "sidebar.toggle" command; the menu's label follows), the title bar's
 * button, and dragging the divider shut. The User's choice is remembered.
 */
function useSidebarControl(userHidden: boolean, beforeSlide: (shows: boolean) => void) {
  const previewLayout = useAppStore((state) => state.previewLayout);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const hidden = userHidden;
  const state = useRef({ hidden });
  state.current = { hidden };
  const refocus = useRef(false);

  const setHidden = useCallback(
    (next: boolean) => {
      if (next === state.current.hidden) return;
      beforeSlide(!next);
      // Updated here before the core confirms, so the sidebar answers at once.
      previewLayout({ sidebarHidden: next });
      void updateSettings({ device: { sidebarHidden: next } });
    },
    [previewLayout, updateSettings, beforeSlide],
  );
  const toggle = useCallback(() => {
    const active = document.activeElement;
    // Keep the focus where it was: on the button the User used, which may move, or in the page.
    refocus.current = active instanceof HTMLElement && active.dataset.testid === "sidebar-toggle";
    if (!state.current.hidden && active instanceof HTMLElement && active.closest("#sidebar")) {
      // Hiding what holds the focus: it goes to the button that shows it again.
      refocus.current = true;
    }
    setHidden(!state.current.hidden);
  }, [setHidden]);
  const takeRefocus = useCallback(() => {
    const wanted = refocus.current;
    refocus.current = false;
    return wanted;
  }, []);

  // The View menu says Hide or Show to match.
  useEffect(() => files.setSidebarHidden(hidden), [hidden]);

  return { hidden, setHidden, toggle, takeRefocus };
}

/**
 * While the sidebar is hidden: it slides out over the content when the
 * pointer touches the window's left edge or keyboard focus goes into it, and
 * slides back when the pointer leaves and focus is out.
 */
function useSidebarPeek(hidden: boolean, beforeSlide: (shows: boolean) => void) {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  // A peek is the pointer or the keyboard reaching the hidden sidebar: what either was doing while
  // it showed belongs to what the User is leaving. On macOS the button that hides it sits in its
  // header, so pressing it by keyboard puts the focus in the panel; kept, that peek would hold the
  // focus there, and the sidebar would stay over the content it was hidden from.
  const wasHidden = useRef(hidden);
  useLayoutEffect(() => {
    if (wasHidden.current === hidden) return;
    wasHidden.current = hidden;
    setPointer(false);
    setFocus(false);
  }, [hidden]);
  const peeking = hidden && (pointer || focus);
  const hold = (by: { pointer?: boolean; focus?: boolean }) => {
    const next = hidden && ((by.pointer ?? pointer) || (by.focus ?? focus));
    if (next !== peeking) beforeSlide(next);
    if (by.pointer !== undefined) setPointer(by.pointer);
    if (by.focus !== undefined) setFocus(by.focus);
  };
  return {
    peeking,
    onEdge: () => hold({ pointer: true }),
    panel: {
      onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
        // A menu or dialog the sidebar opened keeps it out until it is closed.
        if (event.currentTarget.querySelector(":popover-open, dialog[open]")) return;
        hold({ pointer: false });
      },
      // Focus the keyboard moved in (not a click's) shows it, and leaving hides it again.
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        if (event.target.matches(":focus-visible")) hold({ focus: true });
      },
      onBlur: (event: React.FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hold({ focus: false });
      },
    },
  };
}

/**
 * Sidebar with Minds and Documents on the left, on the frame, and the tabs
 * filling the rest in a card on the sheet, 8px from the sidebar and from the
 * window's other edges: up to three groups side by side, each with its tab
 * strip (see `TabGroups`). Files dropped anywhere are added as Documents; a
 * folder dropped is offered for linking; links dropped are saved as web pages.
 */
function Workspace() {
  const t = useT();
  const device = useAppStore((state) => state.settings?.device);
  const previewLayout = useAppStore((state) => state.previewLayout);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const addDropped = useAppStore((state) => state.addDropped);
  const fileDrop = useFileDrop(
    (dropped, folders) => {
      // A reference export (CSL JSON, BibTeX, RIS) is imported, not added as a Document (#287).
      const exported = dropped.find((file) => isReferenceFile(file.name));
      const path = exported ? files.pathForFile(exported) : "";
      if (path) void importReferenceFile(path);
      const rest = path ? dropped.filter((file) => file !== exported) : dropped;
      if (rest.length > 0 || folders.length > 0) void addDropped(rest, folders);
    },
    (addresses) => void useWebPages.getState().add(addresses),
  );
  // A target inside that takes the files (a Word file on a Mind) says what its drop does instead.
  const takenInside = useDragState((state) => state.over !== null);
  const windowWidth = useWindowWidth();
  const assistantBeside = useAppStore((state) => {
    const place = state.layout?.assistant;
    if (!place || !isSide(shownDock(place, windowWidth))) return 0;
    return (place.folded ? RAIL : SIDE_MIN) + GAP;
  });
  const openSettings = useAppStore((state) => state.openSettings);
  useKeymap();
  useMeetingHelpInWindow();
  useEditMenu();
  useEscapeToDismiss();
  useRememberSidebarWidth(device?.sidebarWidth);
  const workbench = useRef<HTMLDivElement>(null);
  const beforeSlide = useSidebarSlide(workbench);
  const sidebar = useSidebarControl(device?.sidebarHidden ?? false, beforeSlide);
  useExportMenu();
  useExamplesMenu();
  const peek = useSidebarPeek(sidebar.hidden, beforeSlide);
  const [announcement, setAnnouncement] = useState("");
  const announced = useRef(sidebar.hidden);
  useEffect(() => {
    if (announced.current === sidebar.hidden) return;
    announced.current = sidebar.hidden;
    setAnnouncement(t(sidebar.hidden ? "sidebar.hidden.announce" : "sidebar.shown.announce"));
  }, [sidebar.hidden, t]);
  const control = useMemo(
    () => ({
      hidden: sidebar.hidden,
      peeking: peek.peeking,
      toggle: sidebar.toggle,
      takeRefocus: sidebar.takeRefocus,
    }),
    [sidebar.hidden, peek.peeking, sidebar.toggle, sidebar.takeRefocus],
  );
  useHandle(sidebarHandle, control);

  if (!device) return null;
  const { sidebarWidth } = device;
  // What the sidebar may take, with the card's gap and margin and its minimum kept, and the
  // least an assistant docked on a side needs.
  const room = windowWidth - 2 * CARD_GAP - CARD_MIN - assistantBeside;

  return (
    <SidebarControlContext.Provider value={control}>
      <div
        className="relative flex h-screen overflow-hidden bg-frame"
        // The sidebar's panel, and the line about tabs above its foot, are as wide as it.
        style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
        {...fileDrop.handlers}
      >
        {/* The 8px above the card moves the window like the band does. */}
        <div aria-hidden="true" className="title-bar absolute inset-x-0 top-0 h-2" />
        {/* Shown, this wrapper takes no box of its own; hidden, it is the panel that slides out. */}
        <div
          data-testid="sidebar-panel"
          data-hidden={sidebar.hidden || undefined}
          data-open={peek.peeking || undefined}
          className="sidebar-panel"
          {...peek.panel}
        >
          <PanelBoundary
            name="sidebar"
            frame={{
              tag: "aside",
              className: "flex min-w-[165px] shrink flex-col bg-frame",
              style: { flexBasis: sidebarWidth },
              attributes: { id: "sidebar", "data-testid": "sidebar" },
            }}
          >
            <Sidebar width={sidebarWidth} onOpenSettings={openSettings} />
          </PanelBoundary>
        </div>
        {sidebar.hidden ? (
          <div
            aria-hidden="true"
            data-testid="sidebar-edge"
            className="sidebar-edge"
            onPointerEnter={peek.onEdge}
          />
        ) : (
          <ResizeRod
            label={t("sidebar.resize")}
            width={sidebarWidth}
            min={SIDEBAR.min}
            max={Math.min(SIDEBAR.max, room)}
            direction={1}
            gap
            testId="sidebar-resize"
            onPreview={(width) => previewLayout({ sidebarWidth: width })}
            onCommit={(width) => void updateSettings({ device: { sidebarWidth: width } })}
            onCollapse={() => sidebar.setHidden(true)}
          />
        )}
        <Workbench
          ref={workbench}
          sidebarHidden={sidebar.hidden}
          // Links dropped become web pages, so the card is where they go (#261).
          cardOverlay={fileDrop.active && fileDrop.links ? <DropOverlay links /> : null}
        />
        <DropLabel />
        <PanelBoundary name="overlays">
          <CommandPalette />
          {/* Where Move to… from ⌘K opens when nothing it moves is in sight: where the palette was. */}
          <span
            data-move-to-fallback
            aria-hidden="true"
            className="pointer-events-none fixed top-16 left-[calc(50%-8rem)] size-px"
          />
          <SettingsDialog />
          <HistoryView />
          <TagsDialog />
          <RequestedDialogs />
          <SortMenu />
          <DocumentMoveTo />
          <InfoPanel />
          <Peek />
          <AddWebPageDialog />
          <FeedbackDialog />
          <WordImportDialog />
          <ChatGptWelcomeDialog />
          <CitationStylePickerHost />
          <MindStyleHost />
          {/* Open after the dialog that triggered the request, so they show on top of it. */}
          <ConsentDialog />
          <MeetingNoticeDialog />
          <FileWriteDialog />
        </PanelBoundary>
        <ErrorNotices />
        {fileDrop.active && !fileDrop.links && !takenInside && <DropOverlay />}
        <p role="status" data-testid="sidebar-announcement" className="sr-only">
          {announcement}
        </p>
      </div>
    </SidebarControlContext.Provider>
  );
}
