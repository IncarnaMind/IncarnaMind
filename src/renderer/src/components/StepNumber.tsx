import { CheckMarkIcon } from "../editor/icons";

export type StepState = "open" | "later" | "done";

export function StepNumber({ number, state }: { number: number; state: StepState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden="true"
        className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-success text-white"
      >
        <CheckMarkIcon check="found" className="size-2.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-bold ${
        state === "open" ? "bg-ink text-white" : "border-[1.5px] border-tab-divider text-ink-meta"
      }`}
    >
      {number}
    </span>
  );
}

export const STEP_BUTTON_CLASS =
  "group -mx-1.5 -my-0.5 flex min-w-0 gap-2.5 rounded-md px-1.5 py-0.5 text-left hover:bg-chip";
