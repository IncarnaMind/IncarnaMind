import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

const [controlPath, expectedSha, reportPath, ...extra] = process.argv.slice(2);
if (!controlPath || !/^[a-f0-9]{40}$/i.test(expectedSha ?? "") || !reportPath || extra.length)
  throw new Error("Pass the control checkout, exact base SHA and report directory.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const control = resolve(controlPath);
const git = (folder, args) =>
  execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
const controlSha = git(control, ["rev-parse", "HEAD"]);
if (controlSha !== expectedSha || git(control, ["status", "--porcelain", "--untracked-files=no"]))
  throw new Error("The control must be the exact base SHA with unchanged tracked files.");

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bootstrapHash = hash(await readFile(join(root, "e2e", "lifecycleMain.cjs")));
const nodePin = (await readFile(join(root, ".nvmrc"), "utf8")).trim();
if ((await readFile(join(control, ".nvmrc"), "utf8")).trim() !== nodePin)
  throw new Error("The control and pull request must select the same host Node version.");
const branchPackage = await json(join(root, "package.json"));
const controlPackage = await json(join(control, "package.json"));
if (branchPackage.devDependencies.electron !== controlPackage.devDependencies.electron)
  throw new Error("The control and pull request must pin the same Electron version.");

const records = [];
for (const [name, folder, distribution, version] of [
  ["main", control, "dist/startup-main-control", controlPackage.version],
  [
    "pull-request",
    root,
    "dist/lifecycle-old",
    (await json(join(root, "tests", "fixtures", "lifecycle-versions.json"))).old,
  ],
]) {
  const app = join(folder, distribution, "win-unpacked");
  const archive = join(app, "resources", "app.asar");
  const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  const mainHash = hash(await readFile(join(folder, "out", "main", "index.js")));
  const packagedMainHash = hash(extractFile(archive, join("out", "main", "index.js")));
  const packagedBootstrapHash = hash(extractFile(archive, join("out", "main", "lifecycle.cjs")));
  if (metadata.version !== version || metadata.main !== "./out/main/lifecycle.cjs")
    throw new Error(`The ${name} package has the wrong version or test entry.`);
  if (mainHash !== packagedMainHash || packagedBootstrapHash !== bootstrapHash)
    throw new Error(`The ${name} package changed its own compiled main or the test bootstrap.`);
  const installedElectron = (await json(join(folder, "node_modules", "electron", "package.json")))
    .version;
  if (installedElectron !== branchPackage.devDependencies.electron)
    throw new Error(`The ${name} package was not built with the pinned Electron version.`);
  records.push({
    name,
    sourceSha: git(folder, ["rev-parse", "HEAD"]),
    version,
    mainHash,
    packagedMainHash,
    bootstrapHash: packagedBootstrapHash,
    archiveHash: hash(await readFile(archive)),
    installedElectron,
  });
}
const manifest = {
  baseSha: expectedSha,
  hostNode: process.versions.node,
  nodePin,
  electronPin: branchPackage.devDependencies.electron,
  buildMode: "test",
  order: ["ordinary-pull-request-lifecycle", "main-initial-pages", "pull-request-initial-pages"],
  filter: "a fresh initial launch reaches its native page",
  repeatsPerLanguage: 5,
  workers: 1,
  retries: 0,
  maxFailuresPerArm: 1,
  startupFixtureMode: "quitting (before any quit is requested)",
  afterFailedAssertion:
    "Observe return/exit for up to 60 seconds, then rethrow the original failure.",
  runtimeEvidence: {
    main: "test-results/startup-main-control/**/startup-events*.json",
    pullRequest: "test-results/startup-pr-control/**/startup-events*.json",
    source: "The start event records the actual packaged process.versions in each test.",
  },
  records,
};
await writeFile(join(reportPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
