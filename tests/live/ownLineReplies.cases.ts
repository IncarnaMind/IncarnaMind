/**
 * The held-out requests for whether a rewrite that answers in a line of its own is set aside, and
 * a real edit never is (#2589). Written and frozen before any run, on made-up Notes that are not a
 * test fixture or prompt example: "talk" requests ask for what the paragraph hasn't got, so a model
 * may answer that nothing needs to change; "edit" requests ask for a real change, which must be
 * written. Each edits the Note's first paragraph; the second must stay as it is.
 */

export interface HeldOutCase {
  id: string;
  language: "en" | "zh";
  group: "talk" | "edit";
  /** The call's own kind: "instruction" runs in Edit with AI and through the assistant. */
  kind: "instruction" | "improve" | "shorten" | "translate";
  note: [string, string];
  /** What the User asks; for "translate", the language to translate into. */
  ask: string;
}

const talk = (id: string, language: "en" | "zh", note: [string, string], ask: string) =>
  ({ id, language, group: "talk", kind: "instruction", note, ask }) as const;
const edit = (
  id: string,
  language: "en" | "zh",
  note: [string, string],
  ask: string,
  kind: HeldOutCase["kind"] = "instruction",
) => ({ id, language, group: "edit", kind, note, ask }) as const;

export const HELD_OUT: readonly HeldOutCase[] = [
  talk(
    "en-t01",
    "en",
    ["Our choir rehearses on Thursdays. New singers are welcome.", "Coffee is served after."],
    "Delete the sentence about the parking fee in the first paragraph.",
  ),
  talk(
    "en-t02",
    "en",
    ["The garden opens at eight. Dogs must stay on a lead.", "Entry is free for children."],
    "Fix the spelling mistakes in the first paragraph.",
  ),
  talk(
    "en-t03",
    "en",
    ["Mara will lead the workshop. Bring your own laptop.", "Lunch is on us."],
    "Remove the date from the first paragraph.",
  ),
  talk(
    "en-t04",
    "en",
    [
      "The library closes early on Fridays. Returns go in the box by the door.",
      "Wi-Fi is available.",
    ],
    "In the first paragraph, change Tuesday to Wednesday.",
  ),
  talk(
    "en-t05",
    "en",
    ["Send questions to the front desk. Staff reply within a day.", "The lobby is open late."],
    "Take the phone number out of the first paragraph.",
  ),
  talk(
    "en-t06",
    "en",
    ["Tickets are sold at the door. Cash and cards are accepted.", "Doors open at seven."],
    "Correct the spelling of 'recieve' in the first paragraph.",
  ),
  talk(
    "en-t07",
    "en",
    ["The trail is steep near the top.", "Water stations are at each mile."],
    "Delete the second sentence of the first paragraph.",
  ),
  talk(
    "en-t08",
    "en",
    ["The hall holds two hundred people. Seats are not numbered.", "A cloakroom is downstairs."],
    "Change the euro prices in the first paragraph to pounds.",
  ),
  talk(
    "en-t09",
    "en",
    ["Please keep the kitchen tidy. Wash your own mug.", "The fridge is cleared on Fridays."],
    "Remove the swear words from the first paragraph.",
  ),
  talk(
    "en-t10",
    "en",
    ["The committee meets monthly. Minutes are shared by email.", "Anyone may attend."],
    "Make the names in the first paragraph anonymous.",
  ),
  talk(
    "en-t11",
    "en",
    ["The museum is closed on Mondays. Guided tours start at noon.", "Audio guides are free."],
    "Translate the Latin phrase in the first paragraph.",
  ),
  talk(
    "en-t12",
    "en",
    ["Meetings start at half past nine. Please be on time.", "Notes go in the shared folder."],
    "Expand the abbreviations in the first paragraph.",
  ),
  talk(
    "en-t13",
    "en",
    ["The pool reopens in June. Lessons resume the week after.", "Lockers need a coin."],
    "Remove the repeated sentence in the first paragraph.",
  ),
  talk(
    "en-t14",
    "en",
    [
      "The report is due on the last day of the month. Late reports are accepted with a note.",
      "Templates are on the shared drive.",
    ],
    "Fix the grammar in the first paragraph.",
  ),
  talk(
    "en-t15",
    "en",
    [
      "Visitors sign in at reception. Badges are returned on the way out.",
      "Parking is behind the building.",
    ],
    "Delete the line about the canteen from the first paragraph.",
  ),
  talk(
    "en-t16",
    "en",
    ["The bus leaves at 07:15 and returns at 18:40.", "Bring a packed lunch."],
    "Put the times in the first paragraph in 24-hour format.",
  ),
  edit(
    "en-e01",
    "en",
    ["We're gonna start the meeting a bit late cause the room's busy.", "Snacks are in the back."],
    "Make the first paragraph more formal.",
  ),
  edit(
    "en-e02",
    "en",
    [
      "Attendees are kindly requested to ensure that all personal belongings are removed from the premises upon departure.",
      "The doors lock at ten.",
    ],
    "Simplify the first paragraph.",
  ),
  edit(
    "en-e03",
    "en",
    [
      "The workshop, which has been running for several years now and has grown a lot, takes place every spring in the old mill by the river.",
      "Sign up online.",
    ],
    "Shorten the first paragraph.",
  ),
  edit(
    "en-e04",
    "en",
    [
      "The view from the top is very good and you can see very far when the weather is good.",
      "Bring water.",
    ],
    "Improve the writing of the first paragraph.",
  ),
  edit(
    "en-e05",
    "en",
    ["Talks are held in the Blue Room. The Blue Room has forty seats.", "Tea is served at four."],
    "In the first paragraph, rename the Blue Room to the Garden Room.",
  ),
  edit(
    "en-e06",
    "en",
    ["Teh shop opens at nien and closes at fvie.", "Card payments only."],
    "Fix the typos in the first paragraph.",
  ),
  edit(
    "en-e07",
    "en",
    ["The market opens at dawn and closes at noon.", "Stalls are rented by the day."],
    "Translate the first paragraph into French.",
  ),
  edit(
    "en-e08",
    "en",
    ["Our team values honest feedback and quick decisions.", "We meet on Mondays."],
    "Rewrite the first paragraph in your own words.",
  ),
  edit(
    "en-e09",
    "en",
    [
      "We will leverage cross-functional synergies to operationalise key deliverables.",
      "The plan is due in May.",
    ],
    "Translate the jargon in the first paragraph into plain words.",
  ),
  edit(
    "en-e10",
    "en",
    ["Applications received after the deadline will not be considered.", "The deadline is 1 June."],
    "Make the first paragraph sound friendlier.",
  ),
  edit(
    "en-e11",
    "en",
    [
      "Photosynthesis converts light energy into chemical energy stored in glucose.",
      "Plants need water too.",
    ],
    "Rewrite the first paragraph so a child can understand it.",
  ),
  edit(
    "en-e12",
    "en",
    [
      "The boats leave the harbour at six. The boats return at dusk.",
      "The harbour is busy in summer.",
    ],
    "In the first paragraph, replace 'boats' with 'ships'.",
  ),
  edit(
    "en-e13",
    "en",
    ["The council repaired the bridge last spring.", "Traffic is back to normal."],
    "Write the first paragraph in the passive voice.",
  ),
  edit(
    "en-e14",
    "en",
    ["I wonder whether the train will be on time today.", "The station is small."],
    "Turn the first paragraph into a single question.",
  ),
  edit(
    "en-e15",
    "en",
    [
      "the results was better then we expected and every body was happy",
      "The next review is in May.",
    ],
    "",
    "improve",
  ),
  edit(
    "en-e16",
    "en",
    [
      "The festival, which is held every year in the town square and attracts visitors from all over the region, will take place on the second weekend of July this year.",
      "Entry is free.",
    ],
    "",
    "shorten",
  ),
  edit(
    "en-e17",
    "en",
    ["The museum opens at ten and closes at six.", "Tickets are cheaper online."],
    "French",
    "translate",
  ),
  edit(
    "en-e18",
    "en",
    ["The new playground opens on Saturday.", "Parents are welcome."],
    "Change the tone of the first paragraph to excited.",
  ),
  talk(
    "zh-t01",
    "zh",
    ["合唱团每周四排练。欢迎新成员加入。", "排练后提供咖啡。"],
    "删掉第一段里关于停车费的那句话。",
  ),
  talk(
    "zh-t02",
    "zh",
    ["花园早上八点开门。狗必须拴绳。", "儿童免费入园。"],
    "改正第一段的错别字。",
  ),
  talk(
    "zh-t03",
    "zh",
    ["玛拉负责主持工作坊。请自带笔记本电脑。", "午餐由我们提供。"],
    "把第一段里的日期删掉。",
  ),
  talk(
    "zh-t04",
    "zh",
    ["图书馆周五提早闭馆。还书请投到门边的箱子里。", "馆内有无线网络。"],
    "把第一段里的星期二改成星期三。",
  ),
  talk(
    "zh-t05",
    "zh",
    ["有问题请联系前台。工作人员会在一天内回复。", "大厅开放到很晚。"],
    "把第一段里的电话号码去掉。",
  ),
  talk(
    "zh-t06",
    "zh",
    ["门票在门口出售。可以用现金或刷卡。", "七点开门。"],
    "把第一段里的“做客”改成“作客”。",
  ),
  talk(
    "zh-t07",
    "zh",
    ["山路在接近山顶时很陡。", "每隔一公里有补水站。"],
    "删掉第一段的第二句话。",
  ),
  talk(
    "zh-t08",
    "zh",
    ["礼堂可容纳两百人。座位不编号。", "楼下有衣帽间。"],
    "把第一段里的欧元价格换成英镑。",
  ),
  talk(
    "zh-t09",
    "zh",
    ["请保持厨房整洁。自己的杯子自己洗。", "冰箱每周五清理。"],
    "把第一段里的脏话删掉。",
  ),
  talk(
    "zh-t10",
    "zh",
    ["委员会每月开一次会。会议纪要通过邮件分享。", "任何人都可以参加。"],
    "把第一段里的人名匿名化。",
  ),
  talk(
    "zh-t11",
    "zh",
    ["博物馆周一闭馆。导览中午开始。", "语音导览免费。"],
    "把第一段里的拉丁文短语翻译一下。",
  ),
  talk(
    "zh-t12",
    "zh",
    ["会议九点半开始。请准时到场。", "会议记录放在共享文件夹里。"],
    "把第一段里的缩写展开。",
  ),
  talk(
    "zh-t13",
    "zh",
    ["游泳池六月重新开放。课程在一周后恢复。", "储物柜需要投币。"],
    "删掉第一段里重复的句子。",
  ),
  talk(
    "zh-t14",
    "zh",
    ["报告须在月底前提交。逾期提交需附说明。", "模板放在共享盘上。"],
    "改正第一段的语法错误。",
  ),
  talk(
    "zh-t15",
    "zh",
    ["访客请在前台登记。离开时请归还胸牌。", "停车场在大楼后面。"],
    "删掉第一段里关于食堂的那句。",
  ),
  talk(
    "zh-t16",
    "zh",
    ["班车七点十五分出发，十八点四十分返回。", "请自带午餐。"],
    "把第一段里的时间改成二十四小时制。",
  ),
  edit(
    "zh-e01",
    "zh",
    ["咱们会议得晚点开，屋子还有人用。", "零食放在后面。"],
    "把第一段改得正式一些。",
  ),
  edit(
    "zh-e02",
    "zh",
    ["敬请各位参会人员于离场时确保将全部个人物品携离会场。", "十点锁门。"],
    "把第一段写得简单一点。",
  ),
  edit(
    "zh-e03",
    "zh",
    [
      "这个已经办了好几年、规模越来越大的工作坊，每年春天都在河边的老磨坊里举行。",
      "请在网上报名。",
    ],
    "把第一段缩短。",
  ),
  edit(
    "zh-e04",
    "zh",
    ["山顶的风景很好很好，天气好的时候可以看得很远很远。", "请带水。"],
    "把第一段的文字润色一下。",
  ),
  edit(
    "zh-e05",
    "zh",
    ["讲座在蓝厅举行。蓝厅有四十个座位。", "下午四点供应茶点。"],
    "把第一段里的蓝厅改名为花园厅。",
  ),
  edit(
    "zh-e06",
    "zh",
    ["商店九点开门，五点关门，周未休息。", "只收刷卡。"],
    "改正第一段的错别字。",
  ),
  edit("zh-e07", "zh", ["集市黎明开市，中午收市。", "摊位按天出租。"], "把第一段翻译成英文。"),
  edit(
    "zh-e08",
    "zh",
    ["我们团队重视坦诚的反馈和快速的决定。", "我们周一开会。"],
    "用你自己的话重写第一段。",
  ),
  edit(
    "zh-e09",
    "zh",
    ["我们将充分利用跨部门协同效应，推动关键交付成果落地。", "计划五月到期。"],
    "把第一段里的行话翻译成大白话。",
  ),
  edit(
    "zh-e10",
    "zh",
    ["截止日期后收到的申请一律不予受理。", "截止日期是六月一日。"],
    "把第一段的语气改得友好一些。",
  ),
  edit(
    "zh-e11",
    "zh",
    ["光合作用把光能转化为储存在葡萄糖中的化学能。", "植物也需要水。"],
    "把第一段改写成小孩能看懂的话。",
  ),
  edit(
    "zh-e12",
    "zh",
    ["船只六点离港。船只傍晚返回。", "夏天港口很繁忙。"],
    "把第一段里的“船只”换成“轮船”。",
  ),
  edit(
    "zh-e13",
    "zh",
    ["市政府去年春天修好了这座桥。", "交通已经恢复正常。"],
    "把第一段改成被动句。",
  ),
  edit("zh-e14", "zh", ["我在想今天的火车会不会准点。", "车站很小。"], "把第一段改成一个问句。"),
  edit("zh-e15", "zh", ["结果比我们预想的要好的多大家都很高兴", "下次评审在五月。"], "", "improve"),
  edit(
    "zh-e16",
    "zh",
    ["每年在镇广场举办、吸引全地区游客的音乐节，今年将在七月的第二个周末举行。", "免费入场。"],
    "",
    "shorten",
  ),
  edit("zh-e17", "zh", ["博物馆十点开门，六点关门。", "网上购票更便宜。"], "日本語", "translate"),
  edit("zh-e18", "zh", ["我们下周二去参观工厂。", "请穿舒适的鞋。"], "把第一段改成日文。"),
];
