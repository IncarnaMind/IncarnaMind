import { meetingSummaryModelRoute } from "../../shared/meetingSummary";
import type { CoreAdapters } from "../adapters";
import type { ChatModelChoice, Meeting } from "../api";
import { InvalidInputError } from "../errors";
import type { createChat } from "../providers/chat";
import { type MeetingSummaryInput, meetingSummaryPrompt, summarizeWithChat } from "./summaryModel";

interface Options {
  settings(): { meetingNotesAgentId: string | null; meetingSummaryRoute: string | null };
  model(mindId: string): ChatModelChoice | null;
  chat: Pick<
    ReturnType<typeof createChat>,
    "describeModel" | "prepareModel" | "canPrepareMeetingSummary"
  >;
  get(id: string): Meeting;
  documentPresent(id: string): boolean;
  insideWall(mindId: string, documentId: string): boolean;
  client(mindId: string, documentId: string, route: string): string | null;
  agent: CoreAdapters["summarizeWithMeetingAgent"];
}

export function meetingSummaryRoute(options: Options) {
  function selected(meeting: Meeting): string | null {
    const { meetingNotesAgentId, meetingSummaryRoute: grant } = options.settings();
    if (!grant || meetingNotesAgentId) return grant && meetingNotesAgentId === grant ? grant : null;
    const choice = options.model(meeting.mindId);
    const known = choice && options.chat.describeModel(choice);
    return known && meetingSummaryModelRoute(known.choice, known.service?.id) === grant
      ? grant
      : null;
  }

  function client(meeting: Meeting, route: string) {
    const doc = meeting.transcript?.documentId;
    if (!doc || !options.agent) return null;
    const id = options.client(meeting.mindId, doc, route);
    return id === "codex" || id === "claude-code" ? id : null;
  }

  function allowed(meeting: Meeting, route: string) {
    const doc = meeting.transcript?.documentId;
    if (!doc || !options.documentPresent(doc)) return false;
    if (options.settings().meetingNotesAgentId) return client(meeting, route) !== null;
    const model = options.model(meeting.mindId);
    return (
      !!model &&
      options.chat.canPrepareMeetingSummary(model, options.insideWall(meeting.mindId, doc))
    );
  }

  const denied = () => new InvalidInputError({ key: "error.meeting.summaryUnavailable" });
  return {
    selected,
    allowed,
    async generate(
      meeting: Meeting,
      route: string,
      input: MeetingSummaryInput,
      signal: AbortSignal,
    ) {
      if (selected(meeting) !== route || !allowed(meeting, route)) throw denied();
      if (options.settings().meetingNotesAgentId) {
        const id = client(meeting, route);
        if (!id || !options.agent) throw denied();
        const { instructions, prompt } = meetingSummaryPrompt(input);
        return options.agent({ client: id, instructions, prompt, signal });
      }
      const guardedChat = {
        async prepareModel(...args: Parameters<typeof options.chat.prepareModel>) {
          const prepared = await options.chat.prepareModel(...args);
          signal.throwIfAborted();
          const current = options.get(meeting.id);
          const actual = meetingSummaryModelRoute(
            { providerId: prepared.provider.id, modelId: prepared.modelId },
            prepared.provider.service?.id,
          );
          // Local servers can discover during preparation that a model forwards to a cloud service.
          if (
            actual !== route ||
            current.transcript?.documentId !== meeting.transcript?.documentId ||
            selected(current) !== route ||
            !allowed(current, route)
          )
            throw denied();
          return prepared;
        },
      };
      return summarizeWithChat(guardedChat, options.model(meeting.mindId), input, signal);
    },
  };
}
