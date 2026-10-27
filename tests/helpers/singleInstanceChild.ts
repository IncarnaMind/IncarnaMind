import { isRecord } from "../../src/core/errors";
import { acquireInstance } from "../../src/main/singleInstance";

const [mode, folder, wait = "10000", recoveryId] = process.argv.slice(2);
if (!folder) throw new Error("A temporary data folder is required.");
if (process.env.INCARNAMIND_DATA_DIR !== folder) {
  throw new Error(
    `INCARNAMIND_DATA_DIR must be this child's own temporary data folder (${folder}), not ${process.env.INCARNAMIND_DATA_DIR ?? "unset"}.`,
  );
}
if (mode === "wait-recovery") console.log(JSON.stringify({ kind: "starting" }));
const instance = acquireInstance(
  folder,
  { args: ["synthetic-app", "--open=synthetic"], cwd: process.cwd() },
  (what, error) => {
    console.error(what, error);
    console.log(
      JSON.stringify({
        kind: "reported",
        what,
        error: error instanceof Error ? error.message : String(error),
        ...(isRecord(error) && typeof error.code === "string" && { code: error.code }),
      }),
    );
  },
  { waitMs: Number(wait), recoveryId },
);
console.log(
  JSON.stringify(
    instance.kind === "owner"
      ? {
          kind: instance.kind,
          identity: instance.owner.identity,
          previousOwner: instance.owner.previousOwner,
        }
      : instance,
  ),
);
if (instance.kind === "owner" && mode !== "take") {
  const ready = () => {
    instance.owner.ready((input) => {
      console.log(JSON.stringify({ kind: "received", input }));
      return true;
    });
    console.log(JSON.stringify({ kind: "ready" }));
  };
  if (mode !== "starting") ready();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (input: string) => {
    if (input.trim() === "quitting") {
      instance.owner.quitting();
      console.log(JSON.stringify({ kind: "quitting" }));
    } else if (input.trim() === "ready") ready();
    else if (input.trim() === "exit") process.exit(0);
  });
}
