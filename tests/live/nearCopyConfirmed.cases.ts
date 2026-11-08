/**
 * Four near copies reported on #1766 and #1708 and reproduced there with one Library per case: a
 * duty written as advice ("should" for "must", 应该 for 须), and two rules stated without the
 * exception or condition the clause gives them. Copied here as text, on an invented hire agreement
 * written out again for this file (without its line addressed to an assistant), so this run checks
 * them beside the held-out cases. They are known misses, not held out: they don't count toward the
 * held-out bars, and they must not be Supported after the fix either. Committed before the run that
 * first reads it. Edited on 2026-11-04 only to rename the invented company, twice, as its first two
 * names were real firms'; nothing else changed, and its cases are measured on `main` again first.
 */
import type { NearCopySet } from "./nearCopyHeldout.cases";

export const CONFIRMED_SETS: readonly NearCopySet[] = [
  {
    language: "en",
    documents: [
      {
        key: "hire",
        file: "Quillowgarth Plant Hire terms.md",
        title: "Quillowgarth Plant Hire: terms of hire",
        clauses: [
          "These terms apply between Quillowgarth Plant Hire (Quillowgarth) and the customer named on the hire form (the Hirer).",
          "The Hirer looks after the equipment during the hire.",
          "The Hirer must return the equipment to the Quillowgarth depot by noon on the last day of the hire period.",
          "Quillowgarth delivers the equipment free of charge within the city boundary.",
          "Late returns are charged at the daily rate for each day or part of a day.",
          "The Hirer may cancel a booking free of charge.",
          "Quillowgarth may inspect the equipment at the Hirer's site during working hours.",
          "The Hirer must not lend the equipment to anyone else.",
          "The Hirer pays Quillowgarth a deposit before the equipment leaves the depot.",
          "Quillowgarth refunds the deposit only if the equipment comes back clean and undamaged.",
          "Quillowgarth replaces any machine that breaks down, unless the Hirer caused the fault.",
          "Quillowgarth repairs punctures at no charge, except on equipment hired for demolition work.",
          "Either party may end the hire with written notice.",
          "Quillowgarth may end the hire at once if the Hirer misses a payment.",
          "These terms are governed by the law of Scotland.",
        ],
      },
    ],
    cases: [
      {
        key: "confirmed-should-for-must",
        kind: "duty",
        document: "hire",
        text: "The Hirer should return the equipment to the Quillowgarth depot by noon on the last day of the hire period.",
        decoy: true,
      },
      {
        key: "confirmed-except-dropped",
        kind: "condition",
        document: "hire",
        text: "Quillowgarth repairs punctures at no charge.",
        decoy: true,
      },
      {
        key: "confirmed-if-dropped",
        kind: "condition",
        document: "hire",
        text: "Quillowgarth may end the hire at once.",
        decoy: true,
      },
    ],
  },
  {
    language: "zh-CN",
    documents: [
      {
        key: "hire",
        file: "北岭设备租赁条款.md",
        title: "北岭设备租赁条款",
        clauses: [
          "本条款适用于北岭设备租赁公司（北岭）与租赁单上的客户（承租人）。",
          "承租人在租期内负责设备的日常保养。",
          "承租人须在租期最后一天中午前将设备归还至北岭仓库。",
          "北岭在市区范围内免费送货。",
          "逾期归还按日租金计费。",
          "承租人可免费取消预订。",
          "北岭可在工作时间内到承租人现场检查设备。",
          "承租人不得将设备转借他人。",
          "承租人在设备出库前向北岭支付押金。",
          "只有设备归还时干净且无损坏，北岭才退还押金。",
          "设备出现故障时，北岭负责更换，但因承租人造成的故障除外。",
          "北岭免费修补轮胎，但用于拆除工程的设备除外。",
          "承租人未按时付款的，北岭可立即终止租赁。",
          "本条款受苏格兰法律管辖。",
        ],
      },
    ],
    cases: [
      {
        key: "confirmed-should-for-must",
        kind: "duty",
        document: "hire",
        text: "承租人应该在租期最后一天中午前将设备归还至北岭仓库。",
        decoy: true,
      },
    ],
  },
];
