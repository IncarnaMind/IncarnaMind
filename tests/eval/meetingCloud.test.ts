import { afterEach, expect, test, vi } from "vitest";
import { transcribeOnCloud } from "../../eval/meetings/cloud";
import * as socket from "../../src/core/transcription/cloud/socket";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test("a refused stream closes its companion before replaying the rest of the meeting", async () => {
  vi.useFakeTimers();
  vi.stubEnv("SONIOX_API_KEY", "test-key");
  const close = vi.fn();
  let opened = 0;
  vi.spyOn(socket, "connectWebSocket").mockImplementation((_url, _key, events) => {
    const first = opened++ === 0;
    setTimeout(() => {
      events.open();
      if (first) events.message(JSON.stringify({ error_code: 402 }));
    }, 10);
    return { send: () => {}, close };
  });

  const track = new Float32Array(16_000 * 60);
  const run = transcribeOnCloud("soniox", { mic: track, system: track }, []);
  const refused = expect(run).rejects.toThrow("mic: credit");
  await vi.advanceTimersByTimeAsync(200);
  await refused;
  expect(close).toHaveBeenCalledTimes(2);
});
