import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { ChatLanguageModel } from "../providers/models";
import { CostCapError } from "../providers/providerErrors";

type Request = Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]["params"];

/** Attaches the selected frame to the first Answer request that includes its OCR. Later steps use text. */
export function withSharedScreenPicture(
  model: ChatLanguageModel,
  screen: string,
  bytes: Uint8Array,
  signal: AbortSignal,
  sent: () => void,
  overBudget: () => void,
): ChatLanguageModel {
  const route = wrapLanguageModel({ model, middleware: [] });
  let tried = false;
  const send = async <T>(
    request: Request,
    run: (request: Request) => PromiseLike<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const last = request.prompt.at(-1);
    if (
      tried ||
      last?.role !== "user" ||
      !last.content.some(
        (part) => part.type === "text" && part.text.includes(`<shared-screen id="${screen}"`),
      )
    ) {
      return run(request);
    }
    tried = true;
    const content: typeof last.content = [
      ...last.content,
      {
        type: "text",
        text: `The attached picture is from ${screen}. Cite visible words exactly. For a value read from the picture alone, cite ${screen} with quote "(picture)" and identify any estimate.`,
      },
      { type: "file", data: { type: "data", data: bytes }, mediaType: "image/jpeg" },
    ];
    try {
      const result = await run({
        ...request,
        prompt: [...request.prompt.slice(0, -1), { ...last, content }],
      });
      sent();
      return result;
    } catch (error) {
      if (!(error instanceof CostCapError)) throw error;
      overBudget();
      signal.throwIfAborted();
      return run(request);
    }
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v4",
      wrapStream: ({ params }) => send(params, (request) => route.doStream(request)),
      wrapGenerate: ({ params }) => send(params, (request) => route.doGenerate(request)),
    },
  });
}
