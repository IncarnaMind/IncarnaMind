/**
 * The last check before anything leaves this computer: every request to a
 * service passes it at the moment it is sent, not when its work began. Local
 * mode sends nothing to any cloud service, and a flow the User turned off
 * sends nothing more, whatever was allowed before (ADR-0022). A prepared
 * model, a waiting consent prompt or a paced lookup can outlive both.
 *
 * Background work is never asked (ADR-0022): a flow turned off under it
 * throws `ConsentNeededError`, so it waits as it does before it starts.
 */
import { RetryError, wrapLanguageModel } from "ai";
import type { DataFlowId, ExternalService } from "./api";
import type { Consent } from "./consent";
import { ConsentNeededError, ConsentRevokedError, LocalModeError } from "./errors";
import type { ApiEmbeddingModel } from "./providers/embeddings";
import type { ChatLanguageModel } from "./providers/models";
import type { ApiRerankingModel } from "./providers/rerank";

/** The gate's stop behind `error`, also when it ends the AI SDK's retries (`RetryError`); null for any other error. */
export function gateStop(
  error: unknown,
): LocalModeError | ConsentRevokedError | ConsentNeededError | null {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  return cause instanceof LocalModeError ||
    cause instanceof ConsentRevokedError ||
    cause instanceof ConsentNeededError
    ? cause
    : null;
}

/**
 * `model` with `check` before each call of `method`, the one that sends. The AI SDK has no
 * wrapper for every kind of model, and calls the method again for each retry.
 */
function checkedBefore<T extends object>(model: T, method: string, check: () => void): T {
  return new Proxy(model, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== method || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        check();
        return Reflect.apply(value, target, args);
      };
    },
  });
}

const carriesImages = (
  prompt: readonly { content: string | readonly { type: string; mediaType?: string }[] }[],
) =>
  prompt.some(
    (message) =>
      typeof message.content !== "string" &&
      message.content.some(
        (part) => part.type === "file" && part.mediaType?.startsWith("image/") === true,
      ),
  );

export function createSendGate(consent: Consent, localOnly: () => boolean) {
  const stopInLocalMode = (flowId: DataFlowId, service: ExternalService): void => {
    if (localOnly() && !consent.onThisComputer(flowId, service.id)) throw new LocalModeError();
  };

  /** Throws `LocalModeError`, `ConsentRevokedError` or `ConsentNeededError` when nothing may go to `service` on `flowId` now. */
  const check = (flowId: DataFlowId, service: ExternalService): void => {
    stopInLocalMode(flowId, service);
    if (consent.allows(flowId, service)) return;
    const flow = consent.dataFlow(flowId, service);
    throw consent.isBackground(flowId)
      ? new ConsentNeededError(flow)
      : new ConsentRevokedError(flow);
  };

  return {
    check,

    /** The model, with `check` before each of its requests; one on this computer (no service) as it is. */
    model(
      model: ChatLanguageModel,
      flowId: DataFlowId,
      service: ExternalService | null,
    ): ChatLanguageModel {
      if (!service) return model;
      return wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: ({ doGenerate, params }) => {
            check(flowId, service);
            if (flowId === "classification" && carriesImages(params.prompt)) {
              check("scan-images", service);
            }
            return doGenerate();
          },
          wrapStream: ({ doStream, params }) => {
            check(flowId, service);
            if (flowId === "classification" && carriesImages(params.prompt)) {
              check("scan-images", service);
            }
            return doStream();
          },
        },
      });
    },

    /**
     * `model` stopped in Local mode, and by nothing else: a key is tested before its provider
     * is chosen, so no consent stands yet, and a test sends nothing of the User's (ADR-0022).
     */
    testModel(model: ChatLanguageModel, service: ExternalService | null): ChatLanguageModel {
      if (!service) return model;
      return wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: "v4",
          wrapGenerate: ({ doGenerate }) => {
            stopInLocalMode("chat", service);
            return doGenerate();
          },
          wrapStream: ({ doStream }) => {
            stopInLocalMode("chat", service);
            return doStream();
          },
        },
      });
    },

    /** The embedding model, with `check` before each of its requests, retries included. */
    embeddingModel: (model: ApiEmbeddingModel, flowId: DataFlowId, service: ExternalService) =>
      checkedBefore(model, "doEmbed", () => check(flowId, service)),

    /** The reranking model, with `check` before each of its requests, retries included. */
    rerankingModel: (model: ApiRerankingModel, flowId: DataFlowId, service: ExternalService) =>
      checkedBefore(model, "doRerank", () => check(flowId, service)),
  };
}
