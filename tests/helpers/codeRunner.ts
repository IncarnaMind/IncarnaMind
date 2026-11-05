import type { Executor } from "../../src/core/adapters";
import { createLocalExecutor } from "../../src/core/execution";
import { createProcessLauncher } from "../../src/main/processes";
import { createMeters } from "../../src/main/programMeter";
import { createTempDataFolder } from "./core";

/**
 * Runs code on this computer and only says it is at `level`: what the OS sandbox keeps code
 * from is tested against the real one (tests/main/runCode.test.ts).
 */
export async function localExecutorAt(level: "os" | "none" = "os"): Promise<Executor> {
  const meters = createMeters();
  const local = createLocalExecutor({
    processes: createProcessLauncher(async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" })),
    tempDir: await createTempDataFolder(),
    reportError: (error) => {
      throw error;
    },
    confinement: {
      level: "os",
      confine: async ({ command, args, env }) => ({ command, args, env, meter: meters.meter() }),
      release: () => {},
    },
  });
  return { level, run: (request) => local.run(request) };
}
