import { useAppStore } from "../../store";
import { dialogFrameClass } from "../ui";
import { useModal } from "../useModal";
import { MODEL_STEPS, SetupSteps } from "./SetupPage";

/**
 * The setup's model steps again (#3296), from Settings › AI or ⌘K: a dialog over the app, which
 * keeps its state. Esc and ✕ close it, and the focus goes back to where it was opened from.
 */
export function SetupDialog() {
  const open = useAppStore((state) => state.setup?.from === "ai");
  const close = useAppStore((state) => state.closeSetup);
  const dialog = useModal(open);
  return (
    <dialog
      ref={dialog}
      onClose={close}
      data-testid="setup-dialog"
      aria-labelledby="setup-title"
      className={`${dialogFrameClass} max-h-[calc(100vh-48px)] w-[min(640px,calc(100vw-48px))] max-w-none overflow-y-auto`}
    >
      {open && <SetupSteps steps={MODEL_STEPS} onEnd={close} close={close} />}
    </dialog>
  );
}
