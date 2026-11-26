import { useRef, useState } from "react";
import appIcon from "../../../../../build/icon/png/128x128.png";
import type { FirstRunStep, WorkKind } from "../../../../core/api";
import { useAgentClients, useAgentPairings } from "../../agentNote";
import { core } from "../../core";
import { useAppStore } from "../../store";
import { ConsentDialog } from "../ConsentDialog";
import { ErrorNotices } from "../ErrorNotices";
import { PanelBoundary } from "../PanelBoundary";
import { ChatGptWelcomeDialog } from "../providers/ChatGptSignIn";
import { RequestedDialogs } from "../RequestedDialogs";
import { AiStep } from "./AiStep";
import type { SetupStep, StepPlace } from "./SetupPanel";
import { SortingStep } from "./SortingStep";
import { TranscriptionStep } from "./TranscriptionStep";
import { WorkStep } from "./WorkStep";
import { YourAiStep } from "./YourAiStep";

const FIRST_RUN: readonly SetupStep[] = ["work", "ai", "meetings"];
export const MODEL_STEPS: readonly SetupStep[] = ["ai", "sorting", "meetings"];

/**
 * The setup's steps one at a time (#3296). `onEnd` follows the last step's press or skip, with
 * the picks of the first step where it is shown; `close`, where the steps can be put away.
 */
export function SetupSteps({
  steps,
  first,
  onEnd,
  close,
}: {
  steps: readonly SetupStep[];
  /** The first step's order, whether this install sent its picks, and any kept progress (#3819). */
  first?: {
    workOrder: readonly WorkKind[];
    picksSent: boolean;
    step: FirstRunStep;
    work: readonly WorkKind[];
  };
  onEnd(work: readonly WorkKind[]): void;
  close?(): void;
}) {
  const initialIndex = first ? Math.max(0, steps.indexOf(first.step)) : 0;
  const [at, setAt] = useState(initialIndex);
  const [work, setWork] = useState<WorkKind[]>(() => [...(first?.work ?? [])]);
  const workRef = useRef<WorkKind[]>(work);
  workRef.current = work;
  const [sent, setSent] = useState(first?.picksSent === true);
  const [ending, setEnding] = useState(false);
  // Read on the first step shown, so Your AI has its agents as it opens.
  useAgentClients();
  useAgentPairings();
  const persist = (nextAt: number, nextWork: readonly WorkKind[]) => {
    if (!first) return;
    const step = steps[nextAt];
    if (step === "work" || step === "ai" || step === "meetings") {
      core
        .saveFirstRunProgress({ step, work: nextWork })
        .catch((error: unknown) => console.error("Couldn't keep first-run setup progress.", error));
    }
  };
  const updateWork = (nextWork: WorkKind[]) => {
    workRef.current = nextWork;
    setWork(nextWork);
    persist(at, nextWork);
  };
  const place: StepPlace = {
    steps,
    at,
    next: () => {
      if (at + 1 < steps.length) {
        const nextAt = at + 1;
        setAt(nextAt);
        persist(nextAt, workRef.current);
        return;
      }
      if (ending) return;
      setEnding(true);
      onEnd(workRef.current);
    },
    ...(at > 0 && {
      back: () => {
        const prevAt = at - 1;
        setAt(prevAt);
        persist(prevAt, workRef.current);
      },
    }),
    ...(close && { close }),
  };
  const step = steps[at];
  if (step === "work" && first) {
    return (
      <WorkStep
        place={place}
        order={first.workOrder}
        work={work}
        onWork={updateWork}
        sent={sent}
        onSent={() => setSent(true)}
      />
    );
  }
  if (step === "ai") return first ? <YourAiStep place={place} /> : <AiStep place={place} />;
  if (step === "sorting") return <SortingStep place={place} />;
  return <TranscriptionStep place={place} />;
}

/**
 * The first run's setup (#3296), the window's only page while it shows: what the User works on,
 * then their AI and meeting transcription, one short step each, every one skippable.
 * The dialogs a step can raise (a consent, a local model's download, a problem) draw over it as
 * they do over the app.
 */
export function SetupPage({
  workOrder,
  picksSent,
  initialStep,
  initialWork,
}: {
  workOrder: WorkKind[];
  picksSent: boolean;
  initialStep: FirstRunStep;
  initialWork: WorkKind[];
}) {
  const finishSetup = useAppStore((state) => state.finishSetup);
  return (
    <div
      data-testid="first-run-setup"
      className="relative flex h-screen flex-col overflow-y-auto bg-frame"
    >
      {/* The window's top moves it, as the app's band does. */}
      <div aria-hidden="true" className="title-bar absolute inset-x-0 top-0 h-11" />
      <main className="flex flex-1 flex-col items-center gap-6 px-4 pt-[clamp(3rem,9vh,6.5rem)] pb-10">
        <p className="flex items-center gap-2.5 text-[15px] leading-6 font-semibold text-ink">
          <img src={appIcon} alt="" className="size-9" />
          IncarnaMind
        </p>
        <SetupSteps
          steps={FIRST_RUN}
          first={{ workOrder, picksSent, step: initialStep, work: initialWork }}
          onEnd={(work) => void finishSetup(work)}
        />
      </main>
      <PanelBoundary name="overlays">
        <RequestedDialogs />
        <ChatGptWelcomeDialog />
        <ConsentDialog />
      </PanelBoundary>
      <ErrorNotices />
    </div>
  );
}
