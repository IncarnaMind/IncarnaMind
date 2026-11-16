import type { PreparedChatModel } from "./chat";
import type { ChatLanguageModel } from "./models";

/**
 * `prepared` with `wrap` applied to its model once a request first asks for it: a check may never
 * send one, and the model it is lent may itself be wrapped only then.
 */
export function wrappedWhenUsed(
  prepared: PreparedChatModel,
  wrap: (model: ChatLanguageModel) => ChatLanguageModel,
): PreparedChatModel {
  let wrapped: ChatLanguageModel | null = null;
  return Object.defineProperties(Object.create(Object.getPrototypeOf(prepared)), {
    ...Object.getOwnPropertyDescriptors(prepared),
    model: {
      enumerable: true,
      get: () => {
        wrapped ??= wrap(prepared.model);
        return wrapped;
      },
    },
  });
}
