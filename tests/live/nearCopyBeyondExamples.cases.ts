/**
 * Held-out near copies whose conditions use none of the words the check's Condition line gives as
 * examples (as long as, on condition that, once, where, if, with someone's agreement; 只要…就,
 * 条件是, 一旦, 如果, 征得…同意), and the third clause of the ruling on #1708 both ways: a deadline
 * inside a duty left out (the sentence claims less: a positive) and a deadline that ends a right
 * left out (it claims more: a decoy). Written and committed on 2026-11-04, after the fix and before
 * any run of it, on Documents of their own; measured on `main` first. Not edited after its commit.
 * The bars are the held-out file's: no decoy Supported, positives as on `main` less at most 1 in 14.
 */
import type { NearCopySet } from "./nearCopyHeldout.cases";

const decoy = (key: string, document: string, text: string) => ({
  key,
  kind: "condition" as const,
  document,
  text,
  decoy: true,
});
const positive = (key: string, document: string, text: string) => ({
  key,
  kind: "paraphrase" as const,
  document,
  text,
  decoy: false,
});

export const BEYOND_EXAMPLES_SETS: readonly NearCopySet[] = [
  {
    language: "en",
    documents: [
      {
        key: "hostel",
        file: "Moorfield Youth Hostel house rules.md",
        title: "Moorfield Youth Hostel: house rules",
        clauses: [
          "Guests may use the kitchen as long as they clean up by ten o'clock.",
          "Guests may store bicycles in the yard on condition that they lock them.",
          "Guests may check out late where the warden agrees.",
          "Guests must report a broken window within 24 hours.",
          "Guests may cancel a booking within 14 days of making it.",
        ],
      },
      {
        key: "orchard",
        file: "Ashcombe Community Orchard volunteer rules.md",
        title: "Ashcombe Community Orchard: volunteer rules",
        clauses: [
          "Volunteers may take fruit home once the harvest is in.",
          "Volunteers may use the cider press if a trustee is present.",
          "Volunteers may camp in the orchard with the warden's agreement.",
        ],
      },
    ],
    cases: [
      decoy("as-long-as", "hostel", "Guests may use the kitchen."),
      decoy("on-condition-that", "hostel", "Guests may store bicycles in the yard."),
      decoy("where", "hostel", "Guests may check out late."),
      decoy("deadline-ends-right", "hostel", "Guests may cancel a booking."),
      decoy("once", "orchard", "Volunteers may take fruit home."),
      decoy("if", "orchard", "Volunteers may use the cider press."),
      decoy("with-agreement", "orchard", "Volunteers may camp in the orchard."),
      positive(
        "as-long-as-kept",
        "hostel",
        "As long as they clean up by ten o'clock, guests may use the kitchen.",
      ),
      positive("deadline-inside-duty", "hostel", "Guests must report a broken window."),
      positive(
        "if-kept",
        "orchard",
        "When a trustee is present, volunteers may use the cider press.",
      ),
      positive(
        "with-agreement-kept",
        "orchard",
        "Volunteers may camp in the orchard if the warden agrees.",
      ),
    ],
  },
  {
    language: "zh-CN",
    documents: [
      {
        key: "hostel",
        file: "青石青年旅舍住宿守则.md",
        title: "青石青年旅舍住宿守则",
        clauses: [
          "只要在晚上十点前收拾干净，住客就可以使用厨房。",
          "住客可以把自行车停在院子里，条件是必须上锁。",
          "征得管理员同意后，住客可以延迟退房。",
          "住客发现窗户损坏，须在24小时内报告。",
          "住客可以在预订后14天内取消预订。",
        ],
      },
      {
        key: "orchard",
        file: "盐沼社区果园志愿者守则.md",
        title: "盐沼社区果园志愿者守则",
        clauses: [
          "一旦收获完成，志愿者可以把水果带回家。",
          "如果有理事在场，志愿者可以使用榨汁机。",
          "在看护人同意的情况下，志愿者可以在果园露营。",
        ],
      },
    ],
    cases: [
      decoy("as-long-as", "hostel", "住客可以使用厨房。"),
      decoy("on-condition-that", "hostel", "住客可以把自行车停在院子里。"),
      decoy("with-agreement", "hostel", "住客可以延迟退房。"),
      decoy("deadline-ends-right", "hostel", "住客可以取消预订。"),
      decoy("once", "orchard", "志愿者可以把水果带回家。"),
      decoy("if", "orchard", "志愿者可以使用榨汁机。"),
      decoy("in-the-case-that", "orchard", "志愿者可以在果园露营。"),
      positive("as-long-as-kept", "hostel", "住客在晚上十点前收拾干净的，可以使用厨房。"),
      positive("deadline-inside-duty", "hostel", "住客发现窗户损坏须报告。"),
      positive("if-kept", "orchard", "有理事在场时，志愿者可以使用榨汁机。"),
      positive("with-agreement-kept", "orchard", "看护人同意的话，志愿者可以在果园露营。"),
    ],
  },
];
