/**
 * The typed question's fresh slice of call-help cases (#2925): written on 2026-11-13, before the
 * instructions it measures were frozen and before any run on it, by a writer who saw neither those
 * instructions nor any earlier reply. Ten English cases, each with a Chinese twin of the same call,
 * Documents and answer, about a commercial solar installer's offer to a warehouse owner. In each, a
 * button is pressed first, as in a call, and once its reply ends the User types a question in the
 * panel's field: the question's reply is the one measured. Its ten kinds: a price a Document gives,
 * whether something is included and its limit, a line the other side said earlier, the most the
 * User may offer without approval, a fact no Document gives, a list asked for item by item, what to
 * say to a worry, a follow-up that needs the question typed before it, a question that points at
 * what the other side just said without naming it, and what to say when they ask for a fact no
 * Document gives. Each case's Library also holds Documents of the same business that the question
 * isn't about; no Document is shared with another case or with a set before it. Short calls only.
 * Every name, figure and Document is made up.
 */
import { type CallDocument, type CallHelpCase, line, said } from "./callHelpCases";

const doc = (file: string, title: string, lines: readonly string[]): CallDocument => ({
  file,
  text: [`# ${title}`, "", ...lines.map((each) => `- ${each}`)].join("\n"),
});

const BATTERY_PRICES_EN = doc("Battery storage prices.md", "Battery storage prices", [
  "A 50 kWh battery costs £21,000 installed.",
  "A 100 kWh battery costs £38,500 installed.",
  "A 200 kWh battery costs £72,000 installed.",
]);
const ARRAY_PRICING_EN = doc("Rooftop array pricing.md", "Rooftop array pricing", [
  "Rooftop arrays are priced at £850 per kWp installed.",
  "Arrays over 250 kWp are priced at £790 per kWp.",
]);
const MONITORING_EN = doc("Monitoring app.md", "Monitoring app", [
  "The app shows live output, refreshed every five minutes.",
  "A monthly output report is emailed on the first working day.",
]);
const SURVEY_BOOKING_EN = doc("Survey booking.md", "Survey booking", [
  "Site surveys are booked within ten working days of the first call.",
  "Surveys are free and carry no obligation.",
]);

const MAINTENANCE_EN = doc("Maintenance plan.md", "Maintenance plan", [
  "The maintenance plan costs £1,900 a year.",
  "Two panel cleans a year are included in the plan.",
  "Each extra clean costs £320.",
]);
const HEIGHT_EN = doc("Working at height.md", "Working at height", [
  "Every roof visit has two engineers and a safety line.",
  "Roof work stops in winds over 25 mph.",
]);
const OUTPUT_EN = doc("Output guarantee.md", "Output guarantee", [
  "We guarantee 90% of the forecast output each year.",
  "Any shortfall is paid back at 25p per kWh.",
]);
const BILLING_EN = doc("Billing stages.md", "Billing stages", [
  "30% is invoiced when the contract is signed.",
  "60% is invoiced when the panels are delivered.",
  "The last 10% is invoiced once the system is connected to the grid.",
]);

const SAVINGS_EN = doc("Typical savings.md", "Typical savings", [
  "A warehouse with an £8,000 monthly bill typically saves about £2,600 a month.",
  "Most systems pay for themselves in six to eight years.",
]);
const PLANNING_EN = doc("Planning permission.md", "Planning permission", [
  "Most warehouse roofs need no planning permission for panels.",
  "Listed buildings and buildings in conservation areas do need it.",
]);
const STAGES_EN = doc("Project stages.md", "Project stages", [
  "Survey, design, install and switch-on usually take ten to fourteen weeks in all.",
]);

const ALLOWANCES_EN = doc("Sales allowances.md", "Sales allowances", [
  "Sales staff may offer up to two free years of the maintenance plan; more needs the sales director's approval.",
  "Battery prices are never reduced.",
]);
const GRID_EN = doc("Grid connection.md", "Grid connection", [
  "We apply to the network operator on your behalf.",
  "Approval usually takes eight to twelve weeks.",
]);
const RECYCLING_EN = doc("Panel recycling.md", "Panel recycling", [
  "Panels at the end of their life are taken back and recycled at no charge.",
]);
const TEAM_EN = doc("Your project team.md", "Your project team", [
  "One project manager runs your install from survey to switch-on.",
  "A named engineer carries out your maintenance visits.",
]);

const WARRANTIES_EN = doc("Warranties.md", "Warranties", [
  "Panels carry a 25-year product warranty.",
  "Inverters carry a 10-year warranty.",
]);
const BATTERY_SITING_EN = doc("Battery siting.md", "Battery siting", [
  "Batteries are housed in a fire-rated outdoor cabinet.",
  "The cabinet needs a concrete base of 2 by 1.5 metres.",
]);
const OFFICE_HOURS_EN = doc("Office hours.md", "Office hours", [
  "Our office is open weekdays from 8:00 to 17:30.",
  "The faults line answers around the clock.",
]);

const BEFORE_SURVEY_EN = doc("Before your survey.md", "Before your survey", [
  "Send us the roof plans or the building's drawings.",
  "Send us the last twelve months of electricity bills.",
  "Send us a photo of the main switchboard.",
  "Arrange access to the roof hatch for the day.",
]);
const SURVEY_DAY_EN = doc("On survey day.md", "On survey day", [
  "The survey takes about half a day.",
  "Two surveyors come, with a drone to photograph the roof.",
]);
const QUOTES_EN = doc("Quotes.md", "Quotes", [
  "Quotes are valid for 60 days.",
  "Panel prices are fixed once the contract is signed.",
]);
const EXPORT_EN = doc("Selling spare power.md", "Selling spare power", [
  "Power you don't use is sold to the grid at your supplier's export rate.",
  "We help you choose an export tariff.",
]);

const MOUNTING_EN = doc("Roof mounting.md", "Roof mounting", [
  "Panels sit on frames held down by ballast weights, so nothing is drilled through the roof.",
  "Before fitting, an engineer checks that the roof can carry the extra load.",
]);
const WORKMANSHIP_EN = doc("Workmanship guarantee.md", "Workmanship guarantee", [
  "Our installation work is guaranteed for ten years.",
]);
const DELIVERY_EN = doc("Panel delivery.md", "Panel delivery", [
  "Panels arrive on pallets two days before the install.",
  "We need a forklift on site to unload them.",
]);
const SITE_HOURS_EN = doc("Working hours on site.md", "Working hours on site", [
  "Our crews work from 7:30 to 17:00.",
  "Noisy work can be kept to the mornings on request.",
]);

const ADD_ONS_EN = doc("Add-on prices.md", "Add-on prices", [
  "Van chargers cost £1,450 each, fitted.",
  "Batteries start at £21,000, fitted.",
]);
const FITTING_EN = doc("Fitting times.md", "Fitting times", [
  "A van charger takes half a day to fit.",
  "A battery takes two days to fit.",
  "A 200 kWp rooftop array takes about three weeks.",
]);
const PAYING_EN = doc("Paying over time.md", "Paying over time", [
  "You can pay outright or spread the cost over five years.",
  "Spreading the cost is charged at 6.9% APR.",
]);
const SUPPLY_EN = doc("Supply upgrades.md", "Supply upgrades", [
  "If your electricity supply needs upgrading, the network operator quotes for it separately.",
]);

const OLDER_ROOFS_EN = doc("Older roof types.md", "Older roof types", [
  "Asbestos cement sheet roofs can take panels after an asbestos survey by a licensed contractor.",
  "On those roofs, installers work from crawl boards and never stand on the sheets.",
]);
const CARBON_EN = doc("Carbon savings.md", "Carbon savings", [
  "Each 100 kWp array saves about 20 tonnes of CO2 a year.",
  "The savings are shown in your monthly statement.",
]);
const REFERRAL_EN = doc("Referral scheme.md", "Referral scheme", [
  "Refer another business and get £500 off your next service.",
]);
const SWITCH_ON_EN = doc("Switch-on day.md", "Switch-on day", [
  "On switch-on day we train two of your staff to use the app.",
]);

const ROOF_FIRE_EN = doc("Fire safety on the roof.md", "Fire safety on the roof", [
  "Every array has a fire-service isolator switch at ground level.",
  "We send the local fire service a plan of the array.",
]);
const PANEL_SPEC_EN = doc("Panel specification.md", "Panel specification", [
  "Each panel is rated at 440 W.",
  "Each panel weighs 21 kg.",
]);
const CREWS_EN = doc("Our install crews.md", "Our install crews", [
  "Our install crews are employed by us directly, never subcontracted.",
]);

const BATTERY_PRICES_ZH = doc("储能电池价格.md", "储能电池价格", [
  "50 千瓦时储能电池，含安装 9.5 万元。",
  "100 千瓦时储能电池，含安装 17.8 万元。",
  "200 千瓦时储能电池，含安装 33 万元。",
]);
const ARRAY_PRICING_ZH = doc("屋顶光伏报价.md", "屋顶光伏报价", [
  "屋顶光伏每瓦 3.1 元，含安装。",
  "装机 250 千瓦以上，每瓦 2.9 元。",
]);
const MONITORING_ZH = doc("发电监控.md", "发电监控", [
  "App 实时显示发电量，每五分钟刷新一次。",
  "每月第一个工作日，把上月的发电报告发到你们邮箱。",
]);
const SURVEY_BOOKING_ZH = doc("勘查预约.md", "勘查预约", [
  "首次沟通后十个工作日内安排现场勘查。",
  "勘查免费，签不签约都没关系。",
]);

const MAINTENANCE_ZH = doc("运维套餐.md", "运维套餐", [
  "运维套餐每年 1.2 万元。",
  "套餐每年含两次组件清洗。",
  "额外清洗每次 2,000 元。",
]);
const HEIGHT_ZH = doc("高空作业.md", "高空作业", [
  "每次上屋顶都有两名工程师，并系好安全绳。",
  "风力超过 6 级时停止屋顶作业。",
]);
const OUTPUT_ZH = doc("发电量保证.md", "发电量保证", [
  "每年保证达到预测发电量的 90%。",
  "不足部分按每千瓦时 0.6 元补偿。",
]);
const BILLING_ZH = doc("付款节点.md", "付款节点", [
  "签约时支付 30%。",
  "组件到货时支付 60%。",
  "并网后支付剩余的 10%。",
]);

const SAVINGS_ZH = doc("节省测算.md", "节省测算", [
  "每月电费 6 万元的仓库，一般每月能省 2 万元左右。",
  "大多数系统六到八年回本。",
]);
const PLANNING_ZH = doc("规划审批.md", "规划审批", [
  "大多数仓库屋顶装光伏不需要规划审批。",
  "文物保护建筑和历史风貌区内的建筑需要审批。",
]);
const STAGES_ZH = doc("项目周期.md", "项目周期", [
  "从勘查、设计、安装到并网，一般总共十到十四周。",
]);

const ALLOWANCES_ZH = doc("销售权限.md", "销售权限", [
  "销售最多可以赠送两年运维套餐；超过两年需要销售总监批准。",
  "储能电池一律不降价。",
]);
const GRID_ZH = doc("并网申请.md", "并网申请", [
  "我们代你们向供电公司提交并网申请。",
  "审批一般需要八到十二周。",
]);
const RECYCLING_ZH = doc("组件回收.md", "组件回收", ["报废的组件我们免费回收处理。"]);
const TEAM_ZH = doc("项目团队.md", "项目团队", [
  "从勘查到并网，由一位项目经理全程负责。",
  "运维上门由固定的工程师负责。",
]);

const WARRANTIES_ZH = doc("质保条款.md", "质保条款", [
  "组件产品质保 25 年。",
  "逆变器质保 10 年。",
]);
const BATTERY_SITING_ZH = doc("储能柜安放.md", "储能柜安放", [
  "储能电池放在防火的户外柜里。",
  "储能柜需要一块 2 米 × 1.5 米的混凝土基础。",
]);
const OFFICE_HOURS_ZH = doc("办公时间.md", "办公时间", [
  "办公室工作日 8:00 至 17:30 有人。",
  "故障热线 24 小时有人接听。",
]);

const BEFORE_SURVEY_ZH = doc("勘查前准备.md", "勘查前准备", [
  "提供屋顶平面图或建筑图纸。",
  "提供最近十二个月的电费单。",
  "拍一张总配电柜的照片发给我们。",
  "勘查那天安排人打开屋顶检修口。",
]);
const SURVEY_DAY_ZH = doc("勘查当天.md", "勘查当天", [
  "勘查大约需要半天。",
  "来两名勘查人员，用无人机拍屋顶。",
]);
const QUOTES_ZH = doc("报价说明.md", "报价说明", [
  "报价有效期 60 天。",
  "签约后组件价格不再变动。",
]);
const EXPORT_ZH = doc("余电上网.md", "余电上网", [
  "用不完的电按当地上网电价卖给电网。",
  "我们协助你们办理余电上网手续。",
]);

const MOUNTING_ZH = doc("屋顶安装方式.md", "屋顶安装方式", [
  "组件装在配重支架上，靠配重块压住，屋面上不打孔。",
  "安装前，工程师会核算屋顶能不能承受新增的荷载。",
]);
const WORKMANSHIP_ZH = doc("施工质保.md", "施工质保", ["安装工程质保十年。"]);
const DELIVERY_ZH = doc("组件到货.md", "组件到货", [
  "组件在安装前两天按托盘送到。",
  "现场需要一台叉车卸货。",
]);
const SITE_HOURS_ZH = doc("现场施工时间.md", "现场施工时间", [
  "施工时间为 7:30 至 17:00。",
  "如有需要，噪音大的工序可以安排在上午。",
]);

const ADD_ONS_ZH = doc("加装设备价格.md", "加装设备价格", [
  "货车充电桩每台 9,800 元，含安装。",
  "储能电池含安装 9.5 万元起。",
]);
const FITTING_ZH = doc("安装工期.md", "安装工期", [
  "每台充电桩安装需要半天。",
  "储能电池安装需要两天。",
  "200 千瓦的屋顶光伏安装大约需要三周。",
]);
const PAYING_ZH = doc("分期付款.md", "分期付款", [
  "可以一次付清，也可以分五年付。",
  "分期年利率为 6.9%。",
]);
const SUPPLY_ZH = doc("电力增容.md", "电力增容", ["如果需要增容，由供电公司另行报价。"]);

const OLDER_ROOFS_ZH = doc("老旧屋面.md", "老旧屋面", [
  "石棉瓦屋面可以安装组件，但要先由有资质的单位做石棉检测。",
  "这类屋面施工时，工人走在爬板上，不踩石棉瓦。",
]);
const CARBON_ZH = doc("减碳量.md", "减碳量", [
  "每 100 千瓦光伏每年约减排 20 吨二氧化碳。",
  "减排量会写在每月的对账单里。",
]);
const REFERRAL_ZH = doc("推荐奖励.md", "推荐奖励", ["推荐其他企业签约，下次运维减 3,000 元。"]);
const SWITCH_ON_ZH = doc("并网当天.md", "并网当天", [
  "并网当天，我们给你们两位员工培训 App 的用法。",
]);

const ROOF_FIRE_ZH = doc("屋顶消防安全.md", "屋顶消防安全", [
  "每套系统在地面都装有供消防使用的紧急关断开关。",
  "我们会把阵列平面图报给当地消防部门。",
]);
const PANEL_SPEC_ZH = doc("组件参数.md", "组件参数", [
  "每块组件功率 440 瓦。",
  "每块组件重 21 公斤。",
]);
const CREWS_ZH = doc("施工队伍.md", "施工队伍", ["施工队都是我们自己的员工，从不外包。"]);

const BILL_EN = "Our electricity bill is running at about eleven thousand pounds a month now.";
const BILL_ZH = "我们现在电费一个月大概八万块。";

const ENGLISH: readonly CallHelpCase[] = [
  {
    id: "en-fresh-price",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "me",
        text: "Most of our warehouse customers add a battery, so the day's power carries the night shift.",
      },
      {
        who: "me",
        text: "There are three sizes, and the hundred kilowatt-hour one suits a site like yours.",
      },
      { who: "them", text: "We do run nights. What does that one cost?" },
    ],
    documents: [ARRAY_PRICING_EN, BATTERY_PRICES_EN, MONITORING_EN, SURVEY_BOOKING_EN],
    answer: "The 100 kWh battery costs £38,500 installed.",
    rests: [[line(BATTERY_PRICES_EN, "A 100 kWh battery")]],
    avoid:
      "another size's price given as the 100 kWh battery's, or a price worked out from the arrays' price per kWp",
    typed: { question: "How much is the 100 kWh battery?", form: "short" },
  },
  {
    id: "en-fresh-included",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "The yard's busy with lorries all day, so the roof gets very dusty.",
      },
      { who: "them", text: "Does the maintenance plan cover cleaning the panels?" },
    ],
    documents: [HEIGHT_EN, OUTPUT_EN, MAINTENANCE_EN, BILLING_EN],
    answer:
      "Yes: the maintenance plan includes two panel cleans a year; each extra clean costs £320.",
    rests: [[line(MAINTENANCE_EN, "Two panel cleans")]],
    avoid:
      "saying cleaning is unlimited or not included, or giving another number of cleans a year",
    typed: { question: "Are panel cleans included? How many a year?", form: "short" },
  },
  {
    id: "en-fresh-said",
    language: "en",
    kind: "ask",
    needs: "earlier",
    before: [
      { who: "them", text: BILL_EN },
      { who: "me", text: "That's useful. We'll size the system around it." },
    ],
    long: false,
    turns: [
      {
        who: "them",
        text: "The roof over the loading bays is the newest part. It was redone three years ago.",
      },
      { who: "me", text: "Good, a newer roof makes our job easier." },
      {
        who: "them",
        text: "And our facilities manager, Dana, will want to be there for the survey.",
      },
    ],
    documents: [SAVINGS_EN, PLANNING_EN, STAGES_EN],
    answer: "About £11,000 a month, as they said earlier in the call.",
    rests: [[said(BILL_EN)]],
    avoid:
      "the £8,000 bill from the savings Document given as theirs, or a figure the call doesn't give",
    typed: { question: "What did they say their monthly bill is?", form: "short" },
  },
  {
    id: "en-fresh-limit",
    language: "en",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "So that's the array, the battery and the maintenance plan." },
      {
        who: "them",
        text: "Give us five years of maintenance free and we'll sign this month.",
      },
    ],
    documents: [GRID_EN, ALLOWANCES_EN, RECYCLING_EN, TEAM_EN],
    answer:
      "Up to two free years of the maintenance plan; five years needs the sales director's approval.",
    rests: [[line(ALLOWANCES_EN, "up to two free years")]],
    avoid: "agreeing to five free years, or saying more than two needs no approval",
    typed: {
      question: "How many free maintenance years can I give without approval?",
      form: "short",
    },
  },
  {
    id: "en-fresh-unknown",
    language: "en",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "me",
        text: "The battery would sit in a cabinet by the loading bay, out of the way.",
      },
      { who: "them", text: "And how long is the battery under warranty?" },
    ],
    documents: [BATTERY_SITING_EN, WARRANTIES_EN, OFFICE_HOURS_EN],
    answer:
      "It isn't known: no Document gives the battery's warranty. The warranties Document covers only the panels (25 years) and the inverters (10 years), which the reply may add as such.",
    rests: [],
    avoid:
      "a warranty term for the battery, such as the panels' 25 years or the inverters' 10 years given as the battery's",
    typed: { question: "What's the battery's warranty?", form: "short" },
  },
  {
    id: "en-fresh-list",
    language: "en",
    kind: "sum",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "Right, I think that covers it for today." },
      { who: "them", text: "Can you send over what you need from us before the survey?" },
      { who: "me", text: "Yes, I'll email the list this afternoon." },
    ],
    documents: [SURVEY_DAY_EN, QUOTES_EN, BEFORE_SURVEY_EN, EXPORT_EN],
    answer:
      "Four things: the roof plans or the building's drawings; the last twelve months of electricity bills; a photo of the main switchboard; access to the roof hatch on the day.",
    rests: [
      [line(BEFORE_SURVEY_EN, "roof plans")],
      [line(BEFORE_SURVEY_EN, "twelve months")],
      [line(BEFORE_SURVEY_EN, "main switchboard")],
      [line(BEFORE_SURVEY_EN, "roof hatch")],
    ],
    avoid:
      "an item the Document doesn't list, such as what happens on survey day, or an item left out",
    typed: { question: "List what we need from them before the survey.", form: "list" },
  },
  {
    id: "en-fresh-say",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "We'd put the array across the two big storage halls." },
      {
        who: "them",
        text: "My worry is the roof. It's a membrane roof, and if you drill holes in it, it'll leak every winter.",
      },
    ],
    documents: [WORKMANSHIP_EN, DELIVERY_EN, MOUNTING_EN, SITE_HOURS_EN],
    answer:
      "One or two options to say, the recommended first, each with what it leads to: nothing is drilled through the roof, because the panels sit on frames held down by ballast weights (which meets the leak worry head on); then that an engineer checks the roof can carry the extra load before fitting (which leads to the survey), or that the installation work is guaranteed for ten years.",
    rests: [[line(MOUNTING_EN, "ballast weights")]],
    avoid:
      "a promise the Documents don't make, such as that the roof will never leak, or that holes will be drilled and sealed",
    typed: { question: "What can I say to put them at ease about the roof?", form: "options" },
  },
  {
    id: "en-fresh-followup",
    language: "en",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "We run six electric vans, so we'd want chargers for them." },
      { who: "them", text: "And a battery, if the numbers work." },
      { who: "me", text: "Both can go in on the same visit as the panels." },
    ],
    documents: [PAYING_EN, ADD_ONS_EN, SUPPLY_EN, FITTING_EN],
    answer: "Half a day for each van charger.",
    rests: [[line(FITTING_EN, "van charger takes")]],
    avoid: "the battery's two days given as the answer, or as the charger's",
    typed: {
      follows: "How much is a van charger?",
      question: "And how long to fit?",
      form: "short",
    },
  },
  {
    id: "en-fresh-pointing",
    language: "en",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "The halls on the east side get sun all day." },
      {
        who: "them",
        text: "That's the snag. Half of that roof is still the old asbestos cement sheets from the eighties.",
      },
    ],
    documents: [CARBON_EN, REFERRAL_EN, OLDER_ROOFS_EN, SWITCH_ON_EN],
    answer:
      "Yes: asbestos cement sheet roofs can take panels after an asbestos survey by a licensed contractor, and installers work from crawl boards, never standing on the sheets.",
    rests: [[line(OLDER_ROOFS_EN, "Asbestos cement sheet roofs")]],
    avoid:
      "saying the roof can't take panels, that the sheets must be replaced first, or that no survey is needed",
    typed: { question: "Can we still do it?", form: "short" },
  },
  {
    id: "en-fresh-unknown-say",
    language: "en",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      {
        who: "them",
        text: "Our insurer won't cover the roof until they have the panels' fire rating.",
      },
      { who: "them", text: "Can you tell me what it is?" },
    ],
    documents: [PANEL_SPEC_EN, ROOF_FIRE_EN, CREWS_EN],
    answer:
      "One or two options that commit to nothing: the User says they'll check the panels' fire rating and send it over, to them or their insurer, by a set time; an option may add, as related facts and never as the rating, that every array has a fire-service isolator switch at ground level and that the local fire service is sent a plan of the array.",
    rests: [],
    avoid:
      "an option that states a fire rating or class for the panels, or promises the insurer will accept them",
    typed: { question: "What should I say to that?", form: "options" },
  },
];

const CHINESE: readonly CallHelpCase[] = [
  {
    id: "zh-fresh-price",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "我们不少仓库客户都会加一套储能，白天发的电留着夜班用。" },
      { who: "me", text: "储能有三种容量，你们这个规模一般选一百千瓦时的。" },
      { who: "them", text: "我们确实有夜班。那款多少钱？" },
    ],
    documents: [ARRAY_PRICING_ZH, BATTERY_PRICES_ZH, MONITORING_ZH, SURVEY_BOOKING_ZH],
    answer: "100 千瓦时储能电池含安装 17.8 万元。",
    rests: [[line(BATTERY_PRICES_ZH, "100 千瓦时储能")]],
    avoid: "把其他容量的价格说成 100 千瓦时的，或用光伏每瓦的单价推算出价格",
    typed: { question: "100 千瓦时的储能多少钱？", form: "short" },
  },
  {
    id: "zh-fresh-included",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们院子里一天到晚都是货车进进出出，屋顶上灰特别大。" },
      { who: "them", text: "运维套餐包括清洗光伏板吗？" },
    ],
    documents: [HEIGHT_ZH, OUTPUT_ZH, MAINTENANCE_ZH, BILLING_ZH],
    answer: "包含：运维套餐每年含两次组件清洗；额外清洗每次 2,000 元。",
    rests: [[line(MAINTENANCE_ZH, "两次组件清洗")]],
    avoid: "说清洗不限次数或不包含，或说出别的每年清洗次数",
    typed: { question: "组件清洗包含吗？一年几次？", form: "short" },
  },
  {
    id: "zh-fresh-said",
    language: "zh-CN",
    kind: "ask",
    needs: "earlier",
    before: [
      { who: "them", text: BILL_ZH },
      { who: "me", text: "这个很有用，我们就按这个来定装机规模。" },
    ],
    long: false,
    turns: [
      { who: "them", text: "装卸区上面那块屋顶最新，三年前刚翻修过。" },
      { who: "me", text: "那好，屋顶新，我们施工也方便。" },
      { who: "them", text: "另外勘查那天，我们设施经理王静要在场。" },
    ],
    documents: [SAVINGS_ZH, PLANNING_ZH, STAGES_ZH],
    answer: "每月大概 8 万元，是对方在通话前面说的。",
    rests: [[said(BILL_ZH)]],
    avoid: "把节省测算里的 6 万元说成他们的电费，或说出通话里没提过的数字",
    typed: { question: "他们说每个月电费多少来着？", form: "short" },
  },
  {
    id: "zh-fresh-limit",
    language: "zh-CN",
    kind: "no",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "那就是光伏、储能，再加上运维套餐。" },
      { who: "them", text: "运维免费送五年，我们这个月就签。" },
    ],
    documents: [GRID_ZH, ALLOWANCES_ZH, RECYCLING_ZH, TEAM_ZH],
    answer: "最多赠送两年运维套餐；送五年需要销售总监批准。",
    rests: [[line(ALLOWANCES_ZH, "最多可以赠送两年")]],
    avoid: "答应送五年，或说超过两年不需要批准",
    typed: { question: "不走审批的话，运维最多能送几年？", form: "short" },
  },
  {
    id: "zh-fresh-unknown",
    language: "zh-CN",
    kind: "answer",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "储能柜就放在装卸区旁边，不碍事。" },
      { who: "them", text: "那电池质保几年？" },
    ],
    documents: [BATTERY_SITING_ZH, WARRANTIES_ZH, OFFICE_HOURS_ZH],
    answer:
      "不知道：没有文档写电池的质保期。质保条款只写了组件 25 年、逆变器 10 年，回复可以把这些作为相关信息补充。",
    rests: [],
    avoid: "说出电池的质保期，比如把组件的 25 年或逆变器的 10 年说成电池的",
    typed: { question: "电池的质保期是多久？", form: "short" },
  },
  {
    id: "zh-fresh-list",
    language: "zh-CN",
    kind: "sum",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "好，今天差不多就聊到这儿。" },
      { who: "them", text: "勘查之前要我们准备什么，你发个清单给我们？" },
      { who: "me", text: "没问题，下午我发邮件给你们。" },
    ],
    documents: [SURVEY_DAY_ZH, QUOTES_ZH, BEFORE_SURVEY_ZH, EXPORT_ZH],
    answer:
      "四项：屋顶平面图或建筑图纸；最近十二个月的电费单；总配电柜的照片；勘查那天安排人打开屋顶检修口。",
    rests: [
      [line(BEFORE_SURVEY_ZH, "屋顶平面图")],
      [line(BEFORE_SURVEY_ZH, "十二个月")],
      [line(BEFORE_SURVEY_ZH, "总配电柜")],
      [line(BEFORE_SURVEY_ZH, "检修口")],
    ],
    avoid: "文档没有列的事项（比如勘查当天的安排），或漏掉一项",
    typed: { question: "勘查前需要对方准备什么？逐条列一下。", form: "list" },
  },
  {
    id: "zh-fresh-say",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "光伏板就铺在那两栋大库房的屋顶上。" },
      {
        who: "them",
        text: "我担心的是屋顶。我们是防水卷材屋面，你们要是打孔，一到冬天就漏。",
      },
    ],
    documents: [WORKMANSHIP_ZH, DELIVERY_ZH, MOUNTING_ZH, SITE_HOURS_ZH],
    answer:
      "一两个可以说的选项，推荐的在前，各自说明会带来什么：屋面上不打孔，组件装在配重支架上，靠配重块压住（直接回应漏水的担心）；再说安装前工程师会核算屋顶能不能承受新增荷载（顺势引到勘查），或者安装工程质保十年。",
    rests: [[line(MOUNTING_ZH, "配重块")]],
    avoid: "文档没有的承诺，比如保证屋顶不漏，或说会打孔再密封",
    typed: { question: "屋顶这个顾虑，我怎么说能让他们放心？", form: "options" },
  },
  {
    id: "zh-fresh-followup",
    language: "zh-CN",
    kind: "check",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "我们有六辆电动货车，所以想装几个充电桩。" },
      { who: "them", text: "要是算下来划算，再加一套储能。" },
      { who: "me", text: "这两样都能跟光伏板同一次装好。" },
    ],
    documents: [PAYING_ZH, ADD_ONS_ZH, SUPPLY_ZH, FITTING_ZH],
    answer: "每台充电桩安装需要半天。",
    rests: [[line(FITTING_ZH, "每台充电桩")]],
    avoid: "把储能电池的两天当作答案，或说成充电桩的",
    typed: { follows: "货车充电桩多少钱一台？", question: "那安装要多长时间？", form: "short" },
  },
  {
    id: "zh-fresh-pointing",
    language: "zh-CN",
    kind: "want",
    needs: "newest",
    long: false,
    turns: [
      { who: "me", text: "东边那几栋库房一整天都有太阳。" },
      { who: "them", text: "问题就在这儿，那片屋顶有一半还是八十年代的石棉瓦。" },
    ],
    documents: [CARBON_ZH, REFERRAL_ZH, OLDER_ROOFS_ZH, SWITCH_ON_ZH],
    answer:
      "能：石棉瓦屋面可以安装组件，但要先由有资质的单位做石棉检测；施工时工人走在爬板上，不踩石棉瓦。",
    rests: [[line(OLDER_ROOFS_ZH, "石棉瓦屋面可以")]],
    avoid: "说屋顶不能装，或说必须先换掉石棉瓦，或说不需要检测",
    typed: { question: "这样还能做吗？", form: "short" },
  },
  {
    id: "zh-fresh-unknown-say",
    language: "zh-CN",
    kind: "say",
    needs: "newest",
    long: false,
    turns: [
      { who: "them", text: "保险公司说，要拿到组件的防火等级才肯给屋顶承保。" },
      { who: "them", text: "你能告诉我是多少吗？" },
    ],
    documents: [PANEL_SPEC_ZH, ROOF_FIRE_ZH, CREWS_ZH],
    answer:
      "一两个不做任何承诺的说法：用户说先去确认组件的防火等级，在约定的时间前发给他们或他们的保险公司；可以顺带提到相关的事实，但不能当成防火等级：每套系统在地面装有供消防使用的紧急关断开关，阵列平面图会报给当地消防部门。",
    rests: [],
    avoid: "某个选项说出组件的防火等级，或承诺保险公司一定会承保",
    typed: { question: "这个我该怎么回？", form: "options" },
  },
];

export const CALL_HELP_TYPED_FRESH: readonly CallHelpCase[] = [...ENGLISH, ...CHINESE];
