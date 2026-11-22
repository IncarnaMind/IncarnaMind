import { meetingBriefEvents } from "../../shared/meetingBrief";
import { sentenceSpans } from "../../shared/sentences";
import type {
  Citation,
  MeetingBriefItem,
  MeetingBriefPreparation,
  MeetingSummaryItem,
  NoteEvent,
} from "../api";
import type { WindowedPassage } from "../documents/search";
import { TranslatableError } from "../errors";
import type { createEventHub } from "../events";
import { type BriefSource, briefQuestionsPrompt, readBriefQuestions } from "./briefQuestions";

export interface BriefContext {
  event: NoteEvent & { eventId: string };
  route: MeetingBriefPreparation["route"];
  documents: { id: string; title: string; contentHash: string; invited: boolean }[];
  prior: {
    id: string;
    documentId: string;
    title: string;
    contentHash: string;
    items: readonly MeetingSummaryItem[];
  }[];
  language: string;
}

interface Options {
  events: Pick<ReturnType<typeof createEventHub>, "on">;
  lifetime: AbortSignal;
  questionsHidden(mindId: string): boolean;
  context(mindId: string): BriefContext | null;
  history(mindId: string): Promise<MeetingBriefItem[]>;
  search(query: string, ids: string[]): WindowedPassage[];
  first(id: string): WindowedPassage[];
  passage(id: string): WindowedPassage | null;
  cite(passageId: string, quote: string): Citation | null;
  generate(
    mindId: string,
    route: NonNullable<BriefContext["route"]>,
    packet: ReturnType<typeof briefQuestionsPrompt>,
    check: () => void,
    signal: AbortSignal,
  ): Promise<string>;
}

const changed = () => new TranslatableError({ key: "error.meeting.briefChanged" });

export function createBriefPreparation(options: Options) {
  const recent = new Map<string, { stamp: string; result: MeetingBriefPreparation }>();
  const running = new Map<
    string,
    { route: string | null; result: Promise<MeetingBriefPreparation> }
  >();
  const stamp = (ctx: BriefContext) =>
    JSON.stringify([ctx.event, ctx.language, ctx.route, ctx.documents, ctx.prior]);
  const empty = (ctx: BriefContext | null): MeetingBriefPreparation => ({
    route: ctx?.route ?? null,
    invitation: [],
    questions: [],
    prepared: false,
  });
  function read(mindId: string) {
    const saved = recent.get(mindId);
    const ctx = options.context(mindId);
    if (saved && ctx && stamp(ctx) === saved.stamp)
      return options.questionsHidden(mindId) ? { ...saved.result, questions: [] } : saved.result;
    recent.delete(mindId);
    return ctx && (ctx.documents.length || ctx.prior.length) ? empty(ctx) : null;
  }
  async function prepare(mindId: string, expected: string | null) {
    const ctx = options.context(mindId);
    if (!ctx || (ctx.route?.id ?? null) !== expected) throw changed();
    const original = stamp(ctx);
    const hidden = options.questionsHidden(mindId);
    const check = () => {
      const latest = options.context(mindId);
      if (!latest || stamp(latest) !== original || options.questionsHidden(mindId) !== hidden)
        throw changed();
    };
    const stopped = new AbortController();
    const signal = AbortSignal.any([options.lifetime, stopped.signal]);
    const unsubscribe = meetingBriefEvents.map((event) =>
      options.events.on(event, () => {
        try {
          check();
        } catch (error) {
          stopped.abort(error);
        }
      }),
    );
    try {
      const allowedPrior = new Set(ctx.prior.map((call) => call.documentId));
      const history = (await options.history(mindId)).filter((row) =>
        allowedPrior.has(row.citation.documentId),
      );
      const all = [
        ...ctx.documents,
        ...ctx.prior.map((row) => ({
          id: row.documentId,
          title: row.title,
          contentHash: row.contentHash,
          invited: false,
        })),
      ];
      const ids = all.map((d) => d.id);
      const byId = new Map(all.map((doc) => [doc.id, doc]));
      const query = [ctx.event.title, ...history.map((item) => item.text)].join("\n");
      const best = ids.length ? options.search(query, ids) : [];
      const first = [
        ...all.filter((doc) => doc.invited),
        ...all.filter((doc) => !doc.invited).slice(0, 20),
      ].map((doc) => ({ doc, passage: options.first(doc.id)[0] }));
      check();
      const invitedCitations = first.flatMap(({ doc, passage }) => {
        if (!doc.invited || !passage || doc.contentHash !== passage.contentHash) return [];
        const sentence = sentenceSpans(passage.text)[0];
        const quote = sentence ? passage.text.slice(sentence.from, sentence.to) : passage.text;
        const citation = options.cite(passage.passageId, quote);
        return citation?.check === "found" && citation.contentHash === doc.contentHash
          ? [citation]
          : [];
      });
      const sources: BriefSource[] = [];
      const seen = new Set<string>();
      const add = (source: BriefSource) => {
        if (!source.text.trim() || seen.has(source.passageId) || sources.length >= 20) return;
        seen.add(source.passageId);
        sources.push(source);
      };
      const priorPassages = history.flatMap((row) => {
        const passage = options.passage(row.citation.passageId);
        return passage &&
          passage.documentId === row.citation.documentId &&
          passage.contentHash === row.citation.contentHash
          ? [passage]
          : [];
      });
      for (const passage of [
        ...priorPassages,
        ...best,
        ...first.flatMap((row) => (row.passage ? [row.passage] : [])),
      ]) {
        const doc = byId.get(passage.documentId);
        if (!doc || doc.contentHash !== passage.contentHash) continue;
        add({
          documentId: doc.id,
          passageId: passage.passageId,
          contentHash: doc.contentHash,
          title: doc.title,
          text: passage.text,
        });
      }
      let questions: MeetingBriefPreparation["questions"] = [];
      if (!hidden && ctx.route && sources.length) {
        const packet = briefQuestionsPrompt(
          ctx.language,
          ctx.event.title,
          history.map((row) => row.citation.quote),
          sources,
        );
        const reply = await options.generate(mindId, ctx.route, packet, check, signal);
        check();
        signal.throwIfAborted();
        questions = readBriefQuestions(reply, sources, (source, quote) =>
          options.cite(source.passageId, quote),
        );
      }
      check();
      const result = { route: ctx.route, invitation: invitedCitations, questions, prepared: true };
      recent.set(mindId, { stamp: original, result });
      return result;
    } finally {
      for (const off of unsubscribe) off();
    }
  }
  return {
    read,
    prepare(mindId: string, route: string | null) {
      const existing = read(mindId);
      if (existing?.prepared && (existing.route?.id ?? null) === route)
        return Promise.resolve(existing);
      const pending = running.get(mindId);
      if (pending) return pending.route === route ? pending.result : Promise.reject(changed());
      const result = prepare(mindId, route).finally(() => running.delete(mindId));
      running.set(mindId, { route, result });
      return result;
    },
    clear(mindId: string) {
      recent.delete(mindId);
    },
  };
}
