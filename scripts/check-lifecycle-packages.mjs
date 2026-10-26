import { extractFile } from "@electron/asar";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [oldApp, updatedApp, ...extra] = process.argv.slice(2);
if (!oldApp || !updatedApp || extra.length)
  throw new Error("Pass the old and updated lifecycle app.asar paths.");
const versions = JSON.parse(
  await readFile(new URL("../tests/fixtures/lifecycle-versions.json", import.meta.url), "utf8"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mainHash = hash(await readFile(new URL("../out/main/index.js", import.meta.url)));
const entryHash = hash(await readFile(new URL("../e2e/lifecycleMain.cjs", import.meta.url)));
const records = [];
for (const [name, archive, version] of [
  ["old", oldApp, versions.old],
  ["updated", updatedApp, versions.updated],
]) {
  const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  if (metadata.version !== version || metadata.main !== "./out/main/lifecycle.cjs")
    throw new Error(`The ${name} lifecycle package has the wrong version or entry.`);
  if (hash(extractFile(archive, "out/main/index.js")) !== mainHash)
    throw new Error(`The ${name} lifecycle package changed the built main.`);
  if (hash(extractFile(archive, "out/main/lifecycle.cjs")) !== entryHash)
    throw new Error(`The ${name} lifecycle package changed the test entry.`);
  records.push({ name, version, mainHash, entryHash });
}
console.log(JSON.stringify(records));
