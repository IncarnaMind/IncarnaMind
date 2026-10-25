/**
 * docs/privacy.md says everything that leaves the computer (#1615), and this
 * keeps it true as the code grows: every data flow and every other connection
 * has its row, and every file in src/core that can reach the network is
 * covered by a line of the page's code table. A new flow or a new file that
 * fails here needs its words in the page first.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { dataFlowIds, networkTrafficIds } from "../../src/core/api";
import { CATALOG_PROVIDERS } from "../../src/core/providers/catalog/providers";

const root = join(__dirname, "../..");
const page = readFileSync(join(root, "docs/privacy.md"), "utf8");
const [flows = "", codeTable = ""] = page.split("## Where the code reaches the network");

/**
 * What can reach the network, by what a file says: a mention of `fetch` (a call, a type, a
 * parameter, an alias of one passed in), a socket, an HTTP client, a hidden page's address, and, in
 * the text with its comments only taken out, the packages that send (the AI SDK's providers, the
 * updater, the crash reporter) and a model's download host.
 */
const MENTIONS =
  /\bfetch\b|\bundici\b|\bnew WebSocket\b|\bnet\.(?:request|fetch)\b|\bloadURL\b|node:https?|node:net/;
const IMPORTS = /@ai-sdk\/|electron-updater|posthog-node|@sentry\/|huggingface\.co/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Also without what is between quotes, so a word in a message or a column name is no mention. */
const withoutStrings = (source: string) =>
  withoutComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");

const reaches = (source: string) =>
  MENTIONS.test(withoutStrings(source)) || IMPORTS.test(withoutComments(source));

describe("docs/privacy.md", () => {
  test.each([...dataFlowIds, ...networkTrafficIds])("has a row for `%s`", (id) => {
    expect(flows).toContain(`\`${id}\``);
  });

  // protects=the page names both hosts of every provider with a China and an International region, so a User sees where a key can go; fails_when=a provider gains or changes a region host and the page doesn't say it; no_claim=how the page words it.
  test.each(
    CATALOG_PROVIDERS.filter((each) => each.endpoints.some((endpoint) => endpoint.id === "intl")),
  )("names each region's host of $id", (provider) => {
    for (const endpoint of provider.endpoints) {
      expect(flows).toContain(new URL(endpoint.baseUrl).host);
    }
  });

  const listed = [...codeTable.matchAll(/`(src\/[^`]+)`/g)].map((match) => match[1] as string);

  test("names only files and folders that exist", () => {
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((path) => !existsSync(join(root, path)))).toEqual([]);
  });

  test.each(["src/core", "src/main"])(
    "covers every file in %s that can reach the network",
    (folder) => {
      const uncovered = sourceFiles(join(root, folder))
        .filter((file) => reaches(readFileSync(file, "utf8")))
        .map((file) => relative(root, file).split("\\").join("/"))
        .filter(
          (file) =>
            !listed.some((path) => path === file || (path.endsWith("/") && file.startsWith(path))),
        );
      expect(uncovered).toEqual([]);
    },
  );
});
