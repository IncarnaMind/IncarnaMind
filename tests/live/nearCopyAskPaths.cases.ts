/**
 * Held-out near copies for the check's asks (#1766, #1708): conditions a reply may gloss as none in
 * brackets, a party put in other words (so its Roles line may be asked for again) beside a dropped
 * condition, an unconditional rule, and the same duty in another word. Written and committed on
 * 2026-11-05, before the change to how a glossed none is read, to the ask for a line that denies
 * itself and to the lines kept across an ask; on Documents of their own, in English and Chinese.
 * To be measured on `main` first. Not edited after its commit.
 *
 * The bars are the held-out file's: no decoy Supported, positives as on `main` less at most 1 in 14.
 */
import type { AmendedSet } from "./nearCopyAmended.cases";

const decoy = (key: string, kind: "duty" | "condition", text: string) => ({
  key,
  kind,
  document: "workshop",
  text,
  decoy: true,
});
const positive = (key: string, kind: "copy" | "paraphrase", text: string) => ({
  key,
  kind,
  document: "workshop",
  text,
  decoy: false,
});

export const ASK_PATHS_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: [],
    documents: [
      {
        key: "workshop",
        file: "Community workshop rules.md",
        title: "Community workshop rules",
        clauses: [
          "Members may use the bandsaw once they have passed the safety induction.",
          "Members may take offcuts home unless they are marked for a project.",
          "Tools may be borrowed overnight by members with a deposit on file.",
          "The workshop opens to members every Saturday.",
          "Members must sweep their bench before they leave.",
        ],
      },
    ],
    cases: [
      decoy("once-dropped", "condition", "Members may use the bandsaw."),
      decoy("unless-dropped", "condition", "Members may take offcuts home."),
      decoy("party-reworded-dropped", "condition", "Members may borrow tools overnight."),
      decoy("should-for-must", "duty", "Members should sweep their bench before they leave."),
      positive(
        "once-kept",
        "paraphrase",
        "Once they have passed the safety induction, members may use the bandsaw.",
      ),
      positive(
        "party-reworded-kept",
        "paraphrase",
        "Members with a deposit on file may borrow tools overnight.",
      ),
      positive("unconditional", "copy", "The workshop opens to members every Saturday."),
      positive("have-to", "paraphrase", "Members have to sweep their bench before they leave."),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "workshop",
        file: "社区木工坊守则.md",
        title: "社区木工坊守则",
        clauses: [
          "会员通过安全培训后，可以使用带锯。",
          "除非边角料已标明留作项目用料，会员可以把边角料带回家。",
          "已交押金的会员可以把工具借回家过夜。",
          "木工坊每周六向会员开放。",
          "会员离开前必须清扫自己的工作台。",
        ],
      },
    ],
    cases: [
      decoy("once-dropped", "condition", "会员可以使用带锯。"),
      decoy("unless-dropped", "condition", "会员可以把边角料带回家。"),
      decoy("party-reworded-dropped", "condition", "会员可以把工具借回家过夜。"),
      decoy("should-for-must", "duty", "会员离开前应该清扫自己的工作台。"),
      positive("once-kept", "paraphrase", "会员在通过安全培训之后可以使用带锯。"),
      positive("party-reworded-kept", "paraphrase", "交了押金的会员可以把工具借回家过夜。"),
      positive("unconditional", "copy", "木工坊每周六向会员开放。"),
      positive("have-to", "paraphrase", "会员离开前须清扫自己的工作台。"),
    ],
  },
];
