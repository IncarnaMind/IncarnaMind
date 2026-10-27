import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "../src/core/errors";
import { lifecycleHomeEnv } from "./lifecycle";

export interface OwnerFileHolder {
  pid: number;
  release(): Promise<void>;
}

export async function holdOwnerFile(file: string, log: string): Promise<OwnerFileHolder> {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$file = $env:INCARNAMIND_TEST_OWNER_FILE
$log = $env:INCARNAMIND_TEST_OWNER_HOLDER_LOG
function Write-Event($value) {
  $json = $value | ConvertTo-Json -Compress
  [System.IO.File]::AppendAllText($log, $json + [System.Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
$stream = $null
$started = $null
try {
  $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $started = [System.DateTimeOffset]::UtcNow
  Write-Event(@{ event = 'holding'; pid = $PID; at = $started.ToString('o'); file = $file; share = 'Read'; deleteShared = $false })
  if ([Console]::In.ReadLine() -ne 'release') { throw 'The owner-file holder closed without being released.' }
} finally {
  if ($stream) {
    $stream.Dispose()
    $ended = [System.DateTimeOffset]::UtcNow
    Write-Event(@{ event = 'released'; pid = $PID; at = $ended.ToString('o'); file = $file; heldMs = [long]($ended - $started).TotalMilliseconds })
  }
}
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: {
      ...process.env,
      ...lifecycleHomeEnv(dirname(log)),
      INCARNAMIND_TEST_OWNER_FILE: file,
      INCARNAMIND_TEST_OWNER_HOLDER_LOG: log,
    },
    windowsHide: true,
    stdio: "pipe",
  });
  const errors: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => errors.push(text));
  child.stdin.on("error", (error) => errors.push(String(error)));
  const closed = once(child, "close");
  const pid = await bounded(waitForHolder(child, errors), closed, child, errors, "startup");
  let released: Promise<void> | undefined;
  const release = async () => {
    child.stdin.end("release\n");
    const [code, signal] = await bounded(closed, closed, child, errors, "release");
    if (code !== 0 || signal !== null)
      throw new Error(`The owner-file holder failed: ${code}/${signal}. ${errors.join("")}`);
  };
  return { pid, release: () => (released ??= release()) };
}

async function bounded<T>(
  promise: Promise<T>,
  closed: Promise<unknown>,
  child: ChildProcessWithoutNullStreams,
  errors: string[],
  action: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The owner-file holder ${action} timed out. ${errors.join("")}`)),
      30_000,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForHolder(child: ChildProcessWithoutNullStreams, errors: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    let ready = false;
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!ready)
        reject(
          new Error(`The owner-file holder ended early: ${code}/${signal}. ${errors.join("")}`),
        );
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (ready) return;
      try {
        const value: unknown = JSON.parse(line.replace(/^\uFEFF/, ""));
        if (
          !isRecord(value) ||
          value.event !== "holding" ||
          value.pid !== child.pid ||
          value.deleteShared !== false
        )
          throw new Error("The owner-file holder did not confirm its no-delete-sharing handle.");
        ready = true;
        resolve(value.pid as number);
      } catch (error) {
        reject(error);
      }
    });
  });
}
