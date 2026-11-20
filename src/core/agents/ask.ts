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
 */
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { mindName, quotedName } from "../../shared/naming";
import type { Logger } from "../adapters";
import {
  type AgentAsk,
  type AgentPairing,
  type AgentRequest,
  ASK_VERDICTS,
  type AskAgentInput,
  type AskAgentResult,
  type AskedSentence,
  MAX_ASKED_SENTENCES,
  type Mind,
} from "../api";
import { InvalidInputError, isRecord, NotFoundError } from "../errors";
import { promptLinkFor } from "./clients";

type Say = (key: MessageKey, params?: MessageParams) => string;

export interface AgentAskOptions {
  /** The agents the User can ask about this Note now (`createAgents().askable`). */
  askable(mindId: string | null, documentId?: string): AgentPairing[];
  minds(): Mind[];
  meetingTranscript(meetingId: string, mindId: string): string | null;
  /** Keeps what the line doesn't say, for the pairing to read (`createAgents().keepRequest`). */
  keepRequest(
    request: Pick<AgentRequest, "pairingId" | "mindId" | "sentences"> & {
      text: string;
    },
  ): AgentRequest;
  /** Opens a link in the agent's app; null where this copy of IncarnaMind can't. */
  openLink: ((url: string) => Promise<void>) | null;
  say: Say;
  log: Logger;
}

/** A request to the User's AI: the line they send, and what waits for the agent (null: nothing). */
export interface AgentRequestText {
  line: string;
  request: string | null;
  sentences: AgentRequest["sentences"];
}

const verdictOf = (asked: AskedSentence, say: Say) => say(`agents.ask.verdict.${asked.verdict}`);

/** The line the User sends, and the request that waits: the Note named by its title, and its id in the request. */
export function agentRequest(
  note: { title: string; mindId: string } | null,
  ask: AgentAsk,
  say: Say,
  meeting?: { transcriptId: string; propose: boolean },
): AgentRequestText {
  if (ask.kind === "question" && note === null) {
    return {
      line: say("agents.ask.line.questionAlone", { question: ask.text }),
      request: null,
      sentences: [],
    };
  }
  if (note === null) throw new InvalidInputError({ key: "error.agent.askRequest" });
  const title = quotedName(note.title);
  const named = { title, mindId: note.mindId };
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
      return {
        line: say("agents.ask.line.question", { title, question: ask.text }),
        request: say("agents.ask.request.note", named),
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
              }),
            )
            .join("\n"),
        }),
        sentences,
      };
    }
  }
}

const words = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidInputError({ key: "error.agent.askRequest" });
  }
  return value.trim();
};

function parseAsk(value: unknown): AgentAsk {
  if (!isRecord(value)) throw new InvalidInputError({ key: "error.agent.askRequest" });
  switch (value.kind) {
    case "meeting":
      return { kind: "meeting", meetingId: words(value.meetingId) };
    case "question":
      return { kind: "question", text: words(value.text) };
    case "note":
      return { kind: "note" };
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
  return { sentence: words(value.sentence), verdict, ...(checkId && { checkId }) };
}

function parseInput(input: unknown): AskAgentInput {
  if (!isRecord(input)) throw new InvalidInputError({ key: "error.agent.askRequest" });
  const mindId = input.mindId === null ? null : words(input.mindId);
  return { pairingId: words(input.pairingId), mindId, ask: parseAsk(input.ask) };
}

export function createAgentAsk(options: AgentAskOptions) {
  return {
    async ask(input: unknown): Promise<AskAgentResult> {
      const { pairingId, mindId, ask } = parseInput(input);
      const pairing = options.askable(mindId).find((each) => each.id === pairingId);
      if (!pairing) throw new NotFoundError({ key: "error.agent.cantAsk" });
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
      const { line, request, sentences } = agentRequest(
        note,
        ask,
        options.say,
        transcriptId ? { transcriptId, propose: pairing.propose } : undefined,
      );
      // Kept before the link opens: the User can send the line the moment the agent's app shows it.
      if (request !== null && note) {
        options.keepRequest({ pairingId, mindId: note.mindId, sentences, text: request });
      }
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
  };
}
