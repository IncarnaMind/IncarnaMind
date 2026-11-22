import { useCallback, useEffect, useRef, useState } from "react";
import type { Citation, MeetingBriefItem, MeetingBriefPreparation } from "../../../../core/api";
import { formatLocation } from "../../../../shared/locations";
import { meetingBriefEvents } from "../../../../shared/meetingBrief";
import { core } from "../../core";
import { useT } from "../../i18n";
import { openCited } from "../../openCited";
import { useAppStore } from "../../store";
import { useTabPlace } from "../tabs/tabItems";
import { buttonStyle } from "../ui";

export function MeetingBrief({ mindId }: { mindId: string }) {
  const t = useT();
  const place = useTabPlace();
  const report = useAppStore((s) => s.reportError);
  const [view, setView] = useState<{
    history: MeetingBriefItem[];
    preparation: MeetingBriefPreparation;
  } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    setView(null);
    void Promise.all([core.getMeetingBriefHistory(mindId), core.getMeetingBriefPreparation(mindId)])
      .then(([history, preparation]) => {
        if (current === sequence.current) setView(preparation ? { history, preparation } : null);
      })
      .catch((error: unknown) => {
        if (current === sequence.current) report(error);
      });
  }, [mindId, report]);
  useEffect(() => {
    refresh();
    const subscriptions = meetingBriefEvents.map((event) => core.on(event, refresh));
    return () => {
      sequence.current++;
      for (const off of subscriptions) off();
    };
  }, [refresh]);
  if (!view) return null;
  const { history, preparation } = view;
  async function choose(action: "prepare" | "keep" | "dismiss", section?: "questions") {
    setSaving(true);
    try {
      if (action === "prepare")
        await core.prepareMeetingBrief(mindId, preparation.route?.id ?? null);
      else if (action === "keep") await core.keepMeetingBrief(mindId, section);
      else await core.dismissMeetingBrief(mindId, section);
      refresh();
    } catch (e) {
      report(e);
    } finally {
      setSaving(false);
    }
  }
  const source = (c: Citation, title: string) => (
    <button
      type="button"
      onClick={() =>
        openCited(c, { origin: "note", check: c.check, withQuote: true, from: place?.groupId })
      }
      className="text-accent hover:underline"
    >
      {title}
      {c.location && <> · {formatLocation(c.location, t)}</>}
    </button>
  );
  const any = !!(history.length || preparation.questions.length || preparation.invitation.length);
  const prepare =
    !preparation.prepared &&
    (expanded ? (
      <div className="space-y-1">
        <p className="text-ink-secondary">
          {preparation.route?.external
            ? t(
                preparation.route.client
                  ? "meetings.brief.clientDisclosure"
                  : "meetings.brief.disclosure",
                {
                  service: preparation.route.label,
                },
              )
            : t("meetings.brief.localDisclosure")}
        </p>
        <button
          type="button"
          disabled={saving}
          onClick={() => void choose("prepare")}
          className={buttonStyle("secondary", "sm")}
        >
          {saving
            ? t("meetings.brief.sending")
            : preparation.route
              ? t("meetings.brief.prepare", { service: preparation.route.label })
              : t("meetings.brief.readInvite")}
        </button>
      </div>
    ) : (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        className="text-accent hover:underline"
      >
        {t("meetings.brief.title")}
      </button>
    ));
  if (!any)
    return (
      <div className="my-1 text-[13px]">
        {preparation.prepared ? (
          <span role="status">
            {t(preparation.route ? "meetings.brief.nothing" : "meetings.brief.chooseModel")}
          </span>
        ) : (
          prepare
        )}
      </div>
    );
  return (
    <section
      data-testid="meeting-brief"
      aria-label={t("meetings.brief.title")}
      className="mt-2 space-y-2 rounded-md bg-hover px-3 py-2 text-[13px] text-ink"
    >
      <div className="flex justify-end">
        <button
          type="button"
          aria-label={t("meetings.brief.dismiss")}
          disabled={saving}
          onClick={() => void choose("dismiss")}
        >
          ×
        </button>
      </div>
      {!!history.length && (
        <div>
          <h2 className="font-semibold">{t("meetings.brief.lastTime")}</h2>
          <ul className="list-disc pl-4">
            {history.map((row) => (
              <li key={`${row.meetingId}:${row.itemId}`}>
                {row.text} {source(row.citation, row.title)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!preparation.invitation.length && (
        <div>
          <h2 className="font-semibold">{t("meetings.brief.inInvite")}</h2>
          <ul className="list-disc pl-4">
            {preparation.invitation.map((c) => (
              <li key={c.documentId}>{source(c, c.documentName)}</li>
            ))}
          </ul>
        </div>
      )}
      {!!preparation.questions.length && (
        <div data-testid="meeting-brief-questions">
          <h2 className="font-semibold">{t("meetings.brief.questions")}</h2>
          <ol className="list-decimal space-y-1 pl-4">
            {preparation.questions.map(({ question, citation }) => (
              <li key={question}>
                <p>{question}</p>
                {citation ? (
                  <p>
                    {citation.quote} {source(citation, citation.documentName)}
                  </p>
                ) : (
                  <p className="text-ink-secondary">{t("meetings.brief.noAnswer")}</p>
                )}
              </li>
            ))}
          </ol>
          <div className="mt-1 flex gap-3">
            <button
              type="button"
              disabled={saving}
              onClick={() => void choose("keep", "questions")}
              className="text-accent hover:underline"
            >
              {t("meetings.brief.keepQuestions")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void choose("dismiss", "questions")}
              className="text-ink-secondary hover:underline"
            >
              {t("meetings.brief.dismissQuestions")}
            </button>
          </div>
        </div>
      )}
      {prepare}
      <button
        type="button"
        disabled={saving}
        onClick={() => void choose("keep")}
        className="text-accent hover:underline"
      >
        {t("meetings.brief.keep")}
      </button>
    </section>
  );
}
