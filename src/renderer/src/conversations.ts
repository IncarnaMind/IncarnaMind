import { create } from "zustand";
import type {
  AskedQuote,
  AskInConversationInput,
  ChatModelChoice,
  Conversation,
  ConversationAnswer,
  ConversationAskResult,
  ConversationMessage,
  ConversationQuestion,
  ReadyQuestion,
  SearchScope,
} from "../../core/api";
import { conversationName } from "../../shared/naming";
import { settleAsk, useAnswers } from "./answers";
import { applyWhatWasAsked } from "./askedChanges";
import { watchCommands } from "./assistantCommands";
import { watchMindsMadeBy } from "./assistantMinds";
import { offeredCommands } from "./assistantWindow";
import { clientId } from "./clientId";
import { composerKey, useComposer } from "./composer";
import { core } from "./core";
import { translateNow } from "./i18n";
import { documentsOnScreenOf, groupsMerged } from "./layoutSlice";
import { useModelSetup, waitForModel } from "./modelSetup";
import { useNotices } from "./notices";
import { useAppStore } from "./store";
import { useUndo } from "./undo";

/**
 * The assistant's conversations (ADR-0017), in this window: every one that
 * isn't deleted, newest first, as History lists them; and the one the
 * assistant shows (#201), with its Questions and Answers as the core writes
 * them ("conversation.message"). A new chat is no conversation yet: its first
 * Question makes one.
 */
interface ConversationsState {
  list: readonly Conversation[];
  /** The conversation the assistant shows; null for a new chat, until it is asked in. */
  openId: string | null;
  /** Its messages, in order. */
  messages: readonly ConversationMessage[];
  /** A Question on its way to the core, shown at once until the core has it. */
  asking: string | null;
  /**
   * What that Question reads: the Note it is asked in, if any, and what it searches. The line
   * while it waits names these, never the Note in focus (#2245).
   */
  askingReads: { mindId: string | null; scope: SearchScope | null } | null;
  /** What that Question is about in its Mind (#565); "" when it is about nothing. */
  askingQuote: string;
  /** The words selected in Documents that Question is about. */
  askingQuotes: readonly AskedQuote[];
  /** Stop was pressed while that Question was on its way: its Answer stops as it starts. */
  stopWanted: boolean;
  /** An Answer to bring into view and flash once it shows: a link back from a Note leads there. */
  sought: string | null;
}

export const useConversations = create<ConversationsState>()(() => ({
  list: [],
  openId: null,
  messages: [],
  asking: null,
  askingReads: null,
  askingQuote: "",
  askingQuotes: [],
  stopWanted: false,
  sought: null,
}));

const report = (error: unknown) => useAppStore.getState().reportError(error);

async function load(): Promise<void> {
  try {
    const list = await core.listConversations();
    const { openId } = useConversations.getState();
    // The open one was deleted, here or in another window: the assistant starts a new chat.
    const gone = openId !== null && !list.some((each) => each.id === openId);
    useConversations.setState(gone ? { list, openId: null, messages: [], sought: null } : { list });
  } catch (error) {
    report(error);
  }
}

core.on("conversations.changed", () => void load());
void load();

// Each Question asked and each write of an Answer, in every window: the open conversation's
// take their place, or come at its end.
core.on("conversation.message", (message) => {
  const { openId, messages } = useConversations.getState();
  if (message.conversationId !== openId) return;
  const at = messages.findIndex((each) => each.id === message.id);
  useConversations.setState({
    messages:
      at === -1 ? [...messages, message] : messages.map((each, i) => (i === at ? message : each)),
    // The Question is shown as the core has it now.
    ...(message.kind === "question" && { asking: null, askingReads: null }),
  });
});

/** A conversation by id, as last listed; undefined when it isn't (deleted, or not loaded yet). */
export const conversationById = (id: string): Conversation | undefined =>
  useConversations.getState().list.find((each) => each.id === id);

/** The conversation the assistant shows, as last listed; undefined for a new chat. */
export const useOpenConversation = (): Conversation | undefined =>
  useConversations((state) => state.list.find((each) => each.id === state.openId));

/** What a conversation is called, "New chat" while it has no name. */
export const conversationLabel = (conversation: Conversation | undefined): string =>
  (conversation && conversationName(conversation)) || translateNow("conversation.untitled");

/** The Question an Answer answers, in the open conversation. */
export function questionOf(answer: ConversationAnswer): ConversationQuestion | undefined {
  const found = useConversations
    .getState()
    .messages.find((each) => each.kind === "question" && each.id === answer.questionId);
  return found?.kind === "question" ? found : undefined;
}

/** The open conversation's newest Answer that has finished, if any. */
export function lastAnswer(): ConversationAnswer | undefined {
  const found = useConversations
    .getState()
    .messages.findLast((each) => each.kind === "answer" && each.status !== "streaming");
  return found?.kind === "answer" ? found : undefined;
}

/** Unfolds the assistant, for what it is asked to show. */
function unfold(): void {
  if (useAppStore.getState().layout?.assistant.folded) {
    void useAppStore.getState().placeAssistant({ folded: false });
  }
}

/** A new chat: the assistant shows an empty conversation, which its first Question makes. */
export function startNewChat(): void {
  useConversations.setState({
    openId: null,
    messages: [],
    asking: null,
    askingReads: null,
    sought: null,
  });
}

/** Shows a conversation in the assistant, at one of its Answers (flashed) if given. */
export async function openConversation(conversationId: string, answerId?: string): Promise<void> {
  try {
    const { messages } = await core.getConversation(conversationId);
    useConversations.setState({
      openId: conversationId,
      messages,
      asking: null,
      askingReads: null,
      sought: answerId ?? null,
    });
    unfold();
  } catch (error) {
    report(error);
  }
}

let readyAsking = false;

/**
 * The card's ready Question being asked, whose Answer waits for its Documents to be read (#2218):
 * its row says what it is reading, and offers Stop, until the Answer is there.
 */
export const useReadyAsk = create<{ asking: boolean; waitingFor: string | null }>()(() => ({
  asking: false,
  waitingFor: null,
}));

/**
 * Asks the ready Question the card showed (`ready`), so the click asks exactly what the button
 * names: no second read that a Document or language change could have moved on. About the User's
 * own Document it starts a fresh conversation first, so the example's earlier turns are not in the
 * model's context; no Mind is read either, or the example would colour the first Answer about
 * their file. The example's Answer is written in advance, and the core writes it once its
 * Documents are read: while it waits, the card says so and Stop stops it. Resolves to whether it
 * was asked (or waits for a model).
 */
export async function askReadyQuestion(ready: ReadyQuestion): Promise<boolean> {
  // A double-click asks it once.
  if (readyAsking) return false;
  readyAsking = true;
  try {
    if (ready.scope) {
      startNewChat();
      // Asked like any Question: its step ticks when its Answer arrives, not when it is asked.
      return await askInAssistant({ text: ready.question, mindId: null, scope: ready.scope });
    }
    // The last ask's problem is not this ask's: the row says what this one is reading.
    settleAsk(composerKey(null), null);
    useReadyAsk.setState({ asking: true, waitingFor: ready.waitingFor });
    try {
      const { conversationId, stopped } = await core.askExampleReadyQuestion();
      // Stopped: its Question and a stopped Answer are kept, and step 2 stays open to ask again.
      if (!stopped) useAppStore.getState().updateGettingStarted({ askedReady: true });
      await openConversation(conversationId);
      return !stopped;
    } catch (error) {
      // Why not, and what to do, where the card's button is, rather than a notice that passes.
      settleAsk(composerKey(null), null, error);
      return false;
    } finally {
      useReadyAsk.setState({ asking: false, waitingFor: null });
    }
  } finally {
    readyAsking = false;
  }
}

/** Stop while the ready Question waits for its Documents: its Answer says Stopped. */
export function stopReadyAsk(): void {
  core.stopExampleReadyQuestion().catch(report);
}

function sayLeftOut(result: ConversationAskResult): void {
  if (!result.asked) return;
  const { documents } = useAppStore.getState();
  for (const quote of result.leftOut ?? []) {
    const here = documents.some((each) => each.id === quote.documentId);
    const said = here ? "assistant.quote.leftOut" : "assistant.quote.leftOut.deleted";
    useNotices
      .getState()
      .showError(new Error(translateNow(said, { document: quote.documentName })));
  }
}

const documentsOnScreen = () => documentsOnScreenOf(useAppStore.getState().layout, groupsMerged());

/**
 * Asks a Question from the composer in the assistant's conversation (a
 * new one for a new chat): it shows at once, and its Answer streams in there.
 * Why it couldn't be asked is kept for the composer (`composerKey`). Resolves
 * to whether it was asked.
 */
export async function askInAssistant(
  input: Omit<AskInConversationInput, "conversationId"> & { mindId: string | null },
): Promise<boolean> {
  const key = composerKey(input.mindId);
  useConversations.setState({
    asking: input.text,
    askingReads: { mindId: input.mindId, scope: input.scope ?? null },
    askingQuote: input.mindId ? (input.focus?.selection ?? "") : "",
    askingQuotes: input.quotes ?? [],
    stopWanted: false,
    sought: null,
  });
  try {
    const result = await core.askInConversation({
      ...input,
      conversationId: useConversations.getState().openId,
      onScreen: documentsOnScreen(),
      commands: offeredCommands(input.mindId),
      clientId,
    });
    if (
      !result.asked &&
      result.reason === "not-ready" &&
      result.readiness.reason === "no-provider"
    ) {
      // No model yet: the Question waits in the conversation while the setup card is shown.
      settleAsk(key, null);
      waitForModel({ ...input, conversationId: useConversations.getState().openId });
      return true;
    }
    settleAsk(key, result);
    sayLeftOut(result);
    if (!result.asked) return false;
    watchMindsMadeBy(result.answerId);
    await applyWhatWasAsked(result.answerId);
    watchCommands(result.answerId);
    const id = result.conversation.id;
    if (useConversations.getState().stopWanted) {
      core.stopConversationAnswer({ conversationId: id, answerId: result.answerId }).catch(report);
    }
    if (useConversations.getState().openId !== id) {
      // A new conversation: its messages as they are now; each write after this comes as an event.
      useConversations.setState({ openId: id, messages: [] });
      const { messages } = await core.getConversation(id);
      if (useConversations.getState().openId === id) useConversations.setState({ messages });
    }
    return true;
  } catch (error) {
    settleAsk(key, null, error);
    return false;
  } finally {
    useConversations.setState({ asking: null, askingReads: null, stopWanted: false });
  }
}

/** Asks the Question that waited for a model, now that one is set. */
function askWaitingQuestion(): void {
  const { waiting } = useModelSetup.getState();
  if (!waiting) return;
  useModelSetup.setState({ waiting: null });
  const { conversationId, ...question } = waiting;
  (async () => {
    // The conversation it was typed in, whichever is open now.
    if (useConversations.getState().openId !== conversationId) {
      if (conversationId) await openConversation(conversationId);
      else startNewChat();
    }
    await askInAssistant(question);
  })().catch((error: unknown) => useAppStore.getState().reportError(error));
}

core.on("chatReadiness.changed", (readiness) => {
  if (!readiness.ready) {
    // The model that worked is gone: the card asks for one again.
    useModelSetup.setState({ ready: false });
    return;
  }
  const { wanted, waiting } = useModelSetup.getState();
  if (!wanted && !waiting) return;
  // The card stays for steps 2 and 3, after the Question that waited has been asked from it.
  useModelSetup.setState({ ready: true, wanted: true });
  // The Question runs as soon as step 1 works; steps 2 and 3 stay below its Answer (#1922).
  askWaitingQuestion();
});

/** Continue on the setup card: the Question that waited is asked, and the composer takes the card's place. */
export function continueSetup(): void {
  useModelSetup.setState({ wanted: false, ready: false });
  // The setup card goes with the focus in it: the composer, where the User asks next, takes it.
  useComposer.getState().requestFocus();
  askWaitingQuestion();
}

/**
 * Writes an Answer of the open conversation again; why it couldn't be is kept under its id.
 * `clearScope`: from every Document, its Question's Search scope taken off (#748). `model`:
 * with this model, which the Question then keeps (#1848).
 */
export async function regenerateAnswer(
  answerId: string,
  { clearScope = false, model }: { clearScope?: boolean; model?: ChatModelChoice } = {},
): Promise<void> {
  const conversationId = useConversations.getState().openId;
  if (!conversationId) return;
  settleAsk(answerId, null);
  try {
    watchMindsMadeBy(answerId);
    await applyWhatWasAsked(answerId, { keepWritten: clearScope });
    watchCommands(answerId);
    const result = await core.regenerateConversationAnswer({
      conversationId,
      answerId,
      ...(clearScope && { clearScope }),
      ...(model && { model }),
      onScreen: documentsOnScreen(),
      commands: offeredCommands(askedFrom(answerId)),
      clientId,
    });
    settleAsk(answerId, result);
    sayLeftOut(result);
  } catch (error) {
    settleAsk(answerId, null, error);
  }
}

/** The Note the Question of an Answer of the open conversation was asked from, while it is there. */
function askedFrom(answerId: string): string | null {
  const { messages } = useConversations.getState();
  const answer = messages.find((message) => message.id === answerId);
  const question =
    answer?.kind === "answer"
      ? messages.find((message) => message.id === answer.questionId)
      : undefined;
  const from = question?.kind === "question" ? question.askedFrom : null;
  return from && !from.deleted ? from.mindId : null;
}

/** Stops an Answer of the open conversation being written, keeping what it has. */
export function stopAnswer(answerId: string): void {
  const conversationId = useConversations.getState().openId;
  if (conversationId) core.stopConversationAnswer({ conversationId, answerId }).catch(report);
}

/**
 * A Question has been asked and its Answer isn't here yet: until the core has
 * the Question, and between its two events (the Question, then its Answer),
 * which can be drawn apart.
 */
const answerOnItsWay = (state: ConversationsState): boolean =>
  state.asking !== null || state.messages.at(-1)?.kind === "question";

/** Whether an Answer is on its way (see `answerOnItsWay`), as it changes. */
export const useAnswerOnItsWay = (): boolean => useConversations(answerOnItsWay);

/** Whether the open conversation has a Question or an Answer, one still on its way included. */
export const useHasMessage = (): boolean =>
  useConversations((state) => state.messages.length > 0 || state.asking !== null);

/**
 * What the composer waits on before it asks again: the open conversation's
 * Answer being written, by id, or "" while a Question is on its way and its
 * Answer not here yet; null when it can ask. Meanwhile its send button is
 * Stop, as in ChatGPT and Claude, so a Question is never sent twice by a
 * second press.
 */
function writingIn(state: ConversationsState, writing: ReadonlySet<string>): string | null {
  const answer = state.messages.find(
    (each) => each.kind === "answer" && (each.status === "streaming" || writing.has(each.id)),
  );
  if (answer) return answer.id;
  return answerOnItsWay(state) ? "" : null;
}

/** What the composer waits on now (see `writingIn`). */
export const answerBeingWritten = (): string | null =>
  writingIn(useConversations.getState(), useAnswers.getState().writing);

/** What the composer waits on, as it changes (see `writingIn`). */
export function useAnswerBeingWritten(): string | null {
  const writing = useAnswers((state) => state.writing);
  return useConversations((state) => writingIn(state, writing));
}

/**
 * Stop, in the composer and on the Answer on its way: stops the open
 * conversation's Answer being written, keeping what it has; one whose
 * Question is still on its way stops as soon as it starts.
 */
export function stopWriting(): void {
  const answerId = answerBeingWritten();
  if (answerId) stopAnswer(answerId);
  else if (answerId === "") useConversations.setState({ stopWanted: true });
}

/**
 * "Clear this conversation": it goes to Recently deleted, and the assistant
 * starts a new chat; Undo (on the line, or ⌘Z) brings it back and shows it.
 */
export async function clearConversation(): Promise<void> {
  const { openId } = useConversations.getState();
  if (!openId) return;
  const conversation = conversationById(openId);
  const name = (conversation && conversationName(conversation)) || "";
  await core.deleteConversation(openId);
  startNewChat();
  useUndo.getState().push({
    said: (t) => t("assistant.cleared", { title: name || t("conversation.untitled") }),
    undo: async () => {
      await core.restore([{ kind: "conversation", id: openId }]);
      await openConversation(openId);
    },
  });
}
