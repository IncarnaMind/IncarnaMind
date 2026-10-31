/**
 * Starts the agents hosted Runs talk to (#353), for the core's
 * `AgentProcesses`: through the login shell's `ProcessLauncher`, so an agent
 * installed with npm, Homebrew or a shell profile is found as a terminal finds
 * it, and a `.cmd` shim runs on Windows. Each leads its own process group, so
 * Stop and quitting end every process it started.
 *
 * No Electron imports: tests run this in Node.
 */
import { type Readable, Writable } from "node:stream";
import type { AgentProcess, AgentProcesses, ProcessLauncher } from "../core";
import { stopProcessTree } from "../core/execution";

/** How much of an agent's error output is kept, for the line that says why it stopped. */
const STDERR_TAIL_CHARS = 2000;

/** How long an agent gets to exit once its input closes, before it is stopped. */
const EXIT_GRACE_MS = 2000;

/** A Node stream as a web stream, read only as fast as the reader takes it. */
function webReadable(stream: Readable): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Buffer> = stream[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}

export function createAgentProcesses(processes: ProcessLauncher): AgentProcesses {
  return {
    async start(program): Promise<AgentProcess> {
      const child = await processes.spawn(program.command, program.args, {
        cwd: program.cwd,
        env: program.env,
        processGroup: true,
      });
      const { stdin, stdout, stderr } = child;
      if (!stdin || !stdout || !stderr) {
        stopProcessTree(child);
        throw new Error(`${program.command} started without its standard streams.`);
      }
      let tail = "";
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => {
        tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
      });
      // A write after the agent exited fails here; the session sees the exit instead.
      stdin.on("error", () => undefined);
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        // "close", not "exit": its output has been read to the end by then, its errors too.
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      return {
        input: Writable.toWeb(stdin),
        output: webReadable(stdout),
        exited,
        stderrTail: () => tail,
        async stop() {
          stdin.end();
          const exitedInTime = await Promise.race([
            exited.then(() => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), EXIT_GRACE_MS)),
          ]);
          if (!exitedInTime) stopProcessTree(child);
          await exited;
        },
      };
    },
  };
}
