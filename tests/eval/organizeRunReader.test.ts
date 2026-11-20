import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "vitest";
import { byArea } from "../../eval/organize/lib/areas";
import { readerJobs, readerLedger } from "../../eval/organize/runReader";
import { createTempDataFolder } from "../helpers/core";

const item = { number: "037", half: 1, language: "zh-CN", name: "合同", description: "协议" };
const items = [item, { ...item, number: "001", half: 2 }];
test("a blind half yields three ordered requests per Folder and discloses only the question fields", () => {
  const jobs = readerJobs("folders", { items }, "1");
  expect(jobs.map((job) => job.id)).toEqual(["037"]);
  expect(new Set(jobs[0]?.requests.map(({ instructions }) => instructions)).size).toBe(3);
  for (const request of jobs[0]?.requests ?? [])
    expect(JSON.parse(request.prompt)).toEqual({
      language: "Simplified Chinese",
      folder: { name: "合同", description: "协议" },
    });
  const [area] = readerJobs("areas", [
    { id: "a", name: "one", text: "opening", scanned: false, language: "zh", label: "meetings" },
    { id: "b", name: "scan", text: "", scanned: true, language: "en", label: "research" },
  ]);
  expect(area?.requests[0]?.prompt).not.toContain("meetings");
  expect(() => readerJobs("folders", { items: [item, item] }, "1")).toThrow("distinct");
});

test("restart reuses a paid reply, preserves an uncertain charge and refuses the next unaffordable read", async () => {
  const path = join(await createTempDataFolder(), "reader.sqlite");
  const requests = readerJobs("folders", { items }, "1")[0]?.requests;
  const request = requests?.[0];
  const secondOrder = requests?.[1];
  const thirdOrder = requests?.[2];
  if (!request || !secondOrder || !thirdOrder) throw Error("Missing test Folder");
  const reply = { areas: byArea(() => "no"), arrangedBy: "" };
  let fail = false;
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      calls++;
      expect(call.providerOptions?.anthropic).toMatchObject({
        effort: "low",
        serviceTier: "standard_only",
      });
      if (fail) throw Error("Interrupted response");
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: "stop" },
        warnings: [],
        usage: {
          inputTokens: { total: 600, noCache: 600, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 80, text: 80, reasoning: 0 },
        },
      };
    },
  });
  const first = readerLedger(path);
  try {
    expect(await Promise.all([first.read(model, request), first.read(model, request)])).toEqual([
      reply,
      reply,
    ]);
    expect(first.total()).toBe(4000);
  } finally {
    first.close();
  }
  const second = readerLedger(path);
  try {
    expect(await second.read(model, request)).toEqual(reply);
    fail = true;
    await expect(second.read(model, secondOrder)).rejects.toThrow("Interrupted response");
    expect(second.total()).toBeGreaterThan(4000);
    await expect(second.read(model, secondOrder)).rejects.toThrow("unsettled");
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO calls VALUES ('other-stage', ?, NULL)").run(
        11_000_000 - second.total(),
      );
    } finally {
      db.close();
    }
    await expect(second.read(model, thirdOrder)).rejects.toThrow("budget");
    expect(calls).toBe(2);
  } finally {
    second.close();
  }
});
