import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import { parse } from "@babel/parser";

const [archive, reportPath, ...extra] = process.argv.slice(2);
if (!archive || !reportPath || extra.length) throw new Error("Pass the probe archive and report folder.");
const root = resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = await readFile(join(root, "src/core/storage/migrations.ts"), "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const declaration = tree.program.body
  .filter((statement) => statement.type === "ExportNamedDeclaration" && statement.declaration?.type === "VariableDeclaration")
  .flatMap((statement) => statement.declaration.declarations)
  .find((item) => item.id.type === "Identifier" && item.id.name === "migrations");
if (declaration?.init?.type !== "ArrayExpression") throw new Error("The migration list is not a literal array.");
const migrations = declaration.init.elements.map((item) => {
  if (item?.type !== "ObjectExpression") throw new Error("A migration is not a literal object.");
  const property = (name) => {
    const member = item.properties.find((candidate) => candidate.type === "ObjectProperty" && candidate.key.type === "Identifier" && candidate.key.name === name);
    if (!member || member.type !== "ObjectProperty") throw new Error(`Missing migration ${name}.`);
    return member.value;
  };
  const version = property("version");
  const sql = property("sql");
  if (version.type !== "NumericLiteral" || sql.type !== "TemplateLiteral" || sql.expressions.length !== 0 || sql.quasis.length !== 1 || typeof sql.quasis[0]?.value.cooked !== "string")
    throw new Error("Migration identity must retain literal version and SQL.");
  const text = sql.quasis[0].value.cooked;
  return { version: version.value, sql: text, sqlHash: hash(text) };
});
const mainHash = hash(await readFile(join(root, "out/main/index.js")));
const packagedMainHash = hash(extractFile(archive, join("out", "main", "index.js")));
const bootstrapHash = hash(await readFile(join(root, "e2e/lifecycleMain.cjs")));
const packagedBootstrapHash = hash(extractFile(archive, join("out", "main", "lifecycle.cjs")));
const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
if (mainHash !== packagedMainHash || bootstrapHash !== packagedBootstrapHash || metadata.main !== "./out/main/lifecycle.cjs" || metadata.version !== "0.0.0-startup.1")
  throw new Error("The probe package changed its compiled main or test bootstrap.");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("Probe tracked source is dirty.");
const electronPin = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies.electron;
const installedElectron = JSON.parse(await readFile(join(root, "node_modules/electron/package.json"), "utf8")).version;
if (installedElectron !== electronPin) throw new Error("The package did not use the pinned Electron version.");
const manifest = {
  sourceSha: git("rev-parse", "HEAD"),
  sourceBase: "b12961961d9633682d39a3cbcbde7069a5bfd3df",
  version: metadata.version,
  mainHash, packagedMainHash, bootstrapHash, packagedBootstrapHash,
  archiveHash: hash(await readFile(archive)),
  hostNode: process.versions.node,
  electronPin,
  installedElectron,
  runtimeEvidence: "Each trial startup-events.json start event records actual packaged process.versions.",
  statementBoundary: "Native API calls and exact multi-statement batches; no SQL splitting or separate fsync profiler.",
  trialPlan: "Five normal fresh starts, then five excluded fresh starts if exact-folder exclusion is available; alternating EN/ZH, inverse second-arm order; original five-second predicate and failure capture.",
  migrations,
};
await writeFile(join(reportPath, "package-and-sql.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ sourceSha: manifest.sourceSha, mainHash, archiveHash: manifest.archiveHash, migrationCount: migrations.length }));
