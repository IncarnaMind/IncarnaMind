import { acquireInstance } from "../../src/main/singleInstance";

const [mode, folder, wait = "10000"] = process.argv.slice(2);
if (!folder) throw new Error("A temporary data folder is required.");
const instance = acquireInstance(
  folder,
  { args: ["synthetic-app", "--open=synthetic"], cwd: process.cwd() },
  (what, error) => console.error(what, error),
  { waitMs: Number(wait) },
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
  const ready = () =>
    instance.owner.ready((input) => {
      console.log(JSON.stringify({ kind: "received", input }));
      return true;
    });
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
