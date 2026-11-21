import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import type { OrganizeAgents, OrganizeTarget } from "../../../../core/api";
import { useT } from "../../i18n";
import {
  allowAndOrganize,
  askToOrganize,
  type OrganizeNeeds,
  useOrganizeAsk,
} from "../../organizeDocuments";
import { useAppStore } from "../../store";
import { useOrganizeAgents } from "../../useOrganizeAgents";
import { AskAgentLine } from "../AskAgentLine";
import { buttonStyle } from "../ui";

const report = (error: unknown) => useAppStore.getState().reportError(error);
const close = () => useOrganizeAsk.getState().close();

/**
 * What Organize asks before it runs, at the Library's top where its run is said (#1569): the first
 * time a cloud service would read the Documents, what goes there, with "Allow and organize" and
 * "Not now" (ADR-0022); with no model that can organize, how to get one. Not now sends nothing
 * and records nothing.
 */
export function OrganizeAsk() {
  const asked = useOrganizeAsk((state) => state.asked);
  if (!asked) return null;
  const { needs } = asked;
  return needs.needs === "consent" ? (
    <ConsentCard needs={needs} />
  ) : (
    <ChooseOrganizer target={asked.target} />
  );
}

function ChooseOrganizer({ target }: { target: OrganizeTarget }) {
  const choice = useOrganizeAgents(target);
  if (!choice) return null;
  return choice.connected ? (
    <AskOwnAgent agents={choice.eligible} target={target} />
  ) : (
    <NeedsModel />
  );
}

function Card({
  testId,
  labelledBy,
  children,
}: {
  testId: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  const card = useRef<HTMLElement>(null);
  // Asked from a button or ⌘K, the question takes the focus: it is read out, and Tab reaches it.
  useEffect(() => {
    if (!card.current?.contains(document.activeElement)) card.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  return (
    <section
      ref={card}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className="mt-3 flex flex-col gap-1 rounded-lg border border-rule bg-sheet px-4 py-3 text-[13px] leading-5 text-ink-secondary"
    >
      {children}
    </section>
  );
}

const NotNow = () => {
  const t = useT();
  return (
    <button
      type="button"
      data-testid="library-organize-dismiss"
      onClick={close}
      className={buttonStyle("ghost", "sm")}
    >
      {t("library.organize.dismiss")}
    </button>
  );
};

function ConsentCard({ needs }: { needs: Extract<OrganizeNeeds, { needs: "consent" }> }) {
  const t = useT();
  const title = useId();
  const service = needs.service.name;
  return (
    <Card testId="library-organize-consent" labelledBy={title}>
      <p id={title} className="font-semibold text-ink">
        {t("library.organize.consent.title", { service })}
      </p>
      <p data-testid="library-organize-sends">{t("library.organize.consent.sends", { service })}</p>
      {needs.declined && (
        <p data-testid="library-organize-declined">{t("library.organize.consent.declined")}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <NotNow />
        <button
          type="button"
          data-testid="library-organize-allow"
          onClick={() => void allowAndOrganize().catch(report)}
          className={buttonStyle("primary", "sm")}
        >
          {t("library.organize.allow")}
        </button>
      </div>
    </Card>
  );
}

function AskOwnAgent({
  agents,
  target,
}: {
  agents: OrganizeAgents["eligible"];
  target: OrganizeTarget;
}) {
  const t = useT();
  const title = useId();
  const settings = () => {
    close();
    useAppStore.getState().openSettings("agents");
  };
  return (
    <Card testId="library-organize-agent" labelledBy={title}>
      <p id={title}>{t(agents.length ? "library.organize.askAgent" : "library.organize.share")}</p>
      {agents.length > 0 ? (
        <AskAgentLine
          agents={agents}
          label={(agent) => t("library.organize.withAgent", { agent })}
          onAsk={(agent) => void askToOrganize(agent, target)}
          setUp={{ label: t("library.organize.dismiss"), onClick: close }}
          testId="library-organize-choice"
          focusAsk
        />
      ) : (
        <div className="mt-2 flex justify-end gap-2">
          <NotNow />
          <button type="button" onClick={settings} className={buttonStyle("secondary", "sm")}>
            {t("meetings.notesAgent.settings")}
          </button>
        </div>
      )}
    </Card>
  );
}

function NeedsModel() {
  const t = useT();
  const title = useId();
  return (
    <Card testId="library-organize-needs-model" labelledBy={title}>
      <p id={title} className="font-semibold text-ink">
        {t("library.organize.needsModel")}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <NotNow />
        <button
          type="button"
          data-testid="library-organize-set-up"
          onClick={() => {
            close();
            useAppStore.getState().openSettings("ai", "tagging");
          }}
          className={buttonStyle("secondary", "sm")}
        >
          {t("library.organize.setUp")}
        </button>
      </div>
    </Card>
  );
}
