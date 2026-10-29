import { type Editor, isMacOS } from "@tiptap/core";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type * as Y from "yjs";
import type { AnswerPlace, SearchScope } from "../../../core/api";
import { mindName } from "../../../shared/naming";
import {
  chosenScope,
  filingFolder,
  hasSearchScope,
  mindSearchScope,
  type ScopeKind,
  scopeIds,
} from "../../../shared/searchScope";
import { useAnswers } from "../answers";
import { shortcutLabel } from "../commands/keymap";
import { SearchIcon, StopIcon } from "../components/icons";
import { SearchLineIcon, SparkLineIcon } from "../components/lineIcons";
import { ProblemLine } from "../components/ProblemLine";
import { answerAskFrom } from "../components/TaskTray";
import { TypingTextarea } from "../components/TypingTextarea";
import {
  composerKey,
  composerScope,
  type Draft,
  isLongPaste,
  NO_MIND,
  type Paste,
  useComposer,
  withQuotes,
} from "../composer";
import {
  answerBeingWritten,
  askInAssistant,
  stopWriting,
  useAnswerBeingWritten,
  useConversations,
  useHasMessage,
} from "../conversations";
import { core } from "../core";
import { type Dragged, type Dropped, useDropTarget } from "../dragDrop";
import { editFromComposer, stopEditing, useEdits } from "../editWithAi";
import { errorMessage } from "../errors";
import { useT } from "../i18n";
import { useCitedScopeDocument, useScopeBefore } from "../keptScope";
import { modelInUseOf, useModelInUse } from "../modelInUse";
import { newNoteTitle } from "../newNoteRequest";
import { useCitedSource } from "../openCited";
import {
  cancelResearch,
  changePlan,
  openResearch,
  startResearch,
  useResearch,
  useWebMissing,
  useWebReach,
} from "../research";
import type { ScopeChoice } from "../scope";
import { useFolderHoldsDocuments } from "../scopeDocuments";
import { skillDescription } from "../skills";
import { useAppStore } from "../store";
import { tellTask, useTasks } from "../tasks";
import { takeBackLast, tellable } from "../taskTell";
import { taskName } from "../taskText";
import { tellProblemOf } from "../tellTarget";
import { AnswerAnnouncer } from "./AnswerAnnouncer";
import { AskedQuoteChips } from "./AskedQuotes";
import { AskProblem } from "./AskProblem";
import { EditStatus } from "./EditStatus";
import { AskArrowIcon, CollapseIcon, ExpandIcon, RemoveIcon, TableIcon } from "./icons";
import { ModelChip } from "./ModelChip";
import { useMindSelection } from "./mindSelection";
import { PasteChip, usePasteLabel } from "./PasteChip";
import { SkillChip } from "./QuestionView";
import { QuoteChip } from "./QuoteChip";
import { ScopeChips } from "./ScopeChips";
import { type ChoiceListHandle, ScopeChoiceList } from "./ScopePicker";
import { SkillChoiceList } from "./SkillChoiceList";
import { SuggestionOffer } from "./SuggestionOffer";
import { TaskTargetChip } from "./TaskTargetChip";

/** In the composer, a long Search scope shows this many chips, then "+N more". */
const CHIPS_SHOWN = 3;

/** From this many lines, the composer offers Expand (DESIGN.md, Composer › Height). */
const EXPAND_FROM_LINES = 4;

let measuring: CanvasRenderingContext2D | null = null;

/** The text's width on one line, in the font the field draws it in. */
function widthOf(text: string, field: HTMLElement): number {
  measuring ??= document.createElement("canvas").getContext("2d");
  if (!measuring) return 0;
  measuring.font = getComputedStyle(field).font;
  return measuring.measureText(text).width;
}

/** The "@" or "/" being typed: what it picks, what follows it, and where it is in the text. */
interface Picking {
  kind: "scope" | "skill";
  query: string;
  /** Where the "@" or "/" is. */
  from: number;
  /** The caret: the end of what was typed after it. */
  to: number;
}

/** An "@" or "/" at the start or after a space, and what follows it up to the caret. */
const TRIGGER = /(?:^|\s)([@/])([^\s@/]*)$/;

const isCommand = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

/**
 * The one input, at the foot of the assistant (DESIGN.md, Composer; #253),
 * for the Mind the assistant reads: "Ask, or say ‘write a note on…’". ⌘J
 * focuses it from anywhere in the window, unfolding the assistant; Enter asks
 * (Shift+Enter breaks the line); Esc closes what it has open, and then is the
 * assistant's (it folds). Asking asks in the assistant's conversation (#201):
 * the Question shows there at once and its Answer streams in under it; the
 * Mind stays as it is unless the User adds the Answer to it.
 *
 * In its row: a Skill chosen with "/", the text, the quiet model chip, the
 * Search scope (a chip for each Folder, Tag or Document, or "All Documents";
 * "@" adds more), and the Ask button (an up arrow; Stop while an Answer is
 * written, which Enter waits for). Sending empties the text at once, and puts
 * it back if the Question couldn't be asked. A Mind in a Folder starts
 * with the Folder's chip while the Folder holds a Document, and with All
 * Documents while it holds none (`mindSearchScope`). Why a Question couldn't be asked shows on one line above
 * them, with the one thing that fixes it; so does the offer to suggest as the
 * User writes (`SuggestionOffer`).
 */
export function Composer({
  mind,
}: {
  /** The Mind in focus; null in the Library, on Home or in a Document: every Document is searched. */
  mind: { editor: Editor; doc: Y.Doc; mindId: string } | null;
}) {
  const t = useT();
  const mindId = mind?.mindId ?? null;
  const key = mindId ?? NO_MIND;
  const citedSource = useCitedSource();
  const source = mind === null ? citedSource : null;
  const scopeKey = source?.mindId ?? key;
  const { doc: scopeDoc, setScope } = useCitedScopeDocument(source, mind?.doc ?? null);
  const draft = useComposer((state) => state.drafts[key]) ?? EMPTY;
  const scopeDraft = useComposer((state) => state.drafts[scopeKey]) ?? EMPTY;
  // The Mind's Folder: its own Search scope while it holds a Document, and where its new notes go.
  const folderId = useAppStore(
    (state) => state.minds.find((each) => each.id === (source?.mindId ?? mindId))?.folderId ?? null,
  );
  const folderHolds = useFolderHoldsDocuments(folderId);
  const before = useScopeBefore(scopeDoc);
  const folderName = useAppStore(
    (state) => state.library?.groups.find((each) => each.id === folderId)?.name ?? null,
  );
  // What the chips show: what the core will search (#1359). Asking sends `composerScope`.
  const scope = mindSearchScope(scopeDraft.scope, folderId, folderHolds);
  // The Mind in focus changes under the one composer: what was typed with no Mind goes with the
  // User into the Mind that opens, whose draft is empty, and the quotes waiting with it go
  // whatever that draft holds; the rest of its state starts over.
  const was = useRef(key);
  useEffect(() => {
    const before = was.current;
    was.current = key;
    if (before === key) return;
    setPicking(null);
    setExpanded(false);
    setViewing(null);
    setTellProblem(null);
    if (before !== NO_MIND) return;
    const state = useComposer.getState();
    const loose = state.draft(NO_MIND);
    const own = state.draft(key);
    const quotes = loose.quotes ?? [];
    const words =
      (loose.text !== "" || loose.pastes.length > 0) && own.text === "" && own.pastes.length === 0;
    if (!words && quotes.length === 0) return;
    state.update(key, {
      ...(words && { text: loose.text, pastes: loose.pastes }),
      ...(quotes.length > 0 && { quotes: withQuotes(own.quotes ?? [], quotes) }),
    });
    state.update(NO_MIND, {
      ...(words && { text: "", pastes: [] }),
      ...(quotes.length > 0 && { quotes: [] }),
    });
  }, [key]);
  const problem = useAnswers((state) => state.blocked[composerKey(mindId)]);
  const skills = useAppStore((state) => state.skills);
  const field = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<ChoiceListHandle>(null);
  const listId = useId();
  const dropKey = useId();
  const row = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  /** The text runs past one line: it takes the full width and the controls go under it. */
  const [stacked, setStacked] = useState(false);
  /** How many lines the text takes, for Expand. */
  const [lines, setLines] = useState(1);
  const [expanded, setExpanded] = useState(false);
  /** The pasted text being read (View), and whether one couldn't be saved. */
  const [viewing, setViewing] = useState<Paste | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const pasteLabel = usePasteLabel();
  const [picking, setPicking] = useState<Picking | null>(null);
  const [option, setOption] = useState(-1);
  /** An "@" or "/" whose picker Esc closed: it stays text. */
  const dismissed = useRef<number | null>(null);
  /** Where the caret goes once the text drawn changes. */
  const caret = useRef<number | null>(null);
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const skill = draft.skill ? skills.find((each) => each.name === draft.skill) : undefined;
  /** The selection the composer is saying what to change in (Edit with AI…, ⌘J with a selection). */
  const editing = useEdits((state) => state.editing[key]);
  /** The Research plan open in the tray (#130): what is typed changes it. */
  const plan = useResearch((state) => state.plans[key]);
  const researching = draft.research === true;
  const analysing = draft.analyse === true && !researching;
  /** Tell it… (#130): the running Task what is typed goes to. */
  const told = useTasks((state) => (draft.tell ? state.tasks[draft.tell] : undefined));
  const target = mind && told ? told : undefined;
  const targetProblem = tellProblemOf(Boolean(mind), draft.tell ? target : null);
  /** Why the last message couldn't reach its Task. */
  const [tellProblem, setTellProblem] = useState<string | null>(null);
  const chosenModel = useModelInUse(mind?.doc ?? null);
  const webReach = useWebReach(chosenModel);
  const webMissing = useWebMissing(webReach, chosenModel);
  const researchHint = webMissing
    ? t("research.command.hint.libraryOnly", { reason: webMissing })
    : t("research.command.hint");
  const selection = useMindSelection(mind, editing !== undefined);
  const mindTitle = useAppStore((state) => {
    const own = state.minds.find((each) => each.id === mindId);
    return (own && mindName(own)) || t("mind.untitled");
  });

  const update = (change: Partial<Draft>) => {
    const composer = useComposer.getState();
    if (change.scope !== undefined && scopeKey !== key) {
      const { scope, ...rest } = change;
      if (Object.keys(rest).length > 0) composer.update(key, rest);
      composer.update(scopeKey, { scope });
    } else {
      composer.update(key, change);
    }
    if (change.scope !== undefined) setScope(change.scope);
  };
  /** Keeps the scope the User chose; the Mind's own follows it to another Folder. */
  const updateScope = (next: SearchScope) => update({ scope: chosenScope(next, folderId) });

  // Single-line text sits beside the controls; once it would run past one line, it takes the
  // full width and they move to a row under it. Decided from the width one line has beside the
  // controls, never from how the text wrapped, so the two layouts can't flip each other.
  const measureLayout = () => {
    const element = field.current;
    const rowElement = row.current;
    if (!element || !rowElement) return;
    const style = getComputedStyle(rowElement);
    const fieldStyle = getComputedStyle(element);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const chips = Array.from(rowElement.querySelectorAll<HTMLElement>(".question-skill")).reduce(
      (width, chip) => width + chip.offsetWidth + gap,
      0,
    );
    const room =
      rowElement.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      chips -
      (controls.current?.offsetWidth ?? 0) -
      gap -
      Number.parseFloat(fieldStyle.paddingLeft);
    const runsPast = draft.text.includes("\n") || widthOf(draft.text, element) > room - 2;
    const lineHeight = Number.parseFloat(fieldStyle.lineHeight) || 20;
    const padding =
      Number.parseFloat(fieldStyle.paddingTop) + Number.parseFloat(fieldStyle.paddingBottom);
    setStacked(runsPast);
    setLines(Math.max(1, Math.round((element.scrollHeight - padding) / lineHeight)));
  };
  const measure = useRef(measureLayout);
  measure.current = measureLayout;
  // After every drawing: the text, a Skill or the controls may have changed its width.
  useLayoutEffect(measureLayout);
  useEffect(() => {
    const element = row.current;
    if (!element) return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const showExpand = lines >= EXPAND_FROM_LINES || expanded;

  useLayoutEffect(() => {
    const at = caret.current;
    if (at === null || !field.current) return;
    caret.current = null;
    field.current.setSelectionRange(at, at);
  });

  const pickingAt = (text: string, at: number): Picking | null => {
    const match = TRIGGER.exec(text.slice(0, at));
    if (!match) {
      dismissed.current = null;
      return null;
    }
    const query = match[2] ?? "";
    const from = at - query.length - 1;
    if (dismissed.current === from) return null;
    const kind = match[1] === "@" ? "scope" : "skill";
    return { kind, query, from, to: at };
  };

  // Asked for from elsewhere: ⌘J anywhere in the window but a dialog ("composer.focus"; with
  // text selected in the note, to say what to change in it), Edit with AI… and its siblings,
  // a Skill chosen in the note's slash menu. Taken once the field is on screen: the assistant
  // it sits in unfolds for it first.
  const focusWanted = useComposer((state) => state.focusWanted);
  useEffect(() => {
    const element = field.current;
    if (!focusWanted || !element) return;
    const take = () => {
      if (element.getClientRects().length === 0) return false;
      if (document.activeElement !== element) {
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      }
      useComposer.getState().focusTaken();
      return true;
    };
    if (take()) return;
    const observer = new ResizeObserver(() => {
      if (take()) observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [focusWanted]);

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value;
    update({ text });
    setPicking(pickingAt(text, event.target.selectionStart));
  };

  /** The caret moved (arrows, a click): a picker opens or closes with it. */
  const onSelect = () => {
    const element = field.current;
    if (!element || element.selectionStart !== element.selectionEnd) return;
    const next = pickingAt(element.value, element.selectionStart);
    setPicking((current) =>
      current?.kind === next?.kind && current?.query === next?.query && current?.from === next?.from
        ? current
        : next,
    );
  };

  /** Takes the "@…" or "/…" being typed out of the text, the caret where it was. */
  const withoutTyped = (pick: Picking): string => {
    caret.current = pick.from;
    return draft.text.slice(0, pick.from) + draft.text.slice(pick.to);
  };

  const chooseScope = (choice: ScopeChoice) => {
    const ids = scopeIds(scope, choice.kind);
    const next = ids.includes(choice.id)
      ? scope
      : { ...scope, [SCOPE_LISTS[choice.kind]]: [...ids, choice.id] };
    update({
      scope: chosenScope(next, folderId),
      ...(picking && { text: withoutTyped(picking) }),
    });
    setPicking(null);
    field.current?.focus();
  };

  /** Documents dragged from the sidebar join the Search scope, as "@" would add them. */
  const addDocuments = (fresh: readonly string[]) => {
    if (fresh.length === 0) return;
    updateScope({ ...scope, documentIds: [...scopeIds(scope, "document"), ...fresh] });
    field.current?.focus();
  };
  // Only those not in the scope yet: the composer never lights for a drop that would add nothing.
  const freshIn = (dragged: Dragged | Dropped) => {
    if (dragged.kind !== "objects") return [];
    const have = scopeIds(scope, "document");
    return dragged.refs.flatMap((ref) =>
      ref.kind === "document" && !have.includes(ref.id) ? [ref.id] : [],
    );
  };
  const drop = useDropTarget(`composer:${dropKey}`, {
    accepts: (dragged) => (freshIn(dragged).length > 0 ? { kind: "attach" } : null),
    drop(dropped) {
      addDocuments(freshIn(dropped));
    },
  });

  /** Research…: what is typed next is a topic (#130). */
  const chooseResearch = () => {
    update({
      research: true,
      skill: null,
      analyse: false,
      ...(picking && { text: withoutTyped(picking) }),
    });
    useAnswers.getState().dismiss(composerKey(mindId));
    setPicking(null);
    field.current?.focus();
  };

  const chooseSkill = (name: string) => {
    update({ skill: name, research: false, ...(picking && { text: withoutTyped(picking) }) });
    useAnswers.getState().dismiss(composerKey(mindId));
    setPicking(null);
    field.current?.focus();
  };

  /** A chip's ×. The Folder's own taken out: every Document is searched. */
  const removeFromScope = (kind: ScopeKind, id: string) => {
    const left = scopeIds(scope, kind).filter((each) => each !== id);
    updateScope({ ...scope, [SCOPE_LISTS[kind]]: left });
  };

  // Back to the wide scope it narrowed, never straight to the whole Library: All Documents is a
  // second, deliberate step in the "@" picker.
  const goBack = () => {
    update({ scope: before });
    field.current?.focus();
  };
  const backLabel =
    before === null && folderHolds && folderName !== null
      ? t("composer.scope.back", { name: folderName })
      : t("composer.scope.backAll");

  /** A chip's name, or "All Documents": types the "@" that opens the picker. */
  const openScopePicker = () => {
    const element = field.current;
    const text = draft.text;
    const at = element ? element.selectionEnd : text.length;
    const space = at > 0 && !/\s/.test(text[at - 1] ?? "") ? " " : "";
    const next = `${text.slice(0, at)}${space}@${text.slice(at)}`;
    const from = at + space.length;
    dismissed.current = null;
    update({ text: next });
    caret.current = from + 1;
    setPicking({ kind: "scope", query: "", from, to: from + 1 });
    element?.focus();
  };

  const scopeWanted = useComposer((state) => state.scopeWanted);
  const latestPicker = useRef(openScopePicker);
  latestPicker.current = openScopePicker;
  // Once the field is on screen and has the focus, as `focusWanted` waits for.
  useEffect(() => {
    if (!scopeWanted || focusWanted) return;
    useComposer.getState().scopeTaken();
    latestPicker.current();
  }, [scopeWanted, focusWanted]);

  /** A paste over 2,000 characters or 30 lines becomes a chip instead of going into the text. */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData("text/plain");
    if (!isLongPaste(pasted)) return;
    event.preventDefault();
    setSaveFailed(false);
    update({ pastes: [...draft.pastes, { id: crypto.randomUUID(), text: pasted }] });
  };

  const withoutPaste = (paste: Paste) => draft.pastes.filter((each) => each.id !== paste.id);

  const putBack = (paste: Paste) => {
    const element = field.current;
    const at = element ? element.selectionEnd : draft.text.length;
    const text = draft.text.slice(0, at) + paste.text + draft.text.slice(at);
    caret.current = at + paste.text.length;
    update({ text, pastes: withoutPaste(paste) });
    element?.focus();
  };

  /** Keeps the paste as a Document and adds it to the Search scope, so Answers can cite it. */
  const savePaste = async (paste: Paste) => {
    setSaveFailed(false);
    const first = paste.text.split("\n").find((line) => line.trim() !== "") ?? "";
    try {
      const saved = await core.saveTextAsDocument({
        name: first.trim().slice(0, 60) || t("composer.paste.name"),
        text: paste.text,
      });
      const composer = useComposer.getState();
      const now = composer.draft(key);
      const nowScope = mindSearchScope(composer.draft(scopeKey).scope, folderId, folderHolds);
      const ids = scopeIds(nowScope, "document");
      update({
        pastes: now.pastes.filter((each) => each.id !== paste.id),
        scope: ids.includes(saved.id)
          ? composer.draft(scopeKey).scope
          : chosenScope({ ...nowScope, documentIds: [...ids, saved.id] }, folderId),
      });
    } catch {
      setSaveFailed(true);
    }
    field.current?.focus();
  };

  /** Asks what is in the composer, or `said`: what ⌘K's "Ask about…" asks, leaving the draft as it is. */
  const ask = async (said?: string) => {
    // As it is now, not as it was drawn: "Ask without it" has just taken the Skill off.
    const composer = useComposer.getState();
    const current = composer.draft(key);
    const currentScopeDraft = composer.draft(scopeKey);
    if (said === undefined && mind && useEdits.getState().editing[mind.mindId]) {
      // What to change in the selected text: it comes back as changes in the note.
      if (
        current.text.trim() !== "" &&
        editFromComposer(mind.editor, mind.mindId, mind.doc, current.text)
      ) {
        update({ text: "" });
      }
      return;
    }
    const aimed = current.tell ? useTasks.getState().tasks[current.tell] : undefined;
    if (mind && current.tell) {
      const said = current.text.trim();
      if (!said || !tellable(aimed)) {
        if (!aimed) setTellProblem(t("error.task.tell"));
        return;
      }
      setTellProblem(null);
      update({ text: "", tell: undefined });
      try {
        await tellTask(aimed.id, said);
      } catch (error) {
        setTellProblem(errorMessage(error, t));
        // Its words come back, unless the User has typed anew meanwhile.
        if (useComposer.getState().draft(key).text === "") update({ text: said, tell: aimed.id });
      }
      return;
    }
    if (plan || current.research) {
      const topic = current.text.trim();
      if (!topic) return;
      update({ text: "", research: false });
      if (plan) void changePlan(key, topic, modelInUseOf(mind?.doc ?? null));
      else openResearch(key, topic, modelInUseOf(mind?.doc ?? null), webReach === "ready");
      return;
    }
    // An Answer is being written, or its Question is on its way: Enter waits for it, as in
    // ChatGPT and Claude, so a second press never asks the Question twice. The button is Stop.
    if (answerBeingWritten() !== null) return;
    const draft =
      said === undefined
        ? current
        : { ...current, text: said, pastes: [], skill: null, analyse: false };
    const typed = draft.text.trim();
    // What is pasted, in chips, goes with the words typed.
    const text = [typed, ...draft.pastes.map((paste) => paste.text.trim())]
      .filter((part) => part !== "")
      .join("\n\n");
    if (!text) return;
    // "Create a new note called …": an empty Mind with that title, at once, with no AI step (#202).
    const title = current.pastes.length === 0 && !current.skill ? newNoteTitle(typed) : null;
    if (title) {
      update({ text: "" });
      void useAppStore.getState().createMind({
        title,
        folderId: filingFolder(composerScope(currentScopeDraft, folderId), folderId),
      });
      return;
    }
    useAnswers.getState().dismiss(composerKey(mindId));
    // Words asked from ⌘K go alone: the draft, its chips too, stays for the User.
    const quotes = said === undefined ? (current.quotes ?? []) : [];
    if (said === undefined)
      update({ text: "", skill: null, pastes: [], quotes: [], analyse: false });
    setExpanded(false);
    setViewing(null);
    setPicking(null);
    // In the assistant's conversation: the Mind is read, what is selected in it first, never written to.
    const asked = await askInAssistant({
      mindId,
      text,
      focus: selection.focus(),
      scope,
      model: modelInUseOf(mind?.doc ?? null),
      forcedSkill: draft.skill,
      ...(draft.analyse && { analyse: true }),
      quotes,
    });
    if (asked) {
      selection.asked();
      return;
    }
    // Not asked: its words come back here, unless the User has typed anew meanwhile; its quotes
    // come back whatever was typed.
    const now = useComposer.getState().draft(key);
    const back = withQuotes(quotes, now.quotes ?? []);
    if (now.text === "" && now.pastes.length === 0) {
      update({
        text: typed,
        pastes: draft.pastes,
        skill: now.skill ?? draft.skill,
        analyse: now.analyse || draft.analyse,
        quotes: back,
      });
    } else if (quotes.length > 0) {
      update({ quotes: back });
    }
  };

  const askWanted = useComposer((state) => state.askWanted);
  const writing = useAnswerBeingWritten();
  const hasMessage = useHasMessage();
  const latestAsk = useRef(ask);
  latestAsk.current = ask;
  // Asked once the Answer being written is done, as Enter would be.
  useEffect(() => {
    if (askWanted === null || writing !== null) return;
    useComposer.getState().askTaken();
    void latestAsk.current(askWanted);
  }, [askWanted, writing]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Typing in an input method: its keys are its own.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (picking) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissed.current = picking.from;
        setPicking(null);
        return;
      }
      if (list.current?.onKeyDown(event.nativeEvent)) {
        event.preventDefault();
        return;
      }
    }
    const quotes = draft.quotes ?? [];
    if (
      event.key === "Backspace" &&
      (selection.quote !== "" || quotes.length > 0) &&
      draft.text === "" &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      // As in a recipient field, Backspace at the start takes the last chip away.
      event.preventDefault();
      if (quotes.length > 0) update({ quotes: quotes.slice(0, -1) });
      else selection.leaveOut();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !isCommand(event)) {
      event.preventDefault();
      void ask();
      return;
    }
    if (event.key === "Enter" && isCommand(event) && plan) {
      event.preventDefault();
      void startResearch(key, modelInUseOf(mind?.doc ?? null));
      return;
    }
    // The waiting ask in the tray, nearest the keyboard: ⌘↵ allows, ⌘⌫ (with nothing typed) denies.
    if (
      mind &&
      isCommand(event) &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === "Enter" || (event.key === "Backspace" && draft.text === "")) &&
      answerAskFrom(mind.mindId, event.key === "Enter")
    ) {
      event.preventDefault();
      return;
    }
    if (
      event.key === "ArrowUp" &&
      mind &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      draft.text === "" &&
      draft.pastes.length === 0
    ) {
      // ↑ takes back the last message the Task hasn't read yet, or aims at it.
      const taking = takeBackLast(mind.mindId);
      if (taking) {
        event.preventDefault();
        setTellProblem(null);
        taking.catch((error: unknown) => setTellProblem(errorMessage(error, t)));
        return;
      }
    }
    if (event.key === "Escape" && target) {
      // Back to asking; the next Esc is the plan card's or the assistant's.
      event.preventDefault();
      update({ tell: undefined });
      setTellProblem(null);
      return;
    }
    if (event.key === "Escape" && plan) {
      event.preventDefault();
      cancelResearch(key);
      return;
    }
    if (event.key === "Escape" && researching) {
      // Back to asking; the next Esc is the assistant's.
      event.preventDefault();
      update({ research: false });
      return;
    }
    if (event.key === "Escape" && analysing) {
      event.preventDefault();
      update({ analyse: false });
      return;
    }
    if (event.key === "Escape" && expanded) {
      // The tall editor goes back to its size; the next Esc is the assistant's.
      event.preventDefault();
      setExpanded(false);
      return;
    }
    if (event.key === "Escape" && editing && mind) {
      // Back to asking; the next Esc is the assistant's.
      event.preventDefault();
      stopEditing(mind.editor, mind.mindId);
    }
    // Any other Esc goes on to the assistant, which gives the focus back to the Mind (`Assistant`).
  };

  const canAsk = draft.text.trim() !== "" || draft.pastes.length > 0;
  /** An Answer is being written in the assistant, or on its way: the button is Stop meanwhile. */
  const answering = writing !== null;
  const activeOption = picking && option >= 0 ? `${listId}-${option}` : undefined;
  const askLabel = editing
    ? t("composer.edit.send")
    : target
      ? t("task.tell.send", { task: taskName(target, t) })
      : t("composer.ask");

  return (
    <div
      ref={root}
      data-testid="composer"
      data-expanded={expanded || undefined}
      data-dropping={drop.over ? true : undefined}
      className={expanded ? "composer composer--expanded" : "composer"}
      {...drop.props}
    >
      {mind && (
        <>
          <SuggestionOffer mindId={mind.mindId} doc={mind.doc} editor={mind.editor} />
          <EditStatus mindId={mind.mindId} />
        </>
      )}
      {problem && (
        <AskProblem
          problem={problem}
          testIds={{
            notReady: "composer-not-ready",
            skillUnavailable: "composer-skill-unavailable",
            error: "composer-error",
          }}
          className="composer-problem"
          onAskWithoutSkill={() => {
            update({ skill: null });
            void ask();
          }}
        />
      )}
      {targetProblem && (
        <ProblemLine
          testId="composer-tell-finished"
          className="composer-problem"
          action={{
            label: t("task.tell.remove"),
            onClick: () => {
              update({ tell: undefined });
              field.current?.focus();
            },
          }}
        >
          {target ? t("task.tell.finished", { task: taskName(target, t) }) : t("error.task.tell")}
        </ProblemLine>
      )}
      {tellProblem && (
        <ProblemLine
          testId="composer-tell-problem"
          className="composer-problem"
          action={{ label: t("composer.paste.close"), onClick: () => setTellProblem(null) }}
        >
          {tellProblem}
        </ProblemLine>
      )}
      {saveFailed && (
        <ProblemLine
          testId="composer-paste-save-failed"
          className="composer-problem"
          action={{ label: t("composer.paste.close"), onClick: () => setSaveFailed(false) }}
        >
          {t("composer.paste.saveFailed")}
        </ProblemLine>
      )}
      {viewing && (
        <section
          data-testid="composer-paste-view"
          aria-label={pasteLabel(viewing)}
          className="composer-view"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setViewing(null);
            field.current?.focus();
          }}
        >
          <header className="composer-view-head">
            <span className="truncate">{pasteLabel(viewing)}</span>
            <button
              type="button"
              // biome-ignore lint/a11y/noAutofocus: opened by the User's click, so reading starts here.
              autoFocus
              data-testid="composer-paste-view-close"
              onClick={() => {
                setViewing(null);
                field.current?.focus();
              }}
              className="composer-view-close"
            >
              {t("composer.paste.close")}
            </button>
          </header>
          <pre className="composer-view-text">{viewing.text}</pre>
        </section>
      )}
      <div ref={row} data-stacked={stacked || expanded || undefined} className="composer-row">
        {draft.pastes.length > 0 && (
          <div className="composer-pastes">
            {draft.pastes.map((paste) => (
              <PasteChip
                key={paste.id}
                paste={paste}
                onView={() => setViewing(paste)}
                onPutBack={() => putBack(paste)}
                onSave={() => void savePaste(paste)}
                onRemove={() => {
                  update({ pastes: withoutPaste(paste) });
                  field.current?.focus();
                }}
              />
            ))}
          </div>
        )}
        {selection.quote !== "" && (
          <QuoteChip
            testId="composer-selection"
            quote={selection.quote}
            from={mindTitle}
            removeLabel={t("composer.selection.drop")}
            onShow={selection.show}
            onRemove={() => {
              selection.leaveOut();
              field.current?.focus();
            }}
          />
        )}
        <AskedQuoteChips
          quotes={draft.quotes ?? []}
          onRemove={(quote) => {
            update({ quotes: (draft.quotes ?? []).filter((each) => each !== quote) });
            field.current?.focus();
          }}
        />
        {editing && (
          <span
            data-testid="composer-edit-quote"
            title={t("composer.edit.quote", { text: editing.quote })}
            className="question-skill composer-quote"
          >
            <SparkLineIcon className="question-skill-icon" />
            <span className="truncate">{t("composer.edit.quote", { text: editing.quote })}</span>
            <button
              type="button"
              data-testid="composer-edit-stop"
              aria-label={t("composer.edit.stop")}
              title={t("composer.edit.stop")}
              // The text keeps the focus.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => mind && stopEditing(mind.editor, mind.mindId)}
              className="scope-chip-remove"
            >
              <RemoveIcon className="size-2.5" />
            </button>
          </span>
        )}
        {target && (
          <TaskTargetChip
            task={target}
            canTell={tellable(target)}
            onRemove={() => {
              update({ tell: undefined });
              field.current?.focus();
            }}
          />
        )}
        {researching && !target && (
          <span data-testid="composer-research" title={researchHint} className="question-skill">
            <SearchLineIcon className="question-skill-icon" />
            <span className="truncate">{t("research.chip")}</span>
            <button
              type="button"
              data-testid="composer-research-remove"
              aria-label={t("research.chip.remove")}
              title={t("research.chip.remove")}
              // The text keeps the focus.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => update({ research: false })}
              className="scope-chip-remove"
            >
              <RemoveIcon className="size-2.5" />
            </button>
          </span>
        )}
        {analysing && !target && (
          <span
            data-testid="composer-analyse"
            title={t("analysis.chip.hint")}
            className="question-skill"
          >
            <TableIcon className="question-skill-icon" />
            <span className="truncate">{t("analysis.chip")}</span>
            <button
              type="button"
              data-testid="composer-analyse-remove"
              aria-label={t("analysis.chip.remove")}
              title={t("analysis.chip.remove")}
              // The text keeps the focus.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => update({ analyse: false })}
              className="scope-chip-remove"
            >
              <RemoveIcon className="size-2.5" />
            </button>
          </span>
        )}
        {draft.skill && (
          <SkillChip
            name={draft.skill}
            state={!skill ? "removed" : skill.enabled ? "enabled" : "disabled"}
            onRemove={() => {
              update({ skill: null });
              useAnswers.getState().dismiss(composerKey(mindId));
            }}
            testId="composer-skill"
          />
        )}
        <TypingTextarea
          ref={field}
          rows={1}
          data-testid="composer-input"
          aria-label={
            editing
              ? t("composer.edit.label")
              : t("composer.label", { shortcut: shortcutLabel("composer.focus") })
          }
          placeholder={
            editing
              ? t("composer.edit.placeholder")
              : target
                ? t("task.tell.placeholder")
                : plan
                  ? t("research.placeholder.change")
                  : researching
                    ? t("research.placeholder")
                    : hasMessage
                      ? t("composer.placeholder.followUp")
                      : t("composer.placeholder")
          }
          aria-autocomplete="list"
          aria-controls={picking ? listId : undefined}
          aria-activedescendant={activeOption}
          value={draft.text}
          onChange={onChange}
          onSelect={onSelect}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={(event) => {
            if (!root.current?.contains(event.relatedTarget)) setPicking(null);
          }}
          className="composer-input"
        />
        <div ref={controls} className="composer-controls">
          <ModelChip
            doc={mind?.doc ?? null}
            onChosen={() => field.current?.focus()}
            opensOnRequest
          />
          {hasSearchScope(scope) ? (
            <ScopeChips
              scope={scope}
              ownFolderId={folderId}
              onRemove={removeFromScope}
              {...(scopeDraft.scope !== null &&
                hasSearchScope(scopeDraft.scope) && { back: { label: backLabel, onBack: goBack } })}
              onChange={openScopePicker}
              shown={CHIPS_SHOWN}
              className="composer-scope"
              testId="composer-scope"
            />
          ) : (
            <button
              type="button"
              data-testid="composer-scope-all"
              aria-label={
                folderName !== null && !folderHolds
                  ? t("composer.scope.allEmptyFolder", { folder: folderName })
                  : t("composer.scope.allLabel")
              }
              title={
                folderName !== null && !folderHolds
                  ? t("composer.scope.allEmptyFolder", { folder: folderName })
                  : t("composer.scope.allTitle")
              }
              onClick={openScopePicker}
              className="composer-chip composer-scope-all"
            >
              <SearchIcon className="composer-chip-icon" />
              <span className="truncate">{t("composer.scope.all")}</span>
            </button>
          )}
          {answering && !editing ? (
            <button
              type="button"
              data-testid="composer-stop"
              aria-label={t("command.answer.stop")}
              title={t("command.answer.stop")}
              // The text keeps the focus.
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                // A double click on Ask: its second click lands here, and leaves the Answer be.
                if (event.detail < 2) stopWriting();
              }}
              className="composer-ask"
            >
              <StopIcon className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              data-testid="composer-ask"
              aria-label={askLabel}
              title={askLabel}
              disabled={!canAsk}
              // The text keeps the focus.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void ask()}
              className="composer-ask"
            >
              <AskArrowIcon className="size-3" />
            </button>
          )}
        </div>
        {showExpand && (
          <button
            type="button"
            data-testid="composer-expand"
            aria-label={expanded ? t("composer.collapse") : t("composer.expand")}
            title={expanded ? t("composer.collapse") : t("composer.expand")}
            aria-pressed={expanded}
            // The text keeps the focus.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setExpanded(!expanded);
              field.current?.focus();
            }}
            className="composer-expand"
          >
            {expanded ? <CollapseIcon className="size-3.5" /> : <ExpandIcon className="size-3.5" />}
          </button>
        )}
      </div>
      {picking && (
        <div className="composer-picker">
          {picking.kind === "scope" ? (
            <ScopeChoiceList
              ref={list}
              id={listId}
              scope={scope}
              query={picking.query}
              onChoose={chooseScope}
              onSelect={setOption}
            />
          ) : (
            <SkillChoiceList
              ref={list}
              id={listId}
              onResearch={chooseResearch}
              researchHint={researchHint}
              skills={enabledSkills}
              describe={(each) => skillDescription(each, t)}
              query={picking.query}
              onChoose={chooseSkill}
              onManage={() => useAppStore.getState().openSettings("skills")}
              onSelect={setOption}
            />
          )}
        </div>
      )}
      <AnswerAnnouncer belongs={(place) => answeredHere(mindId, place)} />
    </div>
  );
}

const EMPTY: Draft = { text: "", scope: null, skill: null, pastes: [] };

/** The draft's list of each kind of Search scope item. */
const SCOPE_LISTS: Record<ScopeKind, keyof SearchScope> = {
  folder: "folderIds",
  tag: "tagIds",
  document: "documentIds",
};

/**
 * The Answers the composer's Questions get: in the assistant's conversation
 * (for a new chat, the one its first Question makes), or, regenerated in the
 * note, in this Mind.
 */
function answeredHere(mindId: string | null, place: AnswerPlace): boolean {
  if (mindId !== null && place.mindId === mindId) return true;
  const { openId } = useConversations.getState();
  return place.conversationId !== undefined && (openId === null || openId === place.conversationId);
}
