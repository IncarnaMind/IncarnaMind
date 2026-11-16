/**
 * Sentences that drop the condition their clause attaches, each beside a twin that keeps it, on
 * invented Documents (#3197). A condition that limits when a right or duty applies (provided that,
 * only if, subject to, unless, except, after a notice) is part of the claim, and a sentence that
 * drops one is Unsupported (#1708). Written on 2026-11-16, before any request of this file, and
 * not edited after its commit.
 *
 * Two sets per language. The fit set may be read and run while a change is fitted. The held-out
 * set is run only to count: its replies are not read while the change is fitted, and the change is
 * not edited after its first run.
 *
 * The held-out set's "contract" Document was added on 2026-11-16, before any request of the held-out
 * set, because the fault reported on #3197 is a right with its condition and one more clause after
 * it ("可…，须…，且…"), and the first fit run on `main` found the fault rare on the shorter pairs.
 *
 * The bars, fixed before the first run, on Claude Haiku 5.5:
 * - held-out decoys: Supported in none of their checks, where `main`'s count is measured first;
 * - held-out twins (positives): Supported in at least `main`'s count of checks, less 1 in 14;
 * - a decoy that ends Not checked is counted apart and may be Not checked in at most one check
 *   more than on `main`.
 */
import type { AmendedCase, AmendedSet } from "./nearCopyAmended.cases";

const decoy = (key: string, document: string, text: string): AmendedCase => ({
  key,
  kind: "condition",
  document,
  text,
  decoy: true,
});
const twin = (
  key: string,
  document: string,
  kind: "copy" | "paraphrase",
  text: string,
): AmendedCase => ({ key, kind, document, text, decoy: false });

export const DROPPED_FIT_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: [],
    documents: [
      {
        key: "studio",
        file: "Harbourside Studio house rules.md",
        title: "Harbourside Studio house rules",
        clauses: [
          "Members may bring one guest into the studio on weekdays, provided they tell the front desk the day before.",
          "Members may keep a bicycle in the courtyard overnight only if they have registered it with the front desk.",
          "Members may use the podcast room for up to two hours a day, unless another member has booked it.",
          "Members must pay the monthly fee by the fifth, except where the manager has agreed a later date in writing.",
          "Members may print up to fifty pages a month free of charge, once they have completed the induction.",
        ],
      },
    ],
    cases: [
      decoy("guest", "studio", "Members may bring one guest into the studio on weekdays."),
      decoy("bicycle", "studio", "Members may keep a bicycle in the courtyard overnight."),
      decoy("podcast", "studio", "Members may use the podcast room for up to two hours a day."),
      decoy("fee", "studio", "Members must pay the monthly fee by the fifth."),
      decoy("print", "studio", "Members may print up to fifty pages a month free of charge."),
      twin(
        "guest-kept",
        "studio",
        "copy",
        "Members may bring one guest into the studio on weekdays, provided they tell the front desk the day before.",
      ),
      twin(
        "bicycle-kept",
        "studio",
        "paraphrase",
        "Members may keep a bicycle in the courtyard overnight if it is registered with the front desk.",
      ),
      twin(
        "podcast-kept",
        "studio",
        "paraphrase",
        "Members may use the podcast room for up to two hours a day when no other member has booked it.",
      ),
      twin(
        "fee-kept",
        "studio",
        "paraphrase",
        "Members must pay the monthly fee by the fifth unless the manager has agreed a later date in writing.",
      ),
      twin(
        "print-kept",
        "studio",
        "paraphrase",
        "Once they have completed the induction, members may print up to fifty pages a month free of charge.",
      ),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "studio",
        file: "海港工作室会员须知.md",
        title: "海港工作室会员须知",
        clauses: [
          "会员可以在工作日带一位访客进入工作室，须在前一天告知前台。",
          "会员可以把自行车过夜停放在院子里，但须先在前台登记。",
          "会员每天最多可使用录音室两小时，除非该时段已被其他会员预订。",
          "会员须在每月五日前缴纳会费，经经理书面同意延期的除外。",
          "会员完成入门培训后，每月可免费打印五十页。",
        ],
      },
    ],
    cases: [
      decoy("guest", "studio", "会员可以在工作日带一位访客进入工作室。"),
      decoy("bicycle", "studio", "会员可以把自行车过夜停放在院子里。"),
      decoy("podcast", "studio", "会员每天最多可使用录音室两小时。"),
      decoy("fee", "studio", "会员须在每月五日前缴纳会费。"),
      decoy("print", "studio", "会员每月可免费打印五十页。"),
      twin(
        "guest-kept",
        "studio",
        "copy",
        "会员可以在工作日带一位访客进入工作室，须在前一天告知前台。",
      ),
      twin(
        "bicycle-kept",
        "studio",
        "paraphrase",
        "会员可以把自行车过夜停放在院子里，前提是已在前台登记。",
      ),
      twin(
        "podcast-kept",
        "studio",
        "paraphrase",
        "该时段没有其他会员预订的，会员每天最多可使用录音室两小时。",
      ),
      twin(
        "fee-kept",
        "studio",
        "paraphrase",
        "会员须在每月五日前缴纳会费，但经经理书面同意延期的除外。",
      ),
      twin("print-kept", "studio", "copy", "会员完成入门培训后，每月可免费打印五十页。"),
    ],
  },
];

export const DROPPED_HELD_OUT_SETS: readonly AmendedSet[] = [
  {
    language: "en",
    withdrawn: [],
    documents: [
      {
        key: "warranty",
        file: "Marlowe Instruments warranty terms.md",
        title: "Marlowe Instruments warranty terms",
        clauses: [
          "Marlowe will repair a faulty meter free of charge within 24 months of purchase if its seal has not been broken.",
          "Customers may return an unused meter within 30 days, subject to paying the return postage.",
          "Marlowe will send a replacement meter by courier on the next working day when the customer reports the fault before noon.",
          "Customers may transfer the warranty to a new owner, as long as Marlowe is told in writing within 14 days.",
        ],
      },
      {
        key: "contract",
        file: "Redfern Consulting services agreement.md",
        title: "Redfern Consulting services agreement",
        clauses: [
          "The Consultant may use the Client's meeting room three times a month, provided the front desk is booked two working days ahead, and the Client will supply refreshments.",
          "The Consultant may take project files home, only if the project lead agrees in writing, and the Client will provide an encrypted drive.",
          "The Consultant may take five days of unpaid leave a year, subject to thirty days' notice, and the Client will keep paying the Consultant's pension contributions during it.",
        ],
      },
      {
        key: "lab",
        file: "Eastfield Laboratory safety rules.md",
        title: "Eastfield Laboratory safety rules",
        clauses: [
          "Researchers may work in the laboratory after 8 pm only with the laboratory manager's written approval.",
          "Researchers may take samples out of the building, provided the container has been sealed and logged.",
          "Visitors may enter the clean room if they are accompanied by a trained researcher throughout.",
          "Researchers must report a spill within one hour, unless it is under 5 millilitres and non-hazardous.",
        ],
      },
    ],
    cases: [
      decoy(
        "repair",
        "warranty",
        "Marlowe will repair a faulty meter free of charge within 24 months of purchase.",
      ),
      decoy("return", "warranty", "Customers may return an unused meter within 30 days."),
      decoy(
        "replacement",
        "warranty",
        "Marlowe will send a replacement meter by courier on the next working day.",
      ),
      decoy("transfer", "warranty", "Customers may transfer the warranty to a new owner."),
      decoy("late", "lab", "Researchers may work in the laboratory after 8 pm."),
      decoy("samples", "lab", "Researchers may take samples out of the building."),
      decoy("visitors", "lab", "Visitors may enter the clean room."),
      decoy("spill", "lab", "Researchers must report a spill within one hour."),
      twin(
        "repair-kept",
        "warranty",
        "paraphrase",
        "Within 24 months of purchase Marlowe will repair a faulty meter free of charge, provided its seal is intact.",
      ),
      twin(
        "return-kept",
        "warranty",
        "copy",
        "Customers may return an unused meter within 30 days, subject to paying the return postage.",
      ),
      twin(
        "replacement-kept",
        "warranty",
        "paraphrase",
        "If the customer reports the fault before noon, Marlowe will send a replacement meter by courier on the next working day.",
      ),
      twin(
        "transfer-kept",
        "warranty",
        "copy",
        "Customers may transfer the warranty to a new owner, as long as Marlowe is told in writing within 14 days.",
      ),
      twin(
        "late-kept",
        "lab",
        "paraphrase",
        "After 8 pm researchers may work in the laboratory only if the laboratory manager has approved it in writing.",
      ),
      twin(
        "samples-kept",
        "lab",
        "copy",
        "Researchers may take samples out of the building, provided the container has been sealed and logged.",
      ),
      twin(
        "visitors-kept",
        "lab",
        "paraphrase",
        "Visitors may enter the clean room when a trained researcher stays with them throughout.",
      ),
      twin(
        "spill-kept",
        "lab",
        "copy",
        "Researchers must report a spill within one hour, unless it is under 5 millilitres and non-hazardous.",
      ),
      decoy(
        "room",
        "contract",
        "The Consultant may use the Client's meeting room three times a month.",
      ),
      decoy("files", "contract", "The Consultant may take project files home."),
      decoy("leave", "contract", "The Consultant may take five days of unpaid leave a year."),
      twin(
        "room-kept",
        "contract",
        "paraphrase",
        "The Consultant may use the Client's meeting room three times a month, as long as the front desk is booked two working days ahead.",
      ),
      twin(
        "files-kept",
        "contract",
        "paraphrase",
        "The Consultant may take project files home only if the project lead agrees in writing.",
      ),
      twin(
        "leave-kept",
        "contract",
        "paraphrase",
        "The Consultant may take five days of unpaid leave a year, subject to thirty days' notice.",
      ),
    ],
  },
  {
    language: "zh-CN",
    withdrawn: [],
    documents: [
      {
        key: "warranty",
        file: "伯恩仪器保修条款.md",
        title: "伯恩仪器保修条款",
        clauses: [
          "购买后24个月内，若封条未被拆开，伯恩公司免费维修有故障的仪表。",
          "客户可以在30天内退回未使用的仪表，退货邮费由客户承担。",
          "客户在中午前报告故障的，伯恩公司于下一个工作日通过快递寄出替换仪表。",
          "客户可以把保修转让给新的所有人，但须在14天内书面通知伯恩公司。",
        ],
      },
      {
        key: "contract",
        file: "红杉咨询服务协议.md",
        title: "红杉咨询服务协议",
        clauses: [
          "乙方每月可使用甲方会议室三次，须提前两个工作日向前台预约，且甲方负责提供茶水。",
          "乙方可以把项目资料带回家处理，须经项目负责人书面同意，且甲方提供加密硬盘。",
          "乙方每年可休五天无薪假，须提前三十天提出申请，且假期内甲方继续缴纳乙方的养老金。",
        ],
      },
      {
        key: "lab",
        file: "东原实验室安全规定.md",
        title: "东原实验室安全规定",
        clauses: [
          "研究人员晚上8点后只有取得实验室主管的书面批准，才可以在实验室工作。",
          "样品容器已密封并登记的，研究人员可以把样品带出大楼。",
          "访客由受过培训的研究人员全程陪同时，可以进入洁净室。",
          "研究人员须在一小时内报告泄漏，但少于5毫升且无害的泄漏除外。",
        ],
      },
    ],
    cases: [
      decoy("repair", "warranty", "伯恩公司在购买后24个月内免费维修有故障的仪表。"),
      decoy("return", "warranty", "客户可以在30天内退回未使用的仪表。"),
      decoy("replacement", "warranty", "伯恩公司于下一个工作日通过快递寄出替换仪表。"),
      decoy("transfer", "warranty", "客户可以把保修转让给新的所有人。"),
      decoy("late", "lab", "研究人员可以在晚上8点后在实验室工作。"),
      decoy("samples", "lab", "研究人员可以把样品带出大楼。"),
      decoy("visitors", "lab", "访客可以进入洁净室。"),
      decoy("spill", "lab", "研究人员须在一小时内报告泄漏。"),
      twin(
        "repair-kept",
        "warranty",
        "paraphrase",
        "购买后24个月内，只要封条没有被拆开，伯恩公司就免费维修有故障的仪表。",
      ),
      twin(
        "return-kept",
        "warranty",
        "copy",
        "客户可以在30天内退回未使用的仪表，退货邮费由客户承担。",
      ),
      twin(
        "replacement-kept",
        "warranty",
        "copy",
        "客户在中午前报告故障的，伯恩公司于下一个工作日通过快递寄出替换仪表。",
      ),
      twin(
        "transfer-kept",
        "warranty",
        "paraphrase",
        "只要在14天内书面通知伯恩公司，客户就可以把保修转让给新的所有人。",
      ),
      twin(
        "late-kept",
        "lab",
        "paraphrase",
        "晚上8点后，研究人员必须取得实验室主管的书面批准，才可以在实验室工作。",
      ),
      twin("samples-kept", "lab", "copy", "样品容器已密封并登记的，研究人员可以把样品带出大楼。"),
      twin(
        "visitors-kept",
        "lab",
        "paraphrase",
        "受过培训的研究人员全程陪同时，访客可以进入洁净室。",
      ),
      twin(
        "spill-kept",
        "lab",
        "paraphrase",
        "研究人员须在一小时内报告泄漏；少于5毫升且无害的泄漏不在此限。",
      ),
      decoy("room", "contract", "乙方每月可使用甲方会议室三次。"),
      decoy("files", "contract", "乙方可以把项目资料带回家处理。"),
      decoy("leave", "contract", "乙方每年可休五天无薪假。"),
      twin(
        "room-kept",
        "contract",
        "paraphrase",
        "乙方每月可使用甲方会议室三次，但须提前两个工作日向前台预约。",
      ),
      twin(
        "files-kept",
        "contract",
        "paraphrase",
        "乙方经项目负责人书面同意，可以把项目资料带回家处理。",
      ),
      twin(
        "leave-kept",
        "contract",
        "paraphrase",
        "乙方每年可休五天无薪假，须提前三十天提出申请。",
      ),
    ],
  },
];
