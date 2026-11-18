/**
 * A Chinese amount with its sign is shown as one word (docs/agents/zh-CN.md): no space inside it,
 * and none where Chinese meets Chinese.
 */
import { describe, expect, test } from "vitest";
import { translate } from "../../src/shared/i18n";

describe("A Chinese amount with its sign", () => {
  test("an amount with its sign takes no space inside, nor one where Chinese meets Chinese", () => {
    const about = translate("zh-CN", "cost.estimate.price", { cost: "¥0.12" });
    expect(translate("zh-CN", "tagging.cost.estimate", { cost: about })).toBe(
      "每 100 个文档约 ¥0.12",
    );
  });
});
