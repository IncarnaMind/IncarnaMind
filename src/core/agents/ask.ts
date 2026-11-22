/**
 * Ask your AI (#3373): a request, in the interface language, for the User to send in their own
 * AI. Its line is what a person would type, in the User's words, naming IncarnaMind and the Note
 * by its title: the agent's app opens with it typed where the app documents a link for that
 * (./clients); otherwise it comes back for the User to copy. IncarnaMind sends nothing, and the
 * request goes nowhere until the User presses send there.
 *
 * The rest of it waits in IncarnaMind for that agent alone (#3419), which reads it with
 * `read_request` while it may still read the Note: the Note's id, the sentences that need a look
 * with a few words of what the check said of each, and what to change and leave alone. Nothing
 * else of the Note or the Documents. A question the User typed stays in the line: the words are
 * theirs.
 *
 * A question typed in the chat box also carries what the User is looking at (#3533): the Documents
 * open and the Search scope, as the in-app assistant is given them. The line names the Document in
 * front; the rest waits in the request. Only what the asked agent can read now is named or kept.
 */
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { mindName, quotedName } from "../../shared/naming";
import type { Logger } from "../adapters";
import {
  type AgentAsk,
  type AgentPairing,
  type AgentRequest,
  ASK_VERDICTS,
  type AskAgentResult,
  type AskedSentence,
  MAX_ASKED_SENTENCES,
  type Mind,
  NOT_IN_A_FOLDER_ID,
  type OrganizeTarget,
  type SearchScope,
} from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import { parseSearchScope } from "../scope";
import { frontLinkFor, promptLinkFor } from "./clients";
import type { RequestNamed } from "./requests";

type Say = (key: MessageKey, params?: MessageParams) => string;

export interface AgentAskOptions {
  /** The agents the User can ask about this Note now (`createAgents().askable`). */
  askable(mindId: string | null, documentId?: string): AgentPairing[];
  /** Of these Folders and Documents, those the pairing can read now (`createAgents().reads`). */
  reads(pairingId: string, ids: Ids): Ids;
  /** A Folder's or a Document's name now; null when it is gone. */
  nameOf(kind: "folder" | "document", id: string): string | null;
  minds(): Mind[];
  meetingTranscript(meetingId: string, mindId: string): string | null;
  /** Keeps what the line doesn't say, for the pairing to read (`createAgents().keepRequest`). */
  keepRequest(
    request: Pick<AgentRequest, "pairingId" | "mindId" | "sentences"> & {
      title: string;
      text: string;
      named: RequestNamed | null;
    },
  ): AgentRequest;
  /**
   * The file an outside agent handed over that the Note checks (#3412), with where in it the check
   * a fix names is; null for a Note that checks none.
   */
  handedFile(mindId: string): HandedFileAsked | null;
  /** Opens a link in the agent's app; null where this copy of IncarnaMind can't. */
  openLink: ((url: string) => Promise<void>) | null;
  say: Say;
  log: Logger;
}

interface Ids {
  folderIds: readonly string[];
  documentIds: readonly string[];
}

/** A Folder or a Document, as a request names it. */
interface Named {
  id: string;
  name: string;
}

/**
 * What the User is looking at when they ask in the chat box, as far as the asked agent can read it:
 * the Documents open, the one in front first, and the Folders and Documents of the Search scope.
 */
export interface Looking {
  open: Named[];
  folders: Named[];
  documents: Named[];
}

const NOTHING_IN_SIGHT: Looking = { open: [], folders: [], documents: [] };

/** A handed-over file a request is about: the agent fixes it in the file and hands it over again. */
export interface HandedFileAsked {
  title: string;
  version: number;
  /** The path the agent handed it over from. */
  path: string;
  /** Where in the file the claim a check result is on stands ("slide 4"); null when unknown. */
  whereOf(checkId: string | null): string | null;
}

/** A request to the User's AI: the line they send, and what waits for the agent (null: nothing). */
export interface AgentRequestText {
  line: string;
  request: string | null;
  /** What the request names by id, whose names are put in its text when the agent reads it (#3533). */
  named?: RequestNamed;
  sentences: AgentRequest["sentences"];
}

const verdictOf = (asked: AskedSentence, say: Say) => say(`agents.ask.verdict.${asked.verdict}`);

/** What the Documents say instead, for a sentence its check found a quote against (#3383). */
const quoteOf = (asked: AskedSentence, say: Say) =>
  asked.quote ? say("agents.ask.request.quote", { quote: quotedName(asked.quote) }) : "";

/** The line the User sends, and the request that waits: the Note named by its title, and its id in the request. */
export function agentRequest(
  note: { title: string; mindId: string } | null,
  ask: Exclude<AgentAsk, { kind: "organize" | "summary" }>,
  say: Say,
  meeting?: { transcriptId: string; propose: boolean },
  file?: HandedFileAsked | null,
  looking: Looking = NOTHING_IN_SIGHT,
): AgentRequestText {
  if (ask.kind === "question" && note === null) {
    return questionRequest(null, ask.text, looking, say);
  }
  if (note === null) throw new InvalidInputError({ key: "error.agent.askRequest" });
  const title = quotedName(note.title);
  const named = { title, mindId: note.mindId };
  if (file && (ask.kind === "fix" || ask.kind === "note" || ask.kind === "question")) {
    return fileRequest(file, ask, say);
  }
  switch (ask.kind) {
    case "meeting":
      if (!meeting) throw new NotFoundError({ key: "error.agent.meetingUnavailable" });
      return {
        line: say("agents.ask.line.meeting", { title }),
        request: say("agents.ask.request.meeting", {
          ...named,
          transcriptId: meeting.transcriptId,
          action: say(meeting.propose ? "agents.ask.meeting.propose" : "agents.ask.meeting.reply"),
        }),
        sentences: [],
      };
    case "question":
      return questionRequest(note, ask.text, looking, say);
    case "check":
      return {
        line: say("agents.ask.line.check", { title }),
        request: say("agents.ask.request.check", named),
        sentences: [],
      };
    case "note":
      return {
        line: say("agents.ask.line.note", { title }),
        request: say("agents.ask.request.note", named),
        sentences: [],
      };
    case "fix": {
      const sentences = ask.sentences.map((each) => ({
        sentence: each.sentence,
        checkId: each.checkId ?? null,
      }));
      const [only] = ask.sentences;
      if (only && ask.sentences.length === 1) {
        return {
          line: say("agents.ask.line.fix", { title }),
          request: say("agents.ask.request.fix", {
            ...named,
            sentence: quotedName(only.sentence),
            verdict: verdictOf(only, say),
            quote: quoteOf(only, say),
          }),
          sentences,
        };
      }
      return {
        line: say("agents.ask.line.fixAll", { title, count: ask.sentences.length }),
        request: say("agents.ask.request.fixAll", {
          ...named,
          count: ask.sentences.length,
          sentences: ask.sentences
            .map((each, at) =>
              say("agents.ask.request.fixAll.item", {
                n: at + 1,
                sentence: quotedName(each.sentence),
                verdict: verdictOf(each, say),
                quote: quoteOf(each, say),
              }),
            )
            .join("\n"),
        }),
        sentences,
      };
    }
  }
}

const itemOf = (item: Named, idName: "folderId" | "documentId", say: Say) =>
  say("agents.ask.request.item", { name: quotedName(item.name), idName, id: item.id });

/** What a question names of what the User looks at, as sentences: the Documents open, then the scope. */
export function lookingText({ open, folders, documents }: Looking, say: Say): string {
  const parts = [
    ...(open.length > 0
      ? [
          say(open.length === 1 ? "agents.ask.request.document" : "agents.ask.request.documents", {
            documents: open.map((each) => itemOf(each, "documentId", say)).join("; "),
          }),
        ]
      : []),
    ...(folders.length + documents.length > 0
      ? [
          say("agents.ask.request.scope", {
            items: [
              ...folders.map((each) => itemOf(each, "folderId", say)),
              ...documents.map((each) => itemOf(each, "documentId", say)),
            ].join("; "),
          }),
        ]
      : []),
  ];
  return parts.join("\n\n");
}

/**
 * The words the User typed in the chat box, named by the Note they are in, else by the Document in
 * front, else by the scope they set, whichever there is. What waits is the Note's sentence; the
 * Documents and Folders are kept by id, to be named when the agent reads it.
 */
function questionRequest(
  note: { title: string; mindId: string } | null,
  question: string,
  looking: Looking,
  say: Say,
): AgentRequestText {
  const [front] = looking.open;
  const title = note && quotedName(note.title);
  const document = front && quotedName(front.name);
  const scoped = looking.folders.length + looking.documents.length > 0;
  const line =
    title !== null && document
      ? say("agents.ask.line.questionNoteDocument", { title, document, question })
      : title !== null
        ? say("agents.ask.line.question", { title, question })
        : document
          ? say("agents.ask.line.questionDocument", { document, question })
          : scoped
            ? say("agents.ask.line.questionScope", { question })
            : say("agents.ask.line.questionAlone", { question });
  const ids = (each: Named[]) => each.map((one) => one.id);
  return {
    line,
    request: note
      ? say("agents.ask.request.note", { title: title ?? "", mindId: note.mindId })
      : null,
    ...(lookingText(looking, say) !== "" && {
      named: {
        open: ids(looking.open),
        folders: ids(looking.folders),
        documents: ids(looking.documents),
      },
    }),
    sentences: [],
  };
}

/** A request about a file the agent handed over: fixed in the file, and handed over again (#3412). */
function fileRequest(
  file: HandedFileAsked,
  ask: Extract<AgentAsk, { kind: "fix" | "note" | "question" }>,
  say: Say,
): AgentRequestText {
  const title = quotedName(file.title);
  const named = { title, version: file.version, path: file.path };
  if (ask.kind !== "fix") {
    return {
      line:
        ask.kind === "question"
          ? say("agents.ask.line.question", { title, question: ask.text })
          : say("agents.ask.line.note", { title }),
      request: say("agents.ask.request.noteFile", named),
      sentences: [],
    };
  }
  const sentences = ask.sentences.map((each) => ({
    sentence: each.sentence,
    checkId: each.checkId ?? null,
  }));
  const whereOf = (asked: AskedSentence) => {
    const where = file.whereOf(asked.checkId ?? null);
    return where ? say("agents.ask.request.fixFile.where", { where }) : "";
  };
  const [only] = ask.sentences;
  if (only && ask.sentences.length === 1) {
    return {
      line: say("agents.ask.line.fixFile", { title }),
      request: say("agents.ask.request.fixFile", {
        ...named,
        where: whereOf(only),
        sentence: quotedName(only.sentence),
        verdict: verdictOf(only, say),
        quote: quoteOf(only, say),
      }),
      sentences,
    };
  }
  return {
    line: say("agents.ask.line.fixFileAll", { title, count: ask.sentences.length }),
    request: say("agents.ask.request.fixFileAll", {
      ...named,
      count: ask.sentences.length,
      sentences: ask.sentences
        .map((each, at) =>
          say("agents.ask.request.fixFile.item", {
            n: at + 1,
            where: whereOf(each),
            sentence: quotedName(each.sentence),
            verdict: verdictOf(each, say),
            quote: quoteOf(each, say),
          }),
        )
        .join("\n"),
    }),
    sentences,
  };
}

/** The most of a quote a request carries, in characters: a Passage's sentence or two. */
const MAX_ASKED_QUOTE = 600;

const words = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidInputError({ key: "error.agent.askRequest" });
  }
  return value.trim();
};

function organizeTarget(value: unknown): OrganizeTarget {
  if (isRecord(value)) {
    if ("folderId" in value && !("ids" in value)) return { folderId: words(value.folderId) };
    if (!("folderId" in value)) {
      if (value.ids === null) return { ids: null };
      if (Array.isArray(value.ids) && value.ids.length > 0) {
        return { ids: [...new Set(value.ids.map(words))] };
      }
    }
  }
  throw new InvalidInputError({ key: "error.agent.askRequest" });
}

function parseAsk(value: unknown): AgentAsk {
  if (!isRecord(value)) throw new InvalidInputError({ key: "error.agent.askRequest" });
  switch (value.kind) {
    case "organize":
      return { kind: "organize", target: organizeTarget(value.target) };
    case "meeting":
      return { kind: "meeting", meetingId: words(value.meetingId) };
    case "question":
      return { kind: "question", text: words(value.text) };
    case "note":
      return { kind: "note" };
    case "check":
      return { kind: "check" };
    case "summary":
      return { kind: "summary", documentId: words(value.documentId) };
    case "fix": {
      const given: unknown[] = Array.isArray(value.sentences) ? value.sentences : [];
      if (given.length === 0 || given.length > MAX_ASKED_SENTENCES) {
        throw new InvalidInputError({ key: "error.agent.askRequest" });
      }
      return { kind: "fix", sentences: given.map(parseSentence) };
    }
    default:
      throw new InvalidInputError({ key: "error.agent.askRequest" });
  }
}

function parseSentence(value: unknown): AskedSentence {
  const verdict = isRecord(value) ? ASK_VERDICTS.find((each) => each === value.verdict) : undefined;
  if (!isRecord(value) || !verdict) throw new InvalidInputError({ key: "error.agent.askRequest" });
  const checkId = typeof value.checkId === "string" && value.checkId !== "" ? value.checkId : null;
  const quote =
    typeof value.quote === "string" && value.quote.trim() !== ""
      ? value.quote.trim().slice(0, MAX_ASKED_QUOTE)
      : null;
  return {
    sentence: words(value.sentence),
    verdict,
    ...(checkId && { checkId }),
    ...(quote && { quote }),
  };
}

/** The ask as the core reads it: what the User looks at is none, never absent. */
interface ParsedInput {
  pairingId: string;
  mindId: string | null;
  ask: AgentAsk;
  onScreen: string[];
  scope: SearchScope | null;
  openChat: boolean;
}

function parseInput(input: unknown): ParsedInput {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.agent.askRequest" });
  const mindId = input.mindId === null ? null : words(input.mindId);
  return {
    pairingId: words(input.pairingId),
    mindId,
    ask: parseAsk(input.ask),
    onScreen: Array.isArray(input.onScreen)
      ? input.onScreen.filter((id): id is string => typeof id === "string" && id !== "")
      : [],
    scope: parseSearchScope(input.scope),
    openChat: input.openChat === true,
  };
}

export function createAgentAsk(options: AgentAskOptions) {
  /** What the User looks at that this agent can read now, named as it is now. */
  const lookingAt = (
    pairingId: string,
    onScreen: readonly string[],
    scope: SearchScope | null,
  ): Looking => {
    const readable = options.reads(pairingId, {
      folderIds: scope?.folderIds ?? [],
      documentIds: [...onScreen, ...(scope?.documentIds ?? [])],
    });
    const named = (
      kind: "folder" | "document",
      ids: readonly string[],
      within: readonly string[],
    ) =>
      ids.flatMap((id) => {
        const name = within.includes(id) ? options.nameOf(kind, id) : null;
        return name === null ? [] : [{ id, name }];
      });
    // The scope is told whole, as far as the agent reads it: a Document open and in the scope is
    // named in both, which is true of both.
    return {
      open: named("document", [...new Set(onScreen)], readable.documentIds),
      folders: named("folder", scope?.folderIds ?? [], readable.folderIds),
      documents: named("document", scope?.documentIds ?? [], readable.documentIds),
    };
  };

  function canOrganize(pairing: AgentPairing, target: OrganizeTarget): boolean {
    if ("ids" in target && target.ids !== null) {
      const readable = options.reads(pairing.id, { folderIds: [], documentIds: target.ids });
      return readable.documentIds.length === target.ids.length;
    }
    const folder = "folderId" in target ? target.folderId : NOT_IN_A_FOLDER_ID;
    return options
      .reads(pairing.id, { folderIds: [folder], documentIds: [] })
      .folderIds.includes(folder);
  }

  function sortingRequest(pairing: AgentPairing, target: OrganizeTarget): AgentRequestText {
    if (!canOrganize(pairing, target)) throw new NotFoundError({ key: "error.agent.cantOrganize" });
    return {
      line: options.say("agents.ask.line.organize"),
      request: null,
      named: {
        organize: "folderId" in target ? "folder" : target.ids === null ? "loose" : "selected",
        open: [],
        folders: "folderId" in target ? [target.folderId] : [],
        documents: "ids" in target && target.ids !== null ? [...target.ids] : [],
      },
      sentences: [],
    };
  }

  /** One Document named in the line, which says everything: nothing waits for the agent (#3572). */
  function summaryRequest(documentId: string): AgentRequestText {
    const name = options.nameOf("document", documentId);
    if (name === null) throw new NotFoundError({ key: "error.agent.cantAskDocument" });
    return {
      line: options.say("firstOpen.agent.line", { document: quotedName(name) }),
      request: null,
      sentences: [],
    };
  }

  return {
    forOrganize(input: unknown) {
      const target = organizeTarget(input);
      const agents = options.askable(null);
      return {
        eligible: agents.filter((agent) => canOrganize(agent, target)),
        connected: agents.length > 0,
      };
    },
    async ask(input: unknown): Promise<AskAgentResult> {
      const { pairingId, mindId, ask, onScreen, scope, openChat } = parseInput(input);
      const pairing = options
        .askable(mindId, ask.kind === "summary" ? ask.documentId : undefined)
        .find((each) => each.id === pairingId);
      if (!pairing)
        throw new NotFoundError({
          key:
            ask.kind === "organize"
              ? "error.agent.cantOrganize"
              : ask.kind === "summary"
                ? "error.agent.cantAskDocument"
                : "error.agent.cantAsk",
        });
      const mind = options.minds().find((each) => each.id === mindId);
      const note = mind
        ? { title: mindName(mind) || options.say("mind.untitled"), mindId: mind.id }
        : null;
      const transcriptId =
        ask.kind === "meeting" && note
          ? options.meetingTranscript(ask.meetingId, note.mindId)
          : null;
      if (
        transcriptId &&
        !options.askable(mindId, transcriptId).some((each) => each.id === pairingId)
      ) {
        throw new NotFoundError({ key: "error.agent.meetingUnavailable" });
      }
      const looking = ask.kind === "question" ? lookingAt(pairingId, onScreen, scope) : undefined;
      if ((ask.kind === "organize" || ask.kind === "summary") && mindId !== null)
        throw new InvalidInputError({ key: "error.agent.askRequest" });
      const { line, request, named, sentences } =
        ask.kind === "organize"
          ? sortingRequest(pairing, ask.target)
          : ask.kind === "summary"
            ? summaryRequest(ask.documentId)
            : agentRequest(
                note,
                ask,
                options.say,
                transcriptId ? { transcriptId, propose: pairing.propose } : undefined,
                note ? options.handedFile(note.mindId) : null,
                looking,
              );
      // Kept before the link opens: the User can send the line the moment the agent's app shows it.
      if (request !== null || named !== undefined) {
        options.keepRequest({
          pairingId,
          mindId: note?.mindId ?? null,
          title:
            ask.kind === "organize"
              ? options.say("library.classify")
              : (note?.title ?? looking?.open[0]?.name ?? ""),
          sentences,
          text: request ?? "",
          named: named ?? null,
        });
      }
      // For the chat the User has open: copied, never typed into a new chat (#3588).
      if (openChat) return { kind: "copy", text: line };
      const link = promptLinkFor(pairing.client, line);
      if (link && options.openLink) {
        try {
          await options.openLink(link);
          return { kind: "opened" };
        } catch (error) {
          // No app on this computer took the link, as before the agent's first session: copied.
          options.log.warn("agents.askLinkUnopened", {
            client: pairing.client ?? "other",
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
      return { kind: "copy", text: line };
    },
    /** See `CoreApi.frontAgent`. */
    async front(pairingId: unknown): Promise<boolean> {
      const pairing = options.askable(null).find((each) => each.id === pairingId);
      const link = pairing ? frontLinkFor(pairing.client) : null;
      if (!pairing || !link || !options.openLink) return false;
      try {
        await options.openLink(link);
        return true;
      } catch (error) {
        options.log.warn("agents.askFrontUnopened", {
          client: pairing.client ?? "other",
          error: error instanceof Error ? error.name : "unknown",
        });
        return false;
      }
    },
  };
}
