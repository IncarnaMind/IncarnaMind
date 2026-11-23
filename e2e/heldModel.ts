import type { ElectronApplication } from "@playwright/test";

interface SlowCheck {
  holdCite: boolean;
  holdAsked: boolean;
  holdCellFinish: boolean;
  waiting: unknown[];
  release(): void;
}

export async function holdModel(
  app: ElectronApplication,
  which: "holdCite" | "holdAsked" | "holdCellFinish",
  hold: boolean,
): Promise<void> {
  await app.evaluate(
    (_electron, { which, hold }) => {
      const slow = (globalThis as unknown as { incarnamindSlowCheck: SlowCheck })
        .incarnamindSlowCheck;
      slow[which] = hold;
      if (!hold) slow.release();
    },
    { which, hold },
  );
}

/** Whether a request of the scripted model is held now. */
export const modelHeld = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as { incarnamindSlowCheck: SlowCheck }).incarnamindSlowCheck.waiting
        .length > 0,
  );
