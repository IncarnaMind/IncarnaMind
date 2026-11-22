import type { AgentToolName } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { useT } from "../../i18n";
import type { NoteAsk } from "../../ownAiInNote";
import { ProblemLine } from "../ProblemLine";

/** What the label says of each Tool the agent calls, with the Tool's summary as `{summary}`. */
const DOING: Partial<Record<AgentToolName, MessageKey>> = {
  read_mind: "noteAsk.doing.read_mind",
  list_minds: "noteAsk.doing.list_minds",
  search: "noteAsk.doing.search",
  read_passages: "noteAsk.doing.read_passages",
  cite: "noteAsk.doing.cite",
  check_citations: "noteAsk.doing.cite",
  propose_changes: "noteAsk.doing.propose_changes",
  create_mind: "noteAsk.doing.create_mind",
  run_analysis: "noteAsk.doing.run_analysis",
  calculate: "noteAsk.doing.run_analysis",
  publish_canvas: "noteAsk.doing.publish_canvas",
  update_canvas: "noteAsk.doing.publish_canvas",
};

/**
 * The label above a Note's input: that the AI is working, then what it is doing in plain words,
 * then one line on what it did, or why it didn't. An answer that changed nothing, such as an
 * explanation, shows whole, where the User asked.
 */
export function NoteAskLabel({ ask }: { ask: NoteAsk }) {
  const t = useT();
  if (ask.state === "working") {
    const key = ask.doing ? DOING[ask.doing.tool] : undefined;
    return (
      <p
        data-testid="note-ask-line"
        data-state="working"
        aria-live="polite"
        className="note-ask-line"
      >
        {key && ask.doing
          ? t(key, { summary: ask.doing.summary, agent: ask.agent })
          : t("noteAsk.working", { agent: ask.agent })}
      </p>
    );
  }
  if (ask.state === "failed") {
    return (
      <ProblemLine testId="note-ask-line" className="note-ask-line">
        {t(`noteAsk.problem.${ask.problem ?? "failed"}` as MessageKey, {
          agent: ask.agent,
          found: ask.versions?.found ?? "",
          lowest: ask.versions?.lowest ?? "",
        })}
      </ProblemLine>
    );
  }
  if (ask.state === "stopped") {
    return (
      <p data-testid="note-ask-line" data-state="stopped" className="note-ask-line">
        {t("noteAsk.stopped")}
      </p>
    );
  }
  const did = [
    ...(ask.fresh ? [t("noteAsk.fresh")] : []),
    ...(ask.changed > 0
      ? [
          t(ask.changed === 1 ? "noteAsk.done.changed.one" : "noteAsk.done.changed.other", {
            count: ask.changed,
          }),
        ]
      : []),
    ...ask.waiting.map((each) =>
      t(each.count === 1 ? "noteAsk.done.waiting.one" : "noteAsk.done.waiting.other", {
        count: each.count,
        title: each.title,
      }),
    ),
    ...ask.made.map((each) => t("noteAsk.done.wrote", { title: each.title })),
  ];
  const changedNothing = ask.changed === 0 && ask.waiting.length === 0 && ask.made.length === 0;
  if (changedNothing && ask.reply !== "") {
    return (
      <div data-testid="note-ask-line" data-state="landed" className="note-ask-reply-card">
        {did.length > 0 && <p className="note-ask-line">{did.join(" ")}</p>}
        <p className="note-ask-answer">{ask.reply}</p>
      </div>
    );
  }
  return (
    <p data-testid="note-ask-line" data-state="landed" className="note-ask-line">
      {did.length > 0 ? did.join(" ") : t("noteAsk.done.nothing", { agent: ask.agent })}
    </p>
  );
}
