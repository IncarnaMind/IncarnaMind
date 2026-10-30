import { describe, expect, test } from "vitest";
import { checkingModel, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";

const QUOTE = "联系电话13800138000；身份证11010519491231002X；服务费人民币2万三千元。";
const AGREEMENT = { name: "服务协议.txt", contents: `服务协议\n${QUOTE}\n` };

function agreementModel(claim: string, calculation: Plan["calculation"]) {
  const plan: Plan = { verdict: "supported", calculation };
  return checkingModel({ [claim]: plan });
}

describe.each(["en", "zh-CN"] as const)("Chinese agreement figures in %s (#2215)", (language) => {
  test("checks the whole fee beside identifiers and retains its quoted characters", async () => {
    const claim = "服务费人民币2万三千元。";
    const setup = await setUpWithDocuments(
      agreementModel(claim, {
        formula: "fee",
        stated: "人民币2万三千元",
        inputs: [{ name: "fee", label: "服务费", quote: QUOTE, number: "人民币2万三千元" }],
      }),
      [AGREEMENT],
    );
    await setup.core.updateSettings({ user: { language } });
    const provider = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await setup.core.allowDataFlow("checks", provider.service.id);
    expect(
      await setup.core.checkClaim({
        claim,
        model: { providerId: provider.id, modelId: "claude-haiku-5-5" },
      }),
    ).toMatchObject({
      verdict: "supported",
      calculation: {
        agrees: true,
        figure: {
          value: 23000,
          inputs: [
            {
              citation: { quote: QUOTE, check: "found" },
              number: {
                chars: "人民币2万三千元",
                at: QUOTE.indexOf("人民币2万三千元"),
                value: 23000,
                unit: { kind: "currency", code: "CNY" },
              },
            },
          ],
        },
      },
    });
  });

  test("cannot use the phone as an amount from the same agreement", async () => {
    const claim = "联系电话13800138000。";
    const setup = await setUpWithDocuments(
      agreementModel(claim, {
        formula: "fee",
        stated: "13800138000",
        inputs: [{ name: "fee", label: "服务费", quote: QUOTE, number: "13800138000" }],
      }),
      [AGREEMENT],
    );
    await setup.core.updateSettings({ user: { language } });
    const provider = await setup.core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-test",
      modelId: "claude-haiku-5-5",
    });
    if (provider.service) await setup.core.allowDataFlow("checks", provider.service.id);
    const document = setup.documents[0];
    if (!document) throw new Error("The agreement was not added.");
    expect(
      await setup.core.checkClaim({
        claim,
        model: { providerId: provider.id, modelId: "claude-haiku-5-5" },
      }),
    ).toMatchObject({ verdict: "not-checked", versions: [{ documentId: document.id }] });
  });
});
