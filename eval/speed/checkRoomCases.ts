/**
 * Short Answers for the gate of a batch's room (#2951, gates/sentence-check-room.md): an invented
 * freight company's service terms in English and Chinese, and sentences that cite them, each its
 * one line. Written and committed before any run, and no prompt has seen them. The check-times
 * runner writes an Answer of 1, 2 or 3 of them, in order (INCARNAMIND_EVAL_SPEED_ANSWER_SET=room),
 * so the same Answer reaches every arm.
 */
import type { WrittenDocument, WrittenItem } from "./writtenCases";

const EN_TERMS = [
  "NORTHGATE FREIGHT: SERVICE TERMS",
  "These terms apply between Northgate Freight (Northgate) and each customer named on a booking (the Customer).",
  "Collection and delivery",
  "Northgate collects parcels on weekdays between 8 am and 6 pm.",
  "Same-day delivery is available only within the city zone.",
  "The Customer must label each parcel with a booking number.",
  "Northgate may refuse a parcel heavier than 30 kilograms.",
  "A failed delivery is attempted once more on the next working day.",
  "Parcels not collected from the depot within 14 days are returned to the sender.",
  "Charges",
  "Standard delivery costs 12 pounds per parcel.",
  "Customers on the business plan receive a 10 percent discount on standard delivery.",
  "Northgate invoices the Customer at the end of each month.",
  "Invoices are payable within 30 days.",
];
const EN_TERMS_PAGE_TWO = [
  "Liability",
  "Northgate's liability for a lost parcel is limited to 500 pounds.",
  "The Customer must report damage within 48 hours of delivery.",
  "Northgate is not liable for delays caused by severe weather.",
  "Insurance above the standard limit can be bought at booking.",
  "Ending the service",
  "Either party may end the service with 30 days' written notice.",
  "These terms are governed by the law of Scotland.",
];

const ZH_TERMS = [
  "北岸货运服务条款",
  "本条款适用于北岸货运（北岸）与预订单上的每位客户（客户）。",
  "揽收与派送",
  "北岸在工作日上午8点至下午6点揽收包裹。",
  "当日达服务仅限市区范围。",
  "客户须在每个包裹上标注预订编号。",
  "北岸可拒收重量超过30公斤的包裹。",
  "派送失败的，于下一个工作日再派送一次。",
  "包裹在网点存放超过14天未取的，退回寄件人。",
  "费用",
  "标准派送每件12英镑。",
  "商务套餐客户的标准派送享九折优惠。",
  "北岸于每月月底向客户开具发票。",
  "发票须在30天内付清。",
];
const ZH_TERMS_PAGE_TWO = [
  "责任",
  "北岸对丢失包裹的赔偿以500英镑为限。",
  "客户须在签收后48小时内报告损坏。",
  "因恶劣天气造成的延误，北岸不承担责任。",
  "超出标准限额的保险可在预订时购买。",
  "终止服务",
  "任何一方均可提前30天书面通知终止服务。",
  "本条款受苏格兰法律管辖。",
];

export const ROOM_DOCUMENTS: readonly WrittenDocument[] = [
  {
    language: "en",
    file: "Northgate Freight Service Terms.pdf",
    pages: [{ lines: EN_TERMS }, { lines: EN_TERMS_PAGE_TWO }],
    libraries: ["terms"],
  },
  {
    language: "zh-CN",
    file: "北岸货运服务条款.pdf",
    pages: [{ lines: ZH_TERMS }, { lines: ZH_TERMS_PAGE_TWO }],
    libraries: ["terms"],
  },
];

type Item = Omit<WrittenItem, "language" | "library">;
const en = (item: Item): WrittenItem => ({ language: "en", library: "terms", ...item });
const zh = (item: Item): WrittenItem => ({ language: "zh-CN", library: "terms", ...item });

const line = (lines: readonly string[], starts: string) => {
  const found = lines.find((each) => each.startsWith(starts));
  if (!found) throw new Error(`No line starts "${starts}".`);
  return found;
};
const EN = (starts: string) => line([...EN_TERMS, ...EN_TERMS_PAGE_TWO], starts);
const ZH = (starts: string) => line([...ZH_TERMS, ...ZH_TERMS_PAGE_TWO], starts);

/** Each line's sentences in order: what it states, then what says more than it, as an Answer's might. */
export const ROOM_ITEMS: readonly WrittenItem[] = [
  en({
    id: "r-en-collect",
    kind: "copy",
    sentence: EN("Northgate collects"),
    quote: EN("Northgate collects"),
    expected: "stated",
  }),
  en({
    id: "r-en-collect-daily",
    kind: "period",
    sentence: "Northgate collects parcels every day between 8 am and 6 pm.",
    quote: EN("Northgate collects"),
    expected: "not stated",
  }),
  en({
    id: "r-en-same-day",
    kind: "paraphrase",
    sentence: "Same-day delivery is offered only inside the city zone.",
    quote: EN("Same-day"),
    expected: "stated",
  }),
  en({
    id: "r-en-same-day-region",
    kind: "condition",
    sentence: "Same-day delivery is available across the whole region.",
    quote: EN("Same-day"),
    expected: "not stated",
  }),
  en({
    id: "r-en-label",
    kind: "paraphrase",
    sentence: "Each parcel must carry a booking number on its label.",
    quote: EN("The Customer must label"),
    expected: "stated",
  }),
  en({
    id: "r-en-refuse-must",
    kind: "force",
    sentence: "Northgate must refuse any parcel heavier than 30 kilograms.",
    quote: EN("Northgate may refuse"),
    expected: "not stated",
  }),
  en({
    id: "r-en-refuse",
    kind: "paraphrase",
    sentence: "Northgate can turn down parcels over 30 kilograms.",
    quote: EN("Northgate may refuse"),
    expected: "stated",
  }),
  en({
    id: "r-en-again",
    kind: "paraphrase",
    sentence: "If a delivery fails, Northgate tries again on the next working day.",
    quote: EN("A failed delivery"),
    expected: "stated",
  }),
  en({
    id: "r-en-again-twice",
    kind: "condition",
    sentence: "If a delivery fails, Northgate tries twice more before it returns the parcel.",
    quote: EN("A failed delivery"),
    expected: "not stated",
  }),
  en({
    id: "r-en-depot",
    kind: "paraphrase",
    sentence: "Parcels left at the depot for more than 14 days go back to the sender.",
    quote: EN("Parcels not collected"),
    expected: "stated",
  }),
  en({
    id: "r-en-depot-week",
    kind: "period",
    sentence: "Parcels left at the depot for more than 7 days go back to the sender.",
    quote: EN("Parcels not collected"),
    expected: "not stated",
  }),
  en({
    id: "r-en-price",
    kind: "paraphrase",
    sentence: "Standard delivery is 12 pounds a parcel.",
    quote: EN("Standard delivery costs"),
    expected: "stated",
  }),
  en({
    id: "r-en-discount-all",
    kind: "parties",
    sentence: "Every customer receives a 10 percent discount on standard delivery.",
    quote: EN("Customers on the business plan"),
    expected: "not stated",
  }),
  en({
    id: "r-en-discount",
    kind: "paraphrase",
    sentence: "Business-plan customers get 10 percent off standard delivery.",
    quote: EN("Customers on the business plan"),
    expected: "stated",
  }),
  en({
    id: "r-en-invoice",
    kind: "paraphrase",
    sentence: "Northgate sends its invoice at the end of each month.",
    quote: EN("Northgate invoices"),
    expected: "stated",
  }),
  en({
    id: "r-en-pay-14",
    kind: "period",
    sentence: "Invoices are payable within 14 days.",
    quote: EN("Invoices are payable"),
    expected: "not stated",
  }),
  en({
    id: "r-en-pay",
    kind: "paraphrase",
    sentence: "Invoices must be paid within 30 days.",
    quote: EN("Invoices are payable"),
    expected: "stated",
  }),
  en({
    id: "r-en-lost",
    kind: "paraphrase",
    sentence: "Northgate pays at most 500 pounds for a lost parcel.",
    quote: EN("Northgate's liability"),
    expected: "stated",
  }),
  en({
    id: "r-en-lost-full",
    kind: "negation",
    sentence: "Northgate pays the full value of a lost parcel.",
    quote: EN("Northgate's liability"),
    expected: "not stated",
  }),
  en({
    id: "r-en-damage",
    kind: "paraphrase",
    sentence: "Damage has to be reported within 48 hours of delivery.",
    quote: EN("The Customer must report"),
    expected: "stated",
  }),
  en({
    id: "r-en-damage-week",
    kind: "period",
    sentence: "Damage can be reported up to a week after delivery.",
    quote: EN("The Customer must report"),
    expected: "not stated",
  }),
  en({
    id: "r-en-weather",
    kind: "paraphrase",
    sentence: "Northgate is not responsible for delays caused by severe weather.",
    quote: EN("Northgate is not liable"),
    expected: "stated",
  }),
  en({
    id: "r-en-weather-refund",
    kind: "condition",
    sentence: "Northgate refunds the delivery charge when severe weather delays a parcel.",
    quote: EN("Northgate is not liable"),
    expected: "not stated",
  }),
  en({
    id: "r-en-notice",
    kind: "paraphrase",
    sentence: "Either side can end the service by giving 30 days' notice in writing.",
    quote: EN("Either party"),
    expected: "stated",
  }),

  zh({
    id: "r-zh-collect",
    kind: "copy",
    sentence: ZH("北岸在工作日"),
    quote: ZH("北岸在工作日"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-collect-daily",
    kind: "period",
    sentence: "北岸每天上午8点至下午6点揽收包裹。",
    quote: ZH("北岸在工作日"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-same-day",
    kind: "paraphrase",
    sentence: "当日达只在市区范围内提供。",
    quote: ZH("当日达"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-same-day-region",
    kind: "condition",
    sentence: "当日达覆盖整个地区。",
    quote: ZH("当日达"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-label",
    kind: "paraphrase",
    sentence: "每个包裹都要标上预订编号。",
    quote: ZH("客户须在每个包裹"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-refuse-must",
    kind: "force",
    sentence: "北岸必须拒收重量超过30公斤的包裹。",
    quote: ZH("北岸可拒收"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-refuse",
    kind: "paraphrase",
    sentence: "超过30公斤的包裹北岸可以拒收。",
    quote: ZH("北岸可拒收"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-again",
    kind: "paraphrase",
    sentence: "派送失败后，北岸会在下一个工作日再送一次。",
    quote: ZH("派送失败的"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-again-twice",
    kind: "condition",
    sentence: "派送失败后，北岸会再送两次才退回包裹。",
    quote: ZH("派送失败的"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-depot",
    kind: "paraphrase",
    sentence: "在网点放了14天以上没取的包裹会退回寄件人。",
    quote: ZH("包裹在网点"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-depot-week",
    kind: "period",
    sentence: "在网点放了7天以上没取的包裹会退回寄件人。",
    quote: ZH("包裹在网点"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-price",
    kind: "copy",
    sentence: ZH("标准派送每件"),
    quote: ZH("标准派送每件"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-discount-all",
    kind: "parties",
    sentence: "所有客户的标准派送都享九折优惠。",
    quote: ZH("商务套餐客户"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-discount",
    kind: "paraphrase",
    sentence: "商务套餐客户的标准派送打九折。",
    quote: ZH("商务套餐客户"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-invoice",
    kind: "paraphrase",
    sentence: "北岸每月月底开具发票。",
    quote: ZH("北岸于每月月底"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-pay-14",
    kind: "period",
    sentence: "发票须在14天内付清。",
    quote: ZH("发票须在"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-pay",
    kind: "paraphrase",
    sentence: "发票要在30天内付清。",
    quote: ZH("发票须在"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-lost",
    kind: "paraphrase",
    sentence: "丢失包裹北岸最多赔500英镑。",
    quote: ZH("北岸对丢失包裹"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-lost-full",
    kind: "negation",
    sentence: "丢失包裹北岸按全额价值赔偿。",
    quote: ZH("北岸对丢失包裹"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-damage",
    kind: "paraphrase",
    sentence: "损坏要在签收后48小时内报告。",
    quote: ZH("客户须在签收后"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-damage-week",
    kind: "period",
    sentence: "损坏可在签收后一周内报告。",
    quote: ZH("客户须在签收后"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-weather",
    kind: "paraphrase",
    sentence: "恶劣天气造成的延误北岸不负责。",
    quote: ZH("因恶劣天气"),
    expected: "stated",
  }),
  zh({
    id: "r-zh-weather-refund",
    kind: "condition",
    sentence: "因恶劣天气延误的包裹，北岸会退还运费。",
    quote: ZH("因恶劣天气"),
    expected: "not stated",
  }),
  zh({
    id: "r-zh-notice",
    kind: "paraphrase",
    sentence: "任何一方提前30天书面通知即可终止服务。",
    quote: ZH("任何一方"),
    expected: "stated",
  }),
];
