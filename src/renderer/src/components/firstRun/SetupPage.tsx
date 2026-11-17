import { useState } from "react";
import type { WorkKind } from "../../../../core/api";
import { type AppState, useAppStore } from "../../store";
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
const MODELS: readonly SetupStep[] = ["ai", "sorting", "meetings"];

/**
 * The first run's setup (#3296), the window's only page while it shows: what the User works on,
 * then their AI, sorting and meeting transcription, one short step each, every one skippable.
 * Opened again from Settings › AI, it shows the three model steps. The dialogs a step can raise
 * (a consent, a local model's download, a problem) draw over it as they do over the app.
 */
export function SetupPage({ setup }: { setup: NonNullable<AppState["setup"]> }) {
  const finishSetup = useAppStore((state) => state.finishSetup);
  const steps = setup.from === "work" ? FIRST_RUN : MODELS;
  const [at, setAt] = useState(0);
  const [work, setWork] = useState<WorkKind[]>([]);
  const [finishing, setFinishing] = useState(false);
  const place: StepPlace = {
    steps,
    at,
    next: () => {
      if (at + 1 < steps.length) {
        setAt(at + 1);
        return;
      }
      if (finishing) return;
      setFinishing(true);
      void finishSetup(work);
    },
    ...(at > 0 && { back: () => setAt(at - 1) }),
  };
  const step = steps[at];
  return (
    <div
      data-testid="first-run-setup"
      data-from={setup.from}
      className="relative flex h-screen flex-col overflow-y-auto bg-frame"
    >
      {/* The window's top moves it, as the app's band does. */}
      <div aria-hidden="true" className="title-bar absolute inset-x-0 top-0 h-11" />
      <main className="flex flex-1 items-start justify-center px-4 pt-11 pb-10">
        {step === "work" && setup.from === "work" ? (
          <WorkStep place={place} order={setup.workOrder} work={work} onWork={setWork} />
        ) : step === "ai" ? (
          <AiStep place={place} />
        ) : step === "sorting" ? (
          <SortingStep place={place} />
        ) : (
          <TranscriptionStep place={place} />
        )}
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
