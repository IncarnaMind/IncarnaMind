/**
 * When a reference check sends again (#2558): every answer is kept, so checking a list again sends
 * nothing, and only the User's own Check again, or Try again after a service failed, asks a
 * reference no service found, or a lookup that failed, once more
 * (`src/core/referenceChecks/cache.ts`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("the privacy page's reference-check row says when a check sends again", () => {
  const page = read("docs/privacy.md");
  expect(page).toContain(
    "Answers are kept here: checking the list again sends nothing, and only Check again, or Try again after a service failed, asks again about a reference no service found, or a lookup that failed.",
  );
});

test("both data pages' Find sources row says when a check sends again", () => {
  expect(read("docs/where-your-data-goes.md")).toContain(
    "reference check answers are kept here, and only Check again, or Try again after a service failed, sends a reference no service found, or a lookup that failed, once more",
  );
  expect(read("docs/where-your-data-goes.zh-CN.md")).toContain(
    "核对得到的结果保存在本机，只有点按“重新核对”，或服务失败后点按“重试”时，才会把未找到的文献或失败的请求再发送一次",
  );
});
