import type { PreparedChatModel } from "./chat";
import type { ChatLanguageModel } from "./models";

/**
 * `prepared` with `wrap` applied to its model once a request first asks for it: a check may never
 * send one, and the model it is lent may itself be wrapped only then. The same model asked to
 * think (`thinking`) is wrapped the same way, so what waits on, counts or listens to a check's
 * requests does so for the step that judges too.
 */
export function wrappedWhenUsed(
  prepared: PreparedChatModel,
  wrap: (model: ChatLanguageModel) => ChatLanguageModel,
): PreparedChatModel {
  const whenUsed = (model: () => ChatLanguageModel) => {
    let wrapped: ChatLanguageModel | null = null;
    return {
      enumerable: true,
      get: () => {
        wrapped ??= wrap(model());
        return wrapped;
      },
    };
  };
  const own = Object.getOwnPropertyDescriptors(prepared);
  return Object.defineProperties(Object.create(Object.getPrototypeOf(prepared)), {
    ...own,
    model: whenUsed(() => prepared.model),
    // Asked for by name, not read: reading it here would wrap the one it was lent at once.
    ...("thinking" in own && { thinking: whenUsed(() => prepared.thinking ?? prepared.model) }),
  });
}
