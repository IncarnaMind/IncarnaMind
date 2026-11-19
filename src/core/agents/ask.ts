/**
 * Ask your AI (#3373): a short request, in the interface language, for the User to send in their
 * own AI. The agent's app opens with it typed where the app documents a link for that
 * (./clients); otherwise it comes back for the User to copy. IncarnaMind sends nothing, and the
 * request goes nowhere until the User presses send there.
 *
 * It names the Note as the agent's Tools find it, by its title and its id, and holds at most one
 * sentence of it with a few words of what its check said, or the words the User typed: nothing
 * else of the Note or the Documents.
 */
import type { MessageKey, MessageParams } from "../../shared/i18n/types";
import { mindName, quotedName } from "../../shared/naming";
import type { Logger } from "../adapters";
import {
  type AgentAsk,
  type AgentPairing,
  ASK_VERDICTS,
  type AskAgentInput,
  type AskAgentResult,
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
  /** Opens a link in the agent's app; null where this copy of IncarnaMind can't. */
  openLink: ((url: string) => Promise<void>) | null;
  say: Say;
  log: Logger;
}

/** The request the User's AI is given: the Note named by its title and id, and what to do. */
export function agentRequest(
  note: { title: string; mindId: string } | null,
  ask: AgentAsk,
  say: Say,
  meeting?: { transcriptId: string; propose: boolean },
): string {
  if (ask.kind === "question" && note === null) {
    return say("agents.ask.request.questionAlone", { question: ask.text });
  }
  if (note === null) throw new InvalidInputError({ key: "error.agent.askRequest" });
  const named = { title: quotedName(note.title), mindId: note.mindId };
  switch (ask.kind) {
    case "meeting":
      if (!meeting) throw new NotFoundError({ key: "error.agent.meetingUnavailable" });
      return say("agents.ask.request.meeting", {
        ...named,
        transcriptId: meeting.transcriptId,
        action: say(meeting.propose ? "agents.ask.meeting.propose" : "agents.ask.meeting.reply"),
      });
    case "question":
      return say("agents.ask.request.question", { ...named, question: ask.text });
    case "note":
      return say("agents.ask.request.note", named);
    case "fix":
      return say("agents.ask.request.fix", {
        ...named,
        sentence: quotedName(ask.sentence),
        verdict: say(`agents.ask.verdict.${ask.verdict}`),
      });
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
      const verdict = ASK_VERDICTS.find((each) => each === value.verdict);
      if (!verdict) throw new InvalidInputError({ key: "error.agent.askRequest" });
      return { kind: "fix", sentence: words(value.sentence), verdict };
    }
    default:
      throw new InvalidInputError({ key: "error.agent.askRequest" });
  }
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
      const text = agentRequest(
        note,
        ask,
        options.say,
        transcriptId ? { transcriptId, propose: pairing.propose } : undefined,
      );
      const link = promptLinkFor(pairing.client, text);
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
      return { kind: "copy", text };
    },
  };
}
