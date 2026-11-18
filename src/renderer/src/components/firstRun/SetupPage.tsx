import { useState } from "react";
import appIcon from "../../../../../build/icon/png/128x128.png";
import type { WorkKind } from "../../../../core/api";
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

const FIRST_RUN: readonly SetupStep[] = ["work", "ai", "sorting", "meetings"];
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
  /** The first step's order, and whether this install sent its picks: absent without that step. */
  first?: { workOrder: readonly WorkKind[]; picksSent: boolean };
  onEnd(work: readonly WorkKind[]): void;
  close?(): void;
}) {
  const [at, setAt] = useState(0);
  const [work, setWork] = useState<WorkKind[]>([]);
  const [sent, setSent] = useState(first?.picksSent === true);
  const [ending, setEnding] = useState(false);
  const place: StepPlace = {
    steps,
    at,
    next: () => {
      if (at + 1 < steps.length) {
        setAt(at + 1);
        return;
      }
      if (ending) return;
      setEnding(true);
      onEnd(work);
    },
    ...(at > 0 && { back: () => setAt(at - 1) }),
    ...(close && { close }),
  };
  const step = steps[at];
  if (step === "work" && first) {
    return (
      <WorkStep
        place={place}
        order={first.workOrder}
        work={work}
        onWork={setWork}
        sent={sent}
        onSent={() => setSent(true)}
      />
    );
  }
  if (step === "ai") return <AiStep place={place} />;
  if (step === "sorting") return <SortingStep place={place} />;
  return <TranscriptionStep place={place} />;
}

/**
 * The first run's setup (#3296), the window's only page while it shows: what the User works on,
 * then their AI, sorting and meeting transcription, one short step each, every one skippable.
 * The dialogs a step can raise (a consent, a local model's download, a problem) draw over it as
 * they do over the app.
 */
export function SetupPage({ workOrder, picksSent }: { workOrder: WorkKind[]; picksSent: boolean }) {
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
          first={{ workOrder, picksSent }}
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
