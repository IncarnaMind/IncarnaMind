import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { catalogModel } from "../../src/core/providers/catalog";
import { endpointUrl } from "../../src/core/providers/kinds";
import { type ChatModelSpec, createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createRequestLedger, structuredControls } from "../helpers/meetingFillObservation";

afterEach(() => vi.unstubAllGlobals());

test.each(["claude-haiku-5-5", "claude-sonnet-5-5"] as const)(
  "strict observation accepts the Core's actual resolved %s endpoint without sending to a real API",
  async (model) => {
    const dataDir = await createTempDataFolder();
    const controls = structuredControls({
      INCARNAMIND_STRUCTURED_RECEIPT: join(dataDir, "receipt.json"),
      INCARNAMIND_STRUCTURED_CANDIDATE: "a".repeat(40),
      INCARNAMIND_STRUCTURED_CAP_USD: "0.25",
      INCARNAMIND_DATA_DIR: dataDir,
      INCARNAMIND_LIVE_REPORT: join(dataDir, "report.md"),
      INCARNAMIND_LIVE_REPLIES: "1",
      INCARNAMIND_LIVE_ANTHROPIC_KEY: "made-up-observation-key",
      INCARNAMIND_LIVE_ANTHROPIC_MODEL: model,
      INCARNAMIND_LIVE_CALLS: "reserved-en-structured-toy-endpoint",
    });
    if (!controls) throw new Error("Missing toy observation controls.");
    const network = vi.fn(async () =>
      Response.json({
        id: "msg_toy",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 2,
        },
      }),
    );
    vi.stubGlobal("fetch", network);
    const ledger = createRequestLedger({
      model,
      price: catalogModel("anthropic", model)?.price,
      strict: controls,
    });
    const restore = ledger.installTransportGuard();
    const specs: ChatModelSpec[] = [];
    const core = startCore(dataDir, {
      createChatModel: (spec) => {
        specs.push(spec);
        return ledger.model(spec, () => createAiSdkChatModel(spec));
      },
    });
    try {
      const result = await core.testChatConnection({
        kind: "anthropic",
        modelId: model,
        apiKey: controls.key,
      });
      expect(specs).toHaveLength(1);
      expect(specs[0]?.baseUrl).toBe(endpointUrl("anthropic"));
      expect(result).toEqual({ ok: true });
      expect(network).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()).toMatchObject({
        status: "pass",
        request_count: 1,
        physical_network_count: 1,
        unsettled_requests: 0,
        retry_count: 0,
      });
    } finally {
      core.close();
      restore();
    }
  },
);
