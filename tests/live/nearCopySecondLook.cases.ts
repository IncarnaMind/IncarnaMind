/**
 * Held-out near copies for the check's second look and for duties and conditions in words the
 * reply form's examples don't use (#1766, #1708). Written and committed on 2026-11-04, before the
 * second look asks for the Duty and Condition lines, on Documents of their own; measured on `main`
 * first. Not edited after its commit.
 *
 * - Two-part sentences whose first part gives another figure or month than the clause, so the
 *   probe's own reply can call it contradicted while its fields say the same, and be looked at
 *   again: the probe drops the clause's condition or puts its duty as advice (decoys), or copies it
 *   (positives).
 * - Whole sentences: a duty as advice ("ought to", 最好), and conditions in other words (providing,
 *   so long as, when someone is with them; 在…的前提下, 书面告知…后, 在…陪同下), dropped (decoys)
 *   or kept in other words or order (positives).
 *
 * The bars are the held-out file's: no decoy Supported, positives as on `main` less at most 1 in 14.
 */
import type { AmendedSet } from "./nearCopyAmended.cases";

const decoy = (
  key: string,
  kind: "duty" | "condition",
  text: string,
  twoPart?: readonly [string, string],
) => ({ key, kind, document: "plots", text, decoy: true, ...(twoPart && { twoPart }) });
const positive = (
  key: string,
  kind: "copy" | "paraphrase",
  text: string,
  twoPart?: readonly [string, string],
) => ({ key, kind, document: "plots", text, decoy: false, ...(twoPart && { twoPart }) });

export const SECOND_LOOK_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: [],
    documents: [
      {
        key: "plots",
        file: "Allotment rules.md",
        title: "Allotment rules",
        clauses: [
          "The plot rent is 45 pounds a year, and plot holders may keep hens if the committee agrees.",
          "The water is turned off in November, and plot holders must drain their water butts.",
          "Plot holders must lock the tool shed after dusk.",
          "Plot holders may light a bonfire providing the wind is blowing away from the houses.",
          "Plot holders may sublet a plot so long as the secretary is told in writing.",
          "Children may visit the site when an adult plot holder is with them.",
        ],
      },
    ],
    cases: [
      decoy(
        "two-part-hens",
        "condition",
        "The plot rent is 50 pounds a year, and plot holders may keep hens.",
        ["The plot rent is 50 pounds a year", "plot holders may keep hens"],
      ),
      decoy(
        "two-part-drain",
        "duty",
        "The water is turned off in October, and plot holders should drain their water butts.",
        ["The water is turned off in October", "plot holders should drain their water butts"],
      ),
      decoy("ought-to", "duty", "Plot holders ought to lock the tool shed after dusk."),
      decoy("providing", "condition", "Plot holders may light a bonfire."),
      decoy("so-long-as", "condition", "Plot holders may sublet a plot."),
      decoy("with-an-adult", "condition", "Children may visit the site."),
      positive(
        "two-part-hens-kept",
        "copy",
        "The plot rent is 50 pounds a year, and plot holders may keep hens if the committee agrees.",
        ["The plot rent is 50 pounds a year", "plot holders may keep hens if the committee agrees"],
      ),
      positive(
        "two-part-drain-kept",
        "copy",
        "The water is turned off in October, and plot holders must drain their water butts.",
        ["The water is turned off in October", "plot holders must drain their water butts"],
      ),
      positive(
        "obliged",
        "paraphrase",
        "Plot holders are obliged to lock the tool shed after dusk.",
      ),
      positive(
        "providing-reordered",
        "paraphrase",
        "Providing the wind is blowing away from the houses, plot holders may light a bonfire.",
      ),
      positive(
        "with-an-adult-kept",
        "paraphrase",
        "Children may visit the site with an adult plot holder.",
      ),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "plots",
        file: "社区菜园守则.md",
        title: "社区菜园守则",
        clauses: [
          "地块年租金为45英镑，经委员会同意，地块持有人可以养鸡。",
          "供水在十一月关闭，地块持有人必须排空储水桶。",
          "地块持有人必须在天黑后锁好工具棚。",
          "在风向背离住宅的前提下，地块持有人可以烧篝火。",
          "地块持有人书面告知秘书后，可以转租地块。",
          "儿童在成年地块持有人陪同下可以进入菜园。",
        ],
      },
    ],
    cases: [
      decoy("two-part-hens", "condition", "地块年租金为50英镑，地块持有人可以养鸡。", [
        "地块年租金为50英镑",
        "地块持有人可以养鸡",
      ]),
      decoy("two-part-drain", "duty", "供水在十月关闭，地块持有人应该排空储水桶。", [
        "供水在十月关闭",
        "地块持有人应该排空储水桶",
      ]),
      decoy("ought-to", "duty", "地块持有人最好在天黑后锁好工具棚。"),
      decoy("providing", "condition", "地块持有人可以烧篝火。"),
      decoy("so-long-as", "condition", "地块持有人可以转租地块。"),
      decoy("with-an-adult", "condition", "儿童可以进入菜园。"),
      positive(
        "two-part-hens-kept",
        "copy",
        "地块年租金为50英镑，经委员会同意，地块持有人可以养鸡。",
        ["地块年租金为50英镑", "经委员会同意，地块持有人可以养鸡"],
      ),
      positive("two-part-drain-kept", "copy", "供水在十月关闭，地块持有人必须排空储水桶。", [
        "供水在十月关闭",
        "地块持有人必须排空储水桶",
      ]),
      positive("obliged", "paraphrase", "地块持有人有义务在天黑后锁好工具棚。"),
      positive("providing-reordered", "paraphrase", "地块持有人可以烧篝火，前提是风向背离住宅。"),
      positive("with-an-adult-kept", "paraphrase", "有成年地块持有人陪同时，儿童可以进入菜园。"),
    ],
  },
];
