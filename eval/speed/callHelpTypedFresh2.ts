/**
 * The typed question's second fresh slice of call-help cases (#2925): written on 2026-11-13, before
 * any run on it, by a writer who saw neither the instructions it measures nor any earlier reply.
 * Twelve English cases, each with a Chinese twin of the same call, Documents and answer, about a
 * commercial cleaning contractor's offer of a three-year contract to the landlord of an office
 * tower. In each, a button is pressed first, as in a call, and once its reply ends the User types a
 * question in the panel's field: the question's reply is the one measured. Its kinds: a price a
 * Document gives, whether something is included and its limit, a line the other side said earlier,
 * the most the User may offer without approval, a list asked for item by item, what to say to a
 * worry a Document answers, a follow-up that needs the question typed before it, and a question that
 * points at what the other side just said without naming it. Six of the twelve (and so six of the
 * Chinese twins) have no Document fact: the follow-up (a Sunday price), a cancellation fee, whether
 * a tenant's damaged property is insured and up to how much, the most the User may give away free
 * without approval, what to say to a worry about cleaners changing, and what to say when they ask
 * for a certificate number. In each, a nearby Document gives a related but different fact that a
 * careless reply could cite. The other six rest on a Document line, or, for the line said earlier,
 * on the call. Each case's Library also holds Documents of the same business that the question
 * isn't about; no Document is shared with another case or with a set before it. Short calls only.
 * Every name, figure and Document is made up.
 */
import { type CallDocument, type CallHelpCase, line, said } from "./callHelpCases";

const doc = (file: string, title: string, lines: readonly string[]): CallDocument => ({
  file,
  text: [`# ${title}`, "", ...lines.map((each) => `- ${each}`)].join("\n"),
});

const WASHROOM_EN = doc("Washroom service.md", "Washroom service", [
  "Washroom service costs $340 per floor a month.",
  "Each floor's washrooms are visited twice every weekday.",
]);
const CORRIDORS_EN = doc("Corridors and stairwells.md", "Corridors and stairwells", [
  "Corridor and stairwell cleaning costs $210 per floor a month.",
  "Stairwells are mopped every Friday.",
]);
const GLASS_EN = doc("Window cleaning.md", "Window cleaning", [
  "Interior glass partitions are cleaned monthly.",
  "Exterior windows are cleaned every quarter and cost $3.10 per pane.",
]);
const CONSUMABLES_EN = doc("Consumables.md", "Consumables", [
  "Paper, soap and bin liners are supplied at cost plus 8%.",
]);

const SPILL_EN = doc("Spill call-outs.md", "Spill call-outs", [
  "Spill and accident call-outs are included in the monthly fee, up to four a month for the whole building.",
  "Each call-out after the fourth costs $90.",
  "A crew arrives within 45 minutes during working hours.",
]);
const FLOOR_CARE_EN = doc("Floor care.md", "Floor care", [
  "Carpets are vacuumed every working night.",
  "Hard floors are buffed once a month.",
]);
const WASTE_EN = doc("Waste and recycling.md", "Waste and recycling", [
  "General waste and recycling bins are emptied every night.",
  "Confidential waste bins are emptied weekly.",
]);
const KEYS_EN = doc("Keys and access.md", "Keys and access", [
  "Cleaners sign for keys at reception each night.",
  "Lost keys are replaced at our cost.",
]);

const STARTUP_EN = doc("Start-up timeline.md", "Start-up timeline", [
  "We need six weeks from signing to the first clean.",
  "We arrange the handover from the previous cleaner.",
]);
const WALKTHROUGH_EN = doc("Site walk-through.md", "Site walk-through", [
  "A walk-through takes about three hours for a tower of this size.",
  "Our contract manager and a floor specialist attend.",
]);
const MARBLE_EN = doc("Marble care.md", "Marble care", [
  "Marble floors are cleaned with pH-neutral products only.",
  "A floor specialist signs off each marble area every quarter.",
]);
const REPORT_EN = doc("Weekly report.md", "Weekly report", [
  "A cleaning report goes to the property manager every Monday.",
]);

const AUTHORITY_EN = doc("Discount authority.md", "Discount authority", [
  "Sales staff may offer up to 6% off the contract price without approval; anything above 6% needs the commercial director's approval.",
  "Supplies are never discounted.",
]);
const TERM_DISCOUNTS_EN = doc("Term discounts.md", "Term discounts", [
  "A three-year term earns 4% off the contract price.",
  "Paying quarterly in advance earns a further 2%.",
]);
const SCORES_EN = doc("Quality scores.md", "Quality scores", [
  "Every floor is scored out of 100 after each monthly inspection.",
  "A score under 85 triggers a free re-clean.",
]);
const ACCOUNT_MANAGER_EN = doc("Account manager.md", "Account manager", [
  "Each client has one named account manager.",
  "Account managers answer a direct line from 7:00 to 19:00.",
]);

const BEFORE_START_EN = doc("Before your crews start.md", "Before your crews start", [
  "Send us floor plans of every floor.",
  "Send us a list of rooms the cleaners must not enter, such as server rooms and archives.",
  "Give us two names to call out of hours.",
  "Hand over the alarm codes and lift keys on the first night.",
  "Reserve a loading-bay slot for the crew van each evening.",
]);
const FIRST_WEEK_EN = doc("First week.md", "First week", [
  "A supervisor is present on every shift in the first week.",
  "Quality scores are reviewed on day eight.",
]);
const EQUIPMENT_EN = doc("Equipment.md", "Equipment", [
  "We bring all our own equipment.",
  "Machines are tested for electrical safety every six months.",
]);
const UNIFORMS_EN = doc("Uniforms.md", "Uniforms", [
  "Crews wear branded uniforms.",
  "Uniforms are laundered weekly by us.",
]);

const HOURS_EN = doc("Working hours.md", "Working hours", [
  "Standard crews work from 6 pm to 11 pm, after the offices have closed.",
  "Morning visits are limited to the lobby and washrooms.",
]);
const QUIET_EN = doc("Quiet equipment.md", "Quiet equipment", [
  "All our vacuum cleaners are rated at 58 dB or below.",
  "Floor polishers are used only after 6 pm.",
]);
const CREW_SIZE_EN = doc("Crew sizes.md", "Crew sizes", [
  "A tower of this size has a crew of 14 each evening.",
  "Each crew has one supervisor.",
]);
const INVOICING_EN = doc("Invoicing.md", "Invoicing", [
  "Invoices are sent on the last working day of the month.",
  "Payment terms are 30 days.",
]);

const LOBBY_EN = doc("Lobby and lift service.md", "Lobby and lift service", [
  "Lobby and lift cleaning on weekdays costs $1,150 a month.",
  "Saturday cleaning is an extra $260 a month.",
]);
const MATS_EN = doc("Entrance mats.md", "Entrance mats", [
  "Entrance mats are swapped weekly.",
  "Each mat swap costs $35.",
]);
const DOOR_GLASS_EN = doc("Door glass.md", "Door glass", [
  "Revolving doors are wiped down twice a day.",
  "Door glass is polished every Friday.",
]);

const TERM_EN = doc("Contract term.md", "Contract term", [
  "Contracts run for three years, with a review every twelve months.",
  "After the first twelve months, either side may end the contract with 90 days' written notice.",
]);
const MOBILISATION_FEE_EN = doc("Mobilisation fee.md", "Mobilisation fee", [
  "A one-off mobilisation fee of $4,500 covers uniforms, equipment and setup.",
  "The fee is invoiced with the first month.",
]);
const REVIEW_EN = doc("Annual review.md", "Annual review", [
  "The annual review looks at quality scores, complaints and the price.",
  "Price increases at review are capped at 3%.",
]);
const COMPLAINTS_EN = doc("Complaints.md", "Complaints", [
  "Complaints are answered within one working day.",
]);

const INSURANCE_EN = doc("Insurance.md", "Insurance", [
  "Our employer's liability insurance covers injury to our own staff, up to $10 million.",
  "The policy is renewed every 1 January.",
]);
const DAMAGE_REPORTING_EN = doc("Damage reporting.md", "Damage reporting", [
  "Damage found by a cleaner is reported to the supervisor the same night.",
  "The supervisor emails the building manager by 8 am the next day.",
]);
const TRAINING_EN = doc("Training.md", "Training", [
  "New cleaners complete a three-day paid course before their first shift.",
]);

const DEEP_CLEANS_EN = doc("Deep cleans.md", "Deep cleans", [
  "A deep clean of one floor costs $1,800.",
  "Deep cleans are booked with ten working days' notice.",
]);
const MULTI_SITE_EN = doc("Multi-site pricing.md", "Multi-site pricing", [
  "Landlords with three or more buildings earn 5% off the monthly fee for each building.",
]);
const RATE_REVIEW_EN = doc("Rate review.md", "Rate review", [
  "Rates are reviewed each January.",
  "A rate change takes effect with 60 days' notice.",
]);
const EMERGENCY_LINE_EN = doc("Emergency line.md", "Emergency line", [
  "The emergency line answers around the clock.",
]);

const VETTING_EN = doc("Staff vetting.md", "Staff vetting", [
  "All cleaners are police-checked before they start.",
  "Cleaners wear photo ID badges on site.",
]);
const PAY_EN = doc("Pay.md", "Pay", [
  "Our cleaners are paid at least $19 an hour.",
  "Night shifts carry a 15% premium.",
]);
const SUPERVISORS_EN = doc("Site supervisors.md", "Site supervisors", [
  "Each site has one named supervisor who walks every floor before the crew leaves.",
]);

const PRODUCTS_EN = doc("Cleaning products.md", "Cleaning products", [
  "We use only eco-labelled cleaning products.",
  "Concentrates are diluted on site to cut plastic waste.",
]);
const RECYCLING_REPORTS_EN = doc("Recycling reports.md", "Recycling reports", [
  "We report the weight of recycling collected each quarter.",
  "Mixed recycling is separated at the loading bay.",
]);
const WATER_EN = doc("Water use.md", "Water use", [
  "Mopping uses microfibre pads, which cut water use.",
  "Pads are laundered by a local laundry.",
]);

const WASHROOM_ZH = doc("卫生间保洁.md", "卫生间保洁", [
  "卫生间保洁每层每月 2,600 元。",
  "每个工作日，每层卫生间清洁两次。",
]);
const CORRIDORS_ZH = doc("走廊和楼梯间.md", "走廊和楼梯间", [
  "走廊和楼梯间保洁每层每月 1,500 元。",
  "楼梯间每周五拖洗一次。",
]);
const GLASS_ZH = doc("玻璃清洁.md", "玻璃清洁", [
  "室内玻璃隔断每月清洁一次。",
  "外窗每季度清洁一次，每块 22 元。",
]);
const CONSUMABLES_ZH = doc("耗材供应.md", "耗材供应", ["纸巾、洗手液和垃圾袋按成本加 8% 供应。"]);

const SPILL_ZH = doc("泼洒处理.md", "泼洒处理", [
  "泼洒和意外事故的上门处理包含在月费里，整栋楼每月最多四次。",
  "第四次之后，每次 650 元。",
  "工作时间内，保洁人员 45 分钟内到场。",
]);
const FLOOR_CARE_ZH = doc("地面养护.md", "地面养护", [
  "地毯每个工作日夜里吸尘。",
  "硬质地面每月抛光一次。",
]);
const WASTE_ZH = doc("垃圾清运.md", "垃圾清运", [
  "一般垃圾和可回收垃圾每晚清运。",
  "保密文件垃圾桶每周清运一次。",
]);
const KEYS_ZH = doc("钥匙与出入.md", "钥匙与出入", [
  "保洁员每晚到前台签领钥匙。",
  "丢失的钥匙由我们承担更换费用。",
]);

const STARTUP_ZH = doc("进场时间表.md", "进场时间表", [
  "从签约到首次保洁需要六周。",
  "与原保洁公司的交接由我们来安排。",
]);
const WALKTHROUGH_ZH = doc("现场踏勘.md", "现场踏勘", [
  "这种规模的楼，踏勘大约需要三个小时。",
  "我方合同经理和一位地面养护师傅到场。",
]);
const MARBLE_ZH = doc("大理石养护.md", "大理石养护", [
  "大理石地面只使用中性清洁剂。",
  "每个季度由地面养护师傅逐处验收大理石区域。",
]);
const REPORT_ZH = doc("每周报告.md", "每周报告", ["每周一向物业经理发送一份保洁报告。"]);

const AUTHORITY_ZH = doc("折扣权限.md", "折扣权限", [
  "销售最多可以给合同价 6% 的折扣，无需审批；超过 6% 需要商务总监批准。",
  "耗材不打折。",
]);
const TERM_DISCOUNTS_ZH = doc("长期合同折扣.md", "长期合同折扣", [
  "三年期合同，合同价优惠 4%。",
  "每季度预付，再优惠 2%。",
]);
const SCORES_ZH = doc("质量评分.md", "质量评分", [
  "每月检查后，每个楼层按 100 分制打分。",
  "低于 85 分，免费重做一次保洁。",
]);
const ACCOUNT_MANAGER_ZH = doc("客户经理.md", "客户经理", [
  "每个客户有一位固定的客户经理。",
  "客户经理的直线电话 7:00 至 19:00 有人接。",
]);

const BEFORE_START_ZH = doc("开工前准备.md", "开工前准备", [
  "提供每个楼层的平面图。",
  "提供不允许保洁人员进入的房间清单，比如机房和档案室。",
  "留两位下班后可以联系的人。",
  "第一天夜里交接报警密码和电梯钥匙。",
  "每晚为作业车预留一个装卸货位。",
]);
const FIRST_WEEK_ZH = doc("第一周.md", "第一周", [
  "第一周每个班次都有一位主管在场。",
  "第八天复核质量评分。",
]);
const EQUIPMENT_ZH = doc("设备.md", "设备", [
  "所有设备由我们自带。",
  "设备每半年做一次电气安全检测。",
]);
const UNIFORMS_ZH = doc("工装.md", "工装", ["保洁人员统一穿工装。", "工装由我们每周统一清洗。"]);

const HOURS_ZH = doc("作业时间.md", "作业时间", [
  "标准班次在晚上 6 点到 11 点，办公室下班之后。",
  "早间只到大堂和卫生间。",
]);
const QUIET_ZH = doc("低噪设备.md", "低噪设备", [
  "所有吸尘器噪音不超过 58 分贝。",
  "地面抛光机只在晚上 6 点以后使用。",
]);
const CREW_SIZE_ZH = doc("班组人数.md", "班组人数", [
  "这种规模的楼，每晚一个班组 14 人。",
  "每个班组配一位主管。",
]);
const INVOICING_ZH = doc("开票.md", "开票", ["每月最后一个工作日开票。", "付款期 30 天。"]);

const LOBBY_ZH = doc("大堂和电梯保洁.md", "大堂和电梯保洁", [
  "工作日的大堂和电梯保洁每月 9,500 元。",
  "周六保洁每月另加 2,200 元。",
]);
const MATS_ZH = doc("门口地垫.md", "门口地垫", ["门口地垫每周更换一次。", "每次更换 60 元。"]);
const DOOR_GLASS_ZH = doc("门禁玻璃.md", "门禁玻璃", [
  "旋转门每天擦拭两次。",
  "门上的玻璃每周五抛光。",
]);

const TERM_ZH = doc("合同期限.md", "合同期限", [
  "合同期三年，每十二个月复核一次。",
  "满十二个月后，任何一方提前 90 天书面通知即可终止合同。",
]);
const MOBILISATION_FEE_ZH = doc("进场费.md", "进场费", [
  "一次性进场费 3 万元，涵盖工装、设备和开通。",
  "进场费随第一个月的账单一起开具。",
]);
const REVIEW_ZH = doc("年度复核.md", "年度复核", [
  "年度复核看质量评分、投诉和价格。",
  "复核时涨价幅度不超过 3%。",
]);
const COMPLAINTS_ZH = doc("投诉处理.md", "投诉处理", ["投诉在一个工作日内答复。"]);

const INSURANCE_ZH = doc("保险.md", "保险", [
  "我们的雇主责任险承保我方员工的工伤，保额 2,000 万元。",
  "保单每年 1 月 1 日续保。",
]);
const DAMAGE_REPORTING_ZH = doc("损坏报告.md", "损坏报告", [
  "保洁员发现的损坏，当晚报告主管。",
  "主管次日早上 8 点前邮件通知楼宇经理。",
]);
const TRAINING_ZH = doc("培训.md", "培训", ["新保洁员上岗前要完成三天带薪培训。"]);

const DEEP_CLEANS_ZH = doc("深度保洁.md", "深度保洁", [
  "一个楼层的深度保洁每次 13,000 元。",
  "深度保洁需提前十个工作日预约。",
]);
const MULTI_SITE_ZH = doc("多栋楼折扣.md", "多栋楼折扣", [
  "名下有三栋及以上楼宇的业主，每栋楼的月费优惠 5%。",
]);
const RATE_REVIEW_ZH = doc("价格调整.md", "价格调整", [
  "价格每年一月复核。",
  "调价提前 60 天通知。",
]);
const EMERGENCY_LINE_ZH = doc("应急电话.md", "应急电话", ["应急电话 24 小时有人接听。"]);

const VETTING_ZH = doc("员工背景审查.md", "员工背景审查", [
  "所有保洁员上岗前都经过无犯罪记录核查。",
  "保洁员在现场佩戴带照片的工牌。",
]);
const PAY_ZH = doc("薪酬.md", "薪酬", ["保洁员时薪不低于 28 元。", "夜班另有 15% 的补贴。"]);
const SUPERVISORS_ZH = doc("现场主管.md", "现场主管", [
  "每个项目有一位固定的主管，在班组收工前把每个楼层走一遍。",
]);

const PRODUCTS_ZH = doc("清洁用品.md", "清洁用品", [
  "我们只使用有环保标识的清洁用品。",
  "浓缩液在现场稀释，减少塑料包装。",
]);
const RECYCLING_REPORTS_ZH = doc("回收报告.md", "回收报告", [
  "每个季度汇报收集的回收物重量。",
  "混合回收物在装卸区分拣。",
]);
const WATER_ZH = doc("用水.md", "用水", [
  "拖地使用超细纤维拖布，节约用水。",
  "拖布交给本地洗衣厂清洗。",
]);

const ENDS_EN = "Our current cleaning contract ends on the last day of September.";
const ENDS_ZH = "我们现在这家保洁公司的合同九月底到期。";

const ENGLISH: readonly CallHelpCase[] = [
  {
    id: "en-fresh2-price",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "me",
        text: "For a tower your size, most landlords start with the corridors and the washrooms.",
      },
      { who: "them", text: "That's about what we had in mind." },
      { who: "me", text: "We'd visit the washrooms twice every weekday." },
      { who: "them", text: "Fine. What does the washroom service cost per floor?" },
    ],
    documents: [CORRIDORS_EN, WASHROOM_EN, GLASS_EN, CONSUMABLES_EN],
    answer: "$340 per floor a month.",
    rests: [[line(WASHROOM_EN, "Washroom service costs")]],
    avoid:
      "the corridors' $210 per floor given as the washroom price, or a price worked out from the window or consumables figures",
    typed: { question: "How much is the washroom service per floor?", form: "short" },
  },
  {
    id: "en-fresh2-included",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The crews would clean the floors every working night." },
      {
        who: "them",
        text: "The fourth-floor tenants are always knocking over coffee, and the carpets show it.",
      },
      { who: "me", text: "Understood, we see that a lot." },
      {
        who: "them",
        text: "If someone spills something during the day, does the contract send a crew out?",
      },
    ],
    documents: [FLOOR_CARE_EN, WASTE_EN, SPILL_EN, KEYS_EN],
    answer:
      "Yes: spill and accident call-outs are included in the monthly fee, up to four a month for the whole building; each call-out after the fourth costs $90.",
    rests: [[line(SPILL_EN, "up to four a month")]],
    avoid:
      "saying call-outs are unlimited or not included, giving another number a month, or the 45-minute arrival time as the limit",
    typed: { question: "Are spill call-outs included? Is there a limit?", form: "short" },
  },
  {
    id: "en-fresh2-said",
    language: "en",
    kind: "ask",
    needs: "earlier",
    before: [
      { who: "them", text: ENDS_EN },
      { who: "me", text: "Good to know. We'll plan around that." },
    ],
    long: false,
    turns: [
      {
        who: "them",
        text: "The east tower lobby was refitted last spring, so the marble needs careful handling.",
      },
      { who: "me", text: "We'd send a floor specialist to look at it first." },
      { who: "them", text: "Good. And our property manager, Priya, will join the walk-through." },
      { who: "me", text: "Great, I'll put it in the diary." },
    ],
    documents: [WALKTHROUGH_EN, STARTUP_EN, MARBLE_EN, REPORT_EN],
    answer: "On the last day of September, as they said earlier in the call.",
    rests: [[said(ENDS_EN)]],
    avoid: "a date worked out from the six-week start-up time, or a different month",
    typed: { question: "When did they say their current contract ends?", form: "short" },
  },
  {
    id: "en-fresh2-limit",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "me",
        text: "So the full contract comes to four hundred and twelve thousand dollars a year.",
      },
      { who: "them", text: "That's higher than we expected." },
      {
        who: "them",
        text: "We have a competing quote. Bring it down to three hundred and eighty thousand a year and we'll sign this week.",
      },
    ],
    documents: [TERM_DISCOUNTS_EN, SCORES_EN, AUTHORITY_EN, ACCOUNT_MANAGER_EN],
    answer:
      "Up to 6% off the contract price; more than that needs the commercial director's approval. At 6% the $412,000 becomes about $387,300, so their $380,000 needs approval.",
    rests: [[line(AUTHORITY_EN, "up to 6%")]],
    avoid:
      "agreeing to $380,000, giving the three-year term's 4% or any other figure as the limit, or saying no approval is needed",
    typed: { question: "What's the most discount I can offer without approval?", form: "short" },
  },
  {
    id: "en-fresh2-list",
    language: "en",
    kind: "sum",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "I think that covers the contract for today." },
      { who: "them", text: "What do you need from us before your crews can start?" },
      { who: "me", text: "I'll send you the full list tomorrow." },
      { who: "them", text: "Please do, our facilities team will want to plan for it." },
    ],
    documents: [FIRST_WEEK_EN, EQUIPMENT_EN, BEFORE_START_EN, UNIFORMS_EN],
    answer:
      "Five things: floor plans of every floor; a list of rooms the cleaners must not enter, such as server rooms and archives; two names to call out of hours; the alarm codes and lift keys, handed over on the first night; a loading-bay slot for the crew van each evening.",
    rests: [
      [line(BEFORE_START_EN, "floor plans")],
      [line(BEFORE_START_EN, "must not enter")],
      [line(BEFORE_START_EN, "out of hours")],
      [line(BEFORE_START_EN, "alarm codes")],
      [line(BEFORE_START_EN, "loading-bay slot")],
    ],
    avoid:
      "an item from another Document, such as the first week's supervisors or bringing equipment, or an item left out",
    typed: { question: "List what we need from them before the crews start.", form: "list" },
  },
  {
    id: "en-fresh2-worry-pointing",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "Let me go through how a typical floor would be looked after." },
      {
        who: "them",
        text: "Before you do: our tenants have complained about vacuum cleaners running at eight in the morning.",
      },
      {
        who: "them",
        text: "The law firm on three says it can't take calls over the noise, and I'll hear about it if it happens again.",
      },
    ],
    documents: [INVOICING_EN, CREW_SIZE_EN, QUIET_EN, HOURS_EN],
    answer:
      "One or two options to say, the recommended first, each with what it leads to: standard crews work from 6 pm to 11 pm, after the offices have closed, so there is no vacuuming in the working day (which meets the noise worry head on); then that all the vacuum cleaners are rated at 58 dB or below and the floor polishers are used only after 6 pm, or that morning visits are limited to the lobby and washrooms.",
    rests: [[line(HOURS_EN, "6 pm to 11 pm"), line(QUIET_EN, "58 dB")]],
    avoid:
      "a promise the Documents don't make, such as that there will never be any noise, or vacuuming in the morning",
    typed: { question: "What should I say to that?", form: "options" },
  },
  {
    id: "en-fresh2-followup-unknown",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We want the lobby and the lifts spotless every day of the week." },
      { who: "me", text: "That's a common request for a tower like yours." },
      {
        who: "them",
        text: "Weekends included, because the gym members use the lobby on Sundays.",
      },
      { who: "me", text: "Understood." },
    ],
    documents: [DOOR_GLASS_EN, LOBBY_EN, MATS_EN],
    answer:
      "It isn't known: no Document gives a Sunday service or a Sunday price. The Document gives weekdays at $1,150 a month and Saturdays at an extra $260 a month, which the reply may add as such.",
    rests: [],
    avoid:
      "a Sunday price, saying Sunday service is or isn't offered, or the Saturday's $260 or the weekday $1,150 given as Sunday's",
    typed: {
      follows: "How much is the lobby and lift clean?",
      question: "And on Sundays?",
      form: "short",
    },
  },
  {
    id: "en-fresh2-unknown-fee",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The term is three years, with a review every year." },
      { who: "them", text: "Three years is a long time to be tied to a new supplier." },
      {
        who: "them",
        text: "If we're unhappy after twelve months, can we leave? What's the cancellation fee?",
      },
    ],
    documents: [REVIEW_EN, TERM_EN, COMPLAINTS_EN, MOBILISATION_FEE_EN],
    answer:
      "It isn't known: no Document states a cancellation fee. The Documents give 90 days' written notice for either side after the first twelve months and a one-off $4,500 mobilisation fee, which the reply may add as such.",
    rests: [],
    avoid:
      "stating a cancellation fee, saying there is none, or calling the $4,500 mobilisation fee a cancellation fee",
    typed: { question: "What's the cancellation fee?", form: "short" },
  },
  {
    id: "en-fresh2-unknown-cover",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Last year a cleaner knocked a tenant's monitor off a desk, and we sorted the claim out ourselves.",
      },
      { who: "me", text: "We take that seriously." },
      {
        who: "them",
        text: "If your people damage a tenant's equipment, are you covered for that?",
      },
    ],
    documents: [TRAINING_EN, INSURANCE_EN, DAMAGE_REPORTING_EN],
    answer:
      "It isn't known: no Document says whether damage to a tenant's equipment is covered, or up to how much. The only insurance Document gives employer's liability cover of $10 million, which is for injury to the company's own staff, and the reply may add that as such; it may also add that damage is reported to the supervisor the same night and emailed to the building manager by 8 am the next day.",
    rests: [],
    avoid:
      "saying damage to a tenant's equipment is covered, or giving the $10 million as the limit for it",
    typed: { question: "Are we covered for that, and up to how much?", form: "short" },
  },
  {
    id: "en-fresh2-unknown-limit",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "So the price per floor stays as quoted." },
      {
        who: "them",
        text: "Then add a free deep clean of every floor in the first month and we'll sign.",
      },
      { who: "them", text: "Your competitor offered us something like that." },
    ],
    documents: [RATE_REVIEW_EN, EMERGENCY_LINE_EN, DEEP_CLEANS_EN, MULTI_SITE_EN],
    answer:
      "It isn't known: no Document says what the User may give away without approval. The Documents give $1,800 for a deep clean of one floor and a 5% multi-site discount, which are a price and a discount, not an approval limit; the reply may say so, and the User should not agree to free deep cleans on every floor before checking.",
    rests: [],
    avoid:
      "stating an approval limit, agreeing to free deep cleans on every floor, or giving the 5% multi-site discount as the limit",
    typed: { question: "What's the most I can give them free without approval?", form: "short" },
  },
  {
    id: "en-fresh2-unknown-worry",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We'd look after every floor from the lobby up." },
      {
        who: "them",
        text: "My worry is the people. The last contractor rotated the cleaners on our floors every few weeks.",
      },
      {
        who: "them",
        text: "The law firms don't like new faces in their offices at night. Can you promise us the same people?",
      },
    ],
    documents: [PAY_EN, VETTING_EN, SUPERVISORS_EN],
    answer:
      "One or two options that commit to nothing about turnover: the User says they'll find out how long cleaners usually stay on a site and come back with it; an option may add, as related facts and never as an answer to turnover, that every cleaner is police-checked before starting and wears a photo ID badge on site, and that each site has a named supervisor who walks every floor before the crew leaves.",
    rests: [],
    avoid:
      "an option that promises the same cleaners every night, gives a turnover rate or length of service, or says pay is why people stay",
    typed: {
      question: "What can I say to ease their worry about the cleaners changing?",
      form: "options",
    },
  },
  {
    id: "en-fresh2-unknown-say",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "That covers the cleaning schedule and the price." },
      {
        who: "them",
        text: "One more thing. Our board only works with contractors certified to a recognised environmental standard.",
      },
      { who: "them", text: "They'll want the certificate number from you." },
    ],
    documents: [WATER_EN, PRODUCTS_EN, RECYCLING_REPORTS_EN],
    answer:
      "One or two options that commit to nothing: the User says they'll check what the company is certified to and send the certificate number over by a set time; an option may add, as related facts and never as a certification, that only eco-labelled cleaning products are used and that the weight of recycling collected is reported each quarter.",
    rests: [],
    avoid:
      "an option that gives a certificate number, names a standard such as ISO 14001, or says the company is certified",
    typed: { question: "What do I say when they ask for the certificate number?", form: "options" },
  },
];

const CHINESE: readonly CallHelpCase[] = [
  {
    id: "zh-fresh2-price",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "像你们这种体量的楼，一般先从走廊和卫生间做起。" },
      { who: "them", text: "我们也是这么想的。" },
      { who: "me", text: "卫生间我们每个工作日来两次。" },
      { who: "them", text: "可以。卫生间保洁一层一个月多少钱？" },
    ],
    documents: [CORRIDORS_ZH, WASHROOM_ZH, GLASS_ZH, CONSUMABLES_ZH],
    answer: "每层每月 2,600 元。",
    rests: [[line(WASHROOM_ZH, "卫生间保洁每层")]],
    avoid: "把走廊和楼梯间的每层 1,500 元说成卫生间的价格，或用外窗、耗材的数字推算出价格",
    typed: { question: "卫生间保洁每层每月多少钱？", form: "short" },
  },
  {
    id: "zh-fresh2-included",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "保洁人员每个工作日的晚上都会清洁各楼层。" },
      { who: "them", text: "四楼的租户老是把咖啡打翻，地毯上都看得出来。" },
      { who: "me", text: "明白，这种情况我们见得很多。" },
      { who: "them", text: "白天要是有人洒了东西，合同里包不包派人过来？" },
    ],
    documents: [FLOOR_CARE_ZH, WASTE_ZH, SPILL_ZH, KEYS_ZH],
    answer:
      "包含：泼洒和意外事故的上门处理包含在月费里，整栋楼每月最多四次；第四次之后每次 650 元。",
    rests: [[line(SPILL_ZH, "每月最多四次")]],
    avoid: "说上门处理不限次数或不包含，说出别的每月次数，或把 45 分钟到场时间当成次数限制",
    typed: { question: "泼洒上门处理包含吗？有没有次数限制？", form: "short" },
  },
  {
    id: "zh-fresh2-said",
    language: "zh-CN",
    kind: "ask",
    needs: "earlier",
    before: [
      { who: "them", text: ENDS_ZH },
      { who: "me", text: "知道了，我们就按这个时间来安排。" },
    ],
    long: false,
    turns: [
      { who: "them", text: "东塔大堂去年春天刚装修过，大理石要小心处理。" },
      { who: "me", text: "我们会先请地面养护师傅过去看看。" },
      { who: "them", text: "好。现场踏勘那天，我们物业经理周敏也会在。" },
      { who: "me", text: "好的，我记到日程里。" },
    ],
    documents: [WALKTHROUGH_ZH, STARTUP_ZH, MARBLE_ZH, REPORT_ZH],
    answer: "九月底，是对方在通话前面说的。",
    rests: [[said(ENDS_ZH)]],
    avoid: "按六周的进场时间推算出一个日期，或说成别的月份",
    typed: { question: "他们说现在的合同什么时候到期来着？", form: "short" },
  },
  {
    id: "zh-fresh2-limit",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "这样全年合同价是两百八十八万。" },
      { who: "them", text: "比我们预想的高。" },
      { who: "them", text: "我们手上还有另一家的报价。降到两百六十七万，这周就签。" },
    ],
    documents: [TERM_DISCOUNTS_ZH, SCORES_ZH, AUTHORITY_ZH, ACCOUNT_MANAGER_ZH],
    answer:
      "最多可以给合同价 6% 的折扣，不用审批；超过 6% 要商务总监批准。288 万元打 6% 折扣约是 270.7 万元，所以对方要的 267 万元需要批准。",
    rests: [[line(AUTHORITY_ZH, "销售最多可以给合同价 6%")]],
    avoid: "答应降到 267 万元，把三年期合同的 4% 或别的数字说成上限，或说不需要批准",
    typed: { question: "不用审批的话，我最多能给多少折扣？", form: "short" },
  },
  {
    id: "zh-fresh2-list",
    language: "zh-CN",
    kind: "sum",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "好，合同今天就谈到这儿。" },
      { who: "them", text: "你们开工之前，要我们这边准备什么？" },
      { who: "me", text: "我明天把完整清单发给你们。" },
      { who: "them", text: "好，我们设施组要提前安排。" },
    ],
    documents: [FIRST_WEEK_ZH, EQUIPMENT_ZH, BEFORE_START_ZH, UNIFORMS_ZH],
    answer:
      "五项：每个楼层的平面图；不允许保洁人员进入的房间清单，比如机房和档案室；两位下班后可以联系的人；第一天夜里交接的报警密码和电梯钥匙；每晚为作业车预留的装卸货位。",
    rests: [
      [line(BEFORE_START_ZH, "平面图")],
      [line(BEFORE_START_ZH, "不允许保洁人员进入")],
      [line(BEFORE_START_ZH, "下班后")],
      [line(BEFORE_START_ZH, "报警密码")],
      [line(BEFORE_START_ZH, "装卸货位")],
    ],
    avoid: "别的文档里的事项，比如第一周的主管安排或自带设备，或漏掉一项",
    typed: { question: "开工前需要对方准备的事项，逐条列一下。", form: "list" },
  },
  {
    id: "zh-fresh2-worry-pointing",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我先讲讲一个标准楼层是怎么打扫的。" },
      { who: "them", text: "先说个事：租户投诉过，早上八点还在吸尘。" },
      {
        who: "them",
        text: "三楼那家律所说噪音大到没法接电话，再有一次，他们就要找我了。",
      },
    ],
    documents: [INVOICING_ZH, CREW_SIZE_ZH, QUIET_ZH, HOURS_ZH],
    answer:
      "一两个可以说的选项，推荐的在前，各自说明会带来什么：标准班次在晚上 6 点到 11 点、办公室下班之后，白天不会有吸尘的声音（直接回应噪音的担心）；再说所有吸尘器噪音不超过 58 分贝、地面抛光机只在晚上 6 点以后使用，或者早间只到大堂和卫生间。",
    rests: [[line(HOURS_ZH, "晚上 6 点到 11 点"), line(QUIET_ZH, "58 分贝")]],
    avoid: "文档没有的承诺，比如保证再也不会有噪音，或说早上也会吸尘",
    typed: { question: "这个我该怎么回？", form: "options" },
  },
  {
    id: "zh-fresh2-followup-unknown",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们想让大堂和电梯一周七天都干干净净。" },
      { who: "me", text: "你们这样的楼，这个要求很常见。" },
      { who: "them", text: "周末也要做，因为健身房的会员周日也走大堂。" },
      { who: "me", text: "明白。" },
    ],
    documents: [DOOR_GLASS_ZH, LOBBY_ZH, MATS_ZH],
    answer:
      "不知道：没有文档写周日的服务或价格。文档只写了工作日每月 9,500 元和周六另加每月 2,200 元，回复可以把这些作为相关信息补充。",
    rests: [],
    avoid:
      "说出周日的价格，说周日提供或不提供服务，或把周六的 2,200 元、工作日的 9,500 元说成周日的",
    typed: {
      follows: "大堂和电梯保洁多少钱？",
      question: "那周日呢？",
      form: "short",
    },
  },
  {
    id: "zh-fresh2-unknown-fee",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "合同期三年，每年复核一次。" },
      { who: "them", text: "三年对一家新供应商来说太长了。" },
      { who: "them", text: "要是干满一年我们不满意，能走吗？解约违约金是多少？" },
    ],
    documents: [REVIEW_ZH, TERM_ZH, COMPLAINTS_ZH, MOBILISATION_FEE_ZH],
    answer:
      "不知道：没有文档写解约违约金。文档只写了满十二个月后任何一方提前 90 天书面通知即可终止合同，以及一次性的进场费 3 万元，回复可以把这些作为相关信息补充。",
    rests: [],
    avoid: "说出一个违约金数额，说没有违约金，或把 3 万元的进场费说成违约金",
    typed: { question: "提前解约的违约金是多少？", form: "short" },
  },
  {
    id: "zh-fresh2-unknown-cover",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "去年有个保洁员把租户桌上的显示器碰到了地上，赔偿的事是我们自己去协调的。",
      },
      { who: "me", text: "这种事我们很重视。" },
      { who: "them", text: "要是你们的人弄坏了租户的设备，你们的保险赔不赔？" },
    ],
    documents: [TRAINING_ZH, INSURANCE_ZH, DAMAGE_REPORTING_ZH],
    answer:
      "不知道：没有文档写租户设备被损坏是否在保险范围内，也没写赔付上限。唯一的保险文档写的是雇主责任险，承保我方员工的工伤，保额 2,000 万元，回复可以把它作为相关信息补充；损坏当晚报告主管、次日早上 8 点前邮件通知楼宇经理，也可以作为相关信息提到。",
    rests: [],
    avoid: "说租户设备的损坏在保险范围内，或把 2,000 万元说成它的赔付上限",
    typed: { question: "这种情况我们的保险赔吗？最高赔多少？", form: "short" },
  },
  {
    id: "zh-fresh2-unknown-limit",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "那每层的价格就按报价来。" },
      { who: "them", text: "那就在第一个月给每个楼层免费做一次深度保洁，我们就签。" },
      { who: "them", text: "另一家也给过我们类似的条件。" },
    ],
    documents: [RATE_REVIEW_ZH, EMERGENCY_LINE_ZH, DEEP_CLEANS_ZH, MULTI_SITE_ZH],
    answer:
      "不知道：没有文档写销售不用审批最多可以免费送什么。文档只写了一个楼层的深度保洁每次 13,000 元和多栋楼 5% 的折扣，这是价格和折扣，不是审批权限；回复可以这样说明，用户在查清之前不应答应每个楼层都免费深度保洁。",
    rests: [],
    avoid: "说出一个审批权限的上限，答应每个楼层都免费深度保洁，或把多栋楼的 5% 折扣说成上限",
    typed: { question: "不走审批的话，我最多能免费送他们什么？", form: "short" },
  },
  {
    id: "zh-fresh2-unknown-worry",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们会从大堂开始，把每个楼层都照看到。" },
      {
        who: "them",
        text: "我担心的是人。上一家公司每隔几周就换一批在我们楼里打扫的人。",
      },
      {
        who: "them",
        text: "律所最不喜欢晚上在办公室里看到生面孔。你们能保证一直是同一批人吗？",
      },
    ],
    documents: [PAY_ZH, VETTING_ZH, SUPERVISORS_ZH],
    answer:
      "一两个在人员流动上不做任何承诺的说法：用户说先去了解保洁员一般在一个项目上干多久，再回复他们；可以顺带提到相关的事实，但不能当成对人员流动的回答：所有保洁员上岗前都经过无犯罪记录核查，在现场佩戴带照片的工牌，每个项目有一位固定的主管，在班组收工前把每个楼层走一遍。",
    rests: [],
    avoid: "某个选项保证每晚都是同一批人，说出人员流动率或在岗时间，或说待遇好所以人不走",
    typed: { question: "他们担心保洁员老换人，我可以怎么说让他们放心？", form: "options" },
  },
  {
    id: "zh-fresh2-unknown-say",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "那清洁安排和价格就这些。" },
      {
        who: "them",
        text: "还有一件事。我们董事会只跟通过认可的环境管理体系认证的服务商合作。",
      },
      { who: "them", text: "他们会向你们要认证证书编号。" },
    ],
    documents: [WATER_ZH, PRODUCTS_ZH, RECYCLING_REPORTS_ZH],
    answer:
      "一两个不做任何承诺的说法：用户说先去确认公司通过了哪项认证，在约定的时间前把证书编号发给他们；可以顺带提到相关的事实，但不能当成认证：只使用有环保标识的清洁用品，每个季度汇报收集的回收物重量。",
    rests: [],
    avoid: "某个选项说出证书编号，点名某项标准（比如 ISO 14001），或说公司已经通过认证",
    typed: { question: "他们要认证证书编号的时候，我该怎么说？", form: "options" },
  },
];

export const CALL_HELP_TYPED_FRESH2: readonly CallHelpCase[] = [...ENGLISH, ...CHINESE];
