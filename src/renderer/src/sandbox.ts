import { useEffect, useState } from "react";
import { LINUX_SANDBOX_HELP_URL } from "../../shared/analysis";
import { files } from "./core";

let asked: Promise<boolean> | null = null;

/** Whether the app runs with Chromium's sandbox off, asked of the main process once per window. */
export function useRunsWithoutSandbox(): boolean {
  const [off, setOff] = useState(false);
  useEffect(() => {
    asked ??= files.runsWithoutSandbox().catch(() => false);
    let current = true;
    void asked.then((answer) => {
      if (current) setOff(answer);
    });
    return () => {
      current = false;
    };
  }, []);
  return off;
}

/** Opens the page that says how to turn the sandbox back on, in the User's browser. */
export function openSandboxHelp(): void {
  window.open(LINUX_SANDBOX_HELP_URL, "_blank", "noreferrer");
}

/** Opens the same page at how to let code run in its sandbox, on Linux (ADR-0025). */
export function openCodeSandboxHelp(): void {
  window.open(
    `${LINUX_SANDBOX_HELP_URL}#code-on-whole-files-and-skill-scripts`,
    "_blank",
    "noreferrer",
  );
}
