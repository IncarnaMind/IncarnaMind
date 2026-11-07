import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

interface LoadedCall {
  id: string;
  facts: readonly { kind: string; underLine?: string }[];
}

export async function checkStructuredMeetingLoader({
  environment,
  load,
  attempts,
}: {
  environment: Readonly<Record<string, string | undefined>>;
  load(picked: readonly string[]): Promise<readonly LoadedCall[]>;
  attempts(): { fetch: number; provider: number };
}) {
  const candidate = environment.INCARNAMIND_STRUCTURED_CANDIDATE;
  const sourceFreeze = environment.INCARNAMIND_STRUCTURED_SOURCE_FREEZE_SHA256;
  const receipt = environment.INCARNAMIND_STRUCTURED_PREFLIGHT_RECEIPT;
  const picked = environment.INCARNAMIND_LIVE_CALLS?.split(",").map((id) => id.trim()) ?? [];
  if (
    environment.INCARNAMIND_STRUCTURED_LOADER_PREFLIGHT !== "1" ||
    !candidate ||
    !/^[0-9a-f]{40}$/.test(candidate) ||
    !sourceFreeze ||
    !/^[0-9a-f]{64}$/.test(sourceFreeze) ||
    !receipt ||
    !isAbsolute(receipt) ||
    [
      "INCARNAMIND_LIVE_ANTHROPIC_KEY",
      "INCARNAMIND_LIVE_ANTHROPIC_MODEL",
      "INCARNAMIND_LIVE_DEEPSEEK_KEY",
      "INCARNAMIND_LIVE_DEEPSEEK_MODEL",
      "INCARNAMIND_LIVE_OLLAMA_MODEL",
      "INCARNAMIND_STRUCTURED_RECEIPT",
    ].some((name) => environment[name] !== undefined) ||
    picked.length !== 6 ||
    new Set(picked).size !== 6 ||
    picked.some((id) => !/^reserved-(?:en|zh)-structured-[a-z0-9-]+$/.test(id)) ||
    picked.filter((id) => id.startsWith("reserved-en-")).length !== 3
  )
    throw new Error("Invalid keyless structured loader controls.");
  const assertNoAttempts = () => {
    const counts = attempts();
    if (counts.fetch !== 0 || counts.provider !== 0)
      throw new Error("The keyless loader attempted a provider or network request.");
    return counts;
  };
  assertNoAttempts();
  const calls = await load(picked);
  const observed = assertNoAttempts();
  const loaded = calls.map((call) => call.id);
  const aggregate = {
    calls: calls.length,
    decisions: calls.flatMap((call) => call.facts).filter((fact) => fact.kind === "decision")
      .length,
    actions: calls.flatMap((call) => call.facts).filter((fact) => fact.kind === "action").length,
    inPlaceFacts: calls.flatMap((call) => call.facts).filter((fact) => fact.underLine !== undefined)
      .length,
  };
  if (
    new Set(loaded).size !== 6 ||
    loaded.some((id) => !picked.includes(id)) ||
    aggregate.calls !== 6 ||
    aggregate.decisions !== 6 ||
    aggregate.actions !== 18 ||
    aggregate.inPlaceFacts !== 12
  )
    throw new Error("The actual structured loader inventory does not match its frozen contract.");
  const result = {
    schema_version: 1,
    contract: "structured-loader-keyless-v1",
    status: "pass",
    actual_loader: "tests/live/meetingFillSections.live.test.ts#loadReservedCalls",
    candidate,
    source_freeze_sha256: sourceFreeze,
    requested_ids: picked,
    loaded_ids: loaded,
    aggregate,
    networkCalls: observed.fetch,
    providerStarts: observed.provider,
    guard_scope: "fetch and provider construction during the actual loader callback",
  };
  await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}
