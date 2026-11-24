/**
 * Whether a process with this id is running. Only ESRCH says none is: EPERM is one that runs under
 * another account, and any other error is the probe's own.
 */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
