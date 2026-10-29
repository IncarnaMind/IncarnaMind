# The finance and law Skills on anthropic/claude-sonnet-5-5

| Case | Skill | Language | Note | Citations | Found | Facts | Language | Verdict |
|---|---|---|---|---|---|---|---|---|
| covenant-summary-en | covenant-summary | en | yes | 16 | 16 | 5/5 | yes | pass |
| covenant-summary-zh | covenant-summary | zh-CN | yes | 10 | 10 | 5/5 | yes | pass |
| cim-red-flags-en | cim-red-flags | en | yes | 15 | 15 | 8/8 | yes | pass |
| cim-red-flags-zh | cim-red-flags | zh-CN | yes | 14 | 14 | 8/8 | yes | pass |
| earnings-review-en | earnings-review | en | yes | 32 | 32 | 9/10 | yes | fail |
| earnings-review-zh | earnings-review | zh-CN | yes | 39 | 39 | 10/10 | yes | pass |
| credit-memo-outline-en | credit-memo-outline | en | yes | 22 | 22 | 7/9 | yes | fail |
| credit-memo-outline-zh | credit-memo-outline | zh-CN | yes | 21 | 21 | 8/9 | yes | fail |
| deposition-summary-en | deposition-summary | en | no | 0 | 0 | 0/0 | no | fail |
| deposition-summary-zh | deposition-summary | zh-CN | yes | 24 | 24 | 9/9 | yes | pass |
| chronology-en | chronology | en | yes | 16 | 16 | 9/9 | yes | pass |
| chronology-zh | chronology | zh-CN | yes | 15 | 15 | 8/9 | yes | fail |

Spend: about $1.215.

## covenant-summary-en

Verdict: pass

Steps:

- use_skill {"name":"covenant-summary"}
- use_skill {"name":"covenant-summary"}
- add_to_mind {"mind":"Covenants","content":"# Halden Quay Logistics Limited — financial coven

Halden Quay Logistics Limited — financial covenants (senior facilities agreement, 14 February 2024)
The agreement covers a sterling term loan, Facility A, of £180,000,000  and a sterling revolving credit facility, Facility B, of £60,000,000 . The latest test is for the Relevant Period of twelve months from 1 October 2025 to 30 September 2026 . Covenants are tested on each Quarter Date .
Leverage (clause 7.1)
Test: the ratio of Consolidated Net Debt on the last day of the Relevant Period to EBITDA for that period .Level: Leverage must not exceed 3.25:1 .Latest figure: Leverage was 2.80:1, and the covenant was met .Headroom: calculated from the 3.25:1 level and the 2.80:1 figure, the margin is 0.45 turns of leverage.
Interest cover (clause 7.2)
Test: the ratio of EBITDA to Net Finance Charges, which are interest and other finance charges less interest received .Level: not less than 3.5:1 .Latest figure: 4.61:1 . The certificate states that the covenant was met .Headroom: calculated from the 4.61:1 figure and the 3.5:1 level, the margin is about 1.11.
Overall
The certificate states that no Event of Default is continuing .

### Citations

- facility-agreement · p. 3 · found · a sterling term loan facility in an aggregate amount of £180,000,000 ("Facility A")
- facility-agreement · p. 3 · found · a sterling revolving credit facility in an aggregate amount of £60,000,000 ("Facility B")
- compliance-certificate-q3-2026 · p. 2 · found · The Relevant Period is the twelve months from 1 October 2025 to 30 September 2026.
- facility-agreement · p. 4 · found · tested on each Quarter Date
- facility-agreement · p. 2 · found · the ratio of Consolidated Net Debt on the
  last day of that Relevant Period to EBITDA in respect of that Relevant Perio
- facility-agreement · p. 4 · found · does not
exceed 3.25:1
- compliance-certificate-q3-2026 · p. 3 · found · Leverage was therefore 2.80:1, against the level of no more than 3.25:1
   required by clause 7.1. The covenant was met.
- facility-agreement · p. 4 · found · does not
exceed 3.25:1
- compliance-certificate-q3-2026 · p. 3 · found · Leverage was therefore 2.80:1, against the level of no more than 3.25:1
   required by clause 7.1. The covenant was met.
- facility-agreement · p. 2 · found · the interest and other finance
  charges of the Group less interest received
- facility-agreement · p. 4 · found · the ratio of EBITDA to Net Finance Charges in
respect of each Relevant Period is not less than 3.5:1
- compliance-certificate-q3-2026 · p. 3 · found · The ratio of EBITDA to Net Finance Charges was therefore 4.61:1
- compliance-certificate-q3-2026 · p. 3 · found · The ratio of EBITDA to Net Finance Charges was therefore 4.61:1
- compliance-certificate-q3-2026 · p. 3 · found · The ratio of EBITDA to Net Finance Charges was therefore 4.61:1
- facility-agreement · p. 4 · found · the ratio of EBITDA to Net Finance Charges in
respect of each Relevant Period is not less than 3.5:1
- compliance-certificate-q3-2026 · p. 4 · found · No Event of Default is continuing as at the date of this certificate.

## covenant-summary-zh

Verdict: pass

Steps:

- use_skill {"name":"covenant-summary"}
- use_skill {"name":"covenant-summary"}
- create_mind {"title":"海川冷链财务约定总结","content":"# 海川冷链物流有限公司 — 优先级融资协议财务约定\n\n协议提供金额为人民币 1.8 亿元
- add_to_mind {"content":"# 海川冷链物流有限公司 — 优先级融资协议财务约定\n\n协议提供金额为人民币 1.8 亿元的定期贷款额度（甲类额度）[^1]，以及人

海川冷链物流有限公司 — 优先级融资协议财务约定
协议提供金额为人民币 1.8 亿元的定期贷款额度（甲类额度），以及人民币 6,000 万元的循环授信额度（乙类额度）。最近一次测试的相关期间为 2025 年 10 月 1 日至 2026 年 9 月 30 日的十二个月。
1. 杠杆率（第 7.1 条）
测试内容：相关期间最后一日集团合并净债务与该相关期间 EBITDA 之比。要求水平：每个相关期间不超过 3.25:1。最新数字：合规证明书载明杠杆率为 2.80:1，低于 3.25:1 上限，该项约定已满足。
2. 利息覆盖率（第 7.2 条）
测试内容：EBITDA 与净财务费用之比；净财务费用为利息及其他财务费用减去已收利息。要求水平：每个相关期间不低于 3.5:1。最新数字：合规证明书载明比率为 4.61:1，高于 3.5:1 下限，该项约定已满足。
结论
两项财务约定均已满足，证明书还声明不存在持续中的违约事件。

### Citations

- facility-agreement · p. 3 · found · 金额为人民币 1.8 亿元的定期贷款额度（“甲类额度”）
- facility-agreement · p. 3 · found · 金额为人民币 6,000 万元的循环授信额度（“乙类额度”）
- compliance-certificate-q3-2026 · p. 2 · found · 相关期间为 2025 年 10 月 1 日至 2026 年 9 月 30 日的十二个月。
- facility-agreement · p. 2 · found · “杠杆率”指某一相关期间最后一日集团的合并净债务与该相关期间 EBITDA 之比。
- facility-agreement · p. 4 · found · 公司应确保每个相关期间的杠杆率不超过 3.25:1。
- compliance-certificate-q3-2026 · p. 3 · found · 杠杆率为 2.80:1，低于第 7.1 条要求的 3.25:1 上限。该项约定已满足。
- facility-agreement · p. 2 · found · “净财务费用”指集团在某一相关期间的利息及其他财务费用减去已收利息，以合规证明书所载为准。
- facility-agreement · p. 4 · found · 不低于 3.5:1
- compliance-certificate-q3-2026 · p. 3 · found · EBITDA 与净财务费用之比为 4.61:1，高于第 7.2 条要求的 3.5:1 下限。该项约定已满足。
- compliance-certificate-q3-2026 · p. 4 · found · 不存在持续中的违约事件。

## cim-red-flags-en

Verdict: pass

Steps:

- use_skill {"name":"cim-red-flags"}
- use_skill {"name":"cim-red-flags"}
- create_mind {"title":"Red flags: Halden Quay CIM vs data room","content":"# Red flags: Halde

Red flags: Halden Quay Logistics CIM (January 2024) against the data room extracts
Summary. I checked 9 claims in the CIM's investment highlights. Six are contradicted by the data room, one has no evidence, one is a "never lost a major customer" claim with no evidence, and licences are supported (so not listed). The largest red flag is the growth claim, followed by customer concentration and EBITDA margin; together they undercut the equity story.
1. Revenue growth
The claim: "Revenue grew by 24% in each of the last three years".What the Documents show: the management accounts state "revenue grew by 7.2% in 2022 and by 14.2% in 2023".Why it is a red flag: contradicted. Both stated growth rates are well below 24%.
2. Customer concentration
The claim: "The group's largest customer accounts for 8% of revenue".What the Documents show: "Bracken Foods Limited: £88.9 million, 19.0% of revenue." The schedule also says "the ten largest customers accounted for 61.5% of revenue in 2023".Why it is a red flag: contradicted for 2023. Concentration is not low.
3. EBITDA margin
The claim: "Underlying EBITDA margin has been stable at 22% since 2021".What the Documents show: "the underlying EBITDA margin was 20.0% in 2021, 19.2% in 2022 and 17.5% in 2023".Why it is a red flag: contradicted. The margin was never 22% in the years shown, and it fell each year.
4. Litigation
The claim: "The group has no material litigation."What the Documents show: Pellow Foods Limited "has filed a claim in the High Court for £2.4 million". A former depot supervisor has also brought an employment tribunal claim, which the group is defending.Why it is a red flag: contradicted. The Pellow claim is above the £100,000 level the CIM cites in its "never had a claim above £100,000" statement (the claim is dated December 2023, before the CIM).
5. Freehold properties
The claim: "All of the group's properties are owned freehold".What the Documents show: only the Hull head office is freehold. "Goole cold store: leased from Ravensworth Estates Limited". Motherwell and Avonmouth are also leased in the same schedule.Why it is a red flag: contradicted. Three of the four sites are leased.
6. Fleet ownership
The claim: "The group owns its entire cold-chain fleet".What the Documents show: of the 40 trailers, "28 are owned outright and 12 are held under" finance leases. The group leases most tractor units from a haulage contractor.Why it is a red flag: contradicted for the trailers, and the tractor units are mostly leased too.
7. EBITDA target of £120 million by 2027
The claim: "Management expects EBITDA to reach £120 million by 2027".What the Documents show: the data room extracts hold no forecast, budget or Goole depot ramp-up plan. Reported 2023 underlying EBITDA is £82.0 million.Why it is a red flag: unsupported. The missing evidence is a management forecast and its assumptions. It also sits against falling margins.
8. "Never lost a major customer"
The claim: it is in the first highlight, with the growth claim.What the Documents show: no customer history or churn data. The aged debtors note does show over-60-day debtors of £6.2 million against £3.1 million a year earlier.Why it is a red flag: unsupported. A multi-year customer schedule is missing.
Checked and supported: the licence claim. The register shows licences current and none suspended in five years.

### Citations

- cim · p. 3 · found · Revenue grew by 24% in each of the last three years
- data-room-financials-and-customers · p. 2 · found · revenue grew by 7.2% in 2022 and by 14.2% in 2023
- cim · p. 3 · found · The group's largest customer accounts for 8% of revenue
- data-room-financials-and-customers · p. 3 · found · Bracken Foods Limited: £88.9 million, 19.0% of revenue.
- data-room-financials-and-customers · p. 3 · found · the ten largest customers accounted for 61.5% of revenue in 2023
- cim · p. 3 · found · Underlying EBITDA margin has been stable at 22% since 2021
- data-room-financials-and-customers · p. 2 · found · the underlying EBITDA margin was 20.0% in 2021, 19.2% in 2022 and 17.5% in 2023
- cim · p. 3 · found · The group has no material litigation.
- data-room-legal-property-fleet · p. 2 · found · has filed a claim in the High Court for £2.4 million
- cim · p. 3 · found · All of the group's properties are owned freehold
- data-room-legal-property-fleet · p. 3 · found · Goole cold store: leased from Ravensworth Estates Limited
- cim · p. 3 · found · The group owns its entire cold-chain fleet
- data-room-legal-property-fleet · p. 4 · found · 28 are owned outright and 12 are held under
- cim · p. 3 · found · Management expects EBITDA to reach £120 million by 2027
- cim · p. 3 · found · Revenue grew by 24% in each of the last three years

## cim-red-flags-zh

Verdict: pass

Steps:

- use_skill {"name":"cim-red-flags"}
- use_skill {"name":"cim-red-flags"}
- create_mind {"title":"海川冷链 CIM 红旗核查","content":"# 海川冷链保密信息备忘录（2024 年 1 月）红旗核查——对照数据室摘录\n\n**

海川冷链保密信息备忘录（2024 年 1 月）红旗核查——对照数据室摘录
概要： 共核查 8 项投资亮点，其中 6 项被数据室矛盾或不支持，另有 1 项（2027 年 EBITDA 目标）数据室无依据。最大的红旗是：CIM 称“最大客户占收入的 8%”，而管理账目显示最大客户占 19.0%。（“从未失去主要客户”及“全部证照”两项未发现矛盾，不列为红旗。）
1. 收入增长
CIM 的说法： “收入连续三年增长 24%”数据室显示： 账目载明“2022 年收入增长 7.2%，2023 年增长 14.2%”为何是红旗： 直接矛盾。实际增速远低于 24%，且数据室摘录中没有 24% 的年增长。
2. 客户集中度
CIM 的说法： “最大客户占收入的 8%”数据室显示（2023 年度）： “青禾食品有限公司：人民币 8,890 万元，占收入 19.0%”为何是红旗： 直接矛盾。最大客户占比为 19.0%，不是 8%；账目另列北原商贸 13.1%、嘉禾便利店 9.0%，前十大客户合计 61.5%，客户集中度并不低。
3. EBITDA 利润率
CIM 的说法： “EBITDA 利润率自 2021 年以来稳定在 22%”数据室显示： “EBITDA 利润率 2021 年为 20.0%，2022 年为 19.2%，2023 年为 17.5%”为何是红旗： 直接矛盾。利润率从未达到 22%，且逐年下降，并非“稳定”。
4. 诉讼
CIM 的说法： “集团没有重大诉讼，从未有超过 10 万元的索赔”数据室显示（2023 年 12 月 15 日法律更新）： 培罗食品有限公司提起诉讼，“索赔人民币 240 万元”，称嘉兴冷库温度失控致货物变质；另有一名原仓库主管提起违法解除劳动合同仲裁，集团正在应诉为何是红旗： 直接矛盾。存在远超 10 万元的未决索赔和一项劳动仲裁。
5. 物业自有
CIM 的说法： “集团全部物业均为自有”数据室显示（2023 年 12 月物业清单）： 只有“嘉兴总部：自有。”；嘉兴、佛山、天津冷库均为租赁，例如“天津冷库：向津门物流园有限公司租赁”为何是红旗： 直接矛盾。四个站点中仅总部自有，其余三处冷库为租赁，成本基础并非全部固定。
6. 车队自有
CIM 的说法： “集团拥有全部冷链车队”数据室显示（2023 年 12 月车队清单）： 40 辆冷藏挂车中“其中 28 辆为自有，12 辆为融资租赁”；牵引车仅自有 6 辆，其余向运输公司租赁为何是红旗： 矛盾。部分挂车为融资租赁，多数牵引车为租赁，并非全部拥有。
7. 2027 年 EBITDA 目标
CIM 的说法： “管理层预计 2027 年 EBITDA 达到 1.2 亿元”数据室显示： 数据室摘录中没有预算、预测或新仓建设计划等文件。为何是红旗： 无依据（缺少管理层预测模型及假设）。参考背景：2023 年 EBITDA 为 8,200 万元且利润率下降，这一目标是否可达尚无证据。
其他观察（非 CIM 直接说法）
数据室显示，超过 60 天的应收账款由 310 万元升至 620 万元，账目归因于两家零售客户和付款条件变化。CIM 未提及此事。

### Citations

- cim · p. 3 · found · **收入连续三年增长 24%**
- data-room-financials-and-customers · p. 2 · found · 2022 年收入增长 7.2%，2023 年增长 14.2%
- cim · p. 3 · found · **最大客户占收入的 8%**
- data-room-financials-and-customers · p. 3 · found · 青禾食品有限公司：人民币 8,890 万元，占收入 19.0%
- cim · p. 3 · found · **EBITDA 利润率自 2021 年以来稳定在 22%**
- data-room-financials-and-customers · p. 2 · found · EBITDA 利润率 2021 年为 20.0%，2022 年为 19.2%，2023 年为 17.5%
- cim · p. 3 · found · **集团没有重大诉讼**，从未有超过 10 万元的索赔
- data-room-legal-property-fleet · p. 2 · found · 索赔人民币 240 万元
- cim · p. 3 · found · **集团全部物业均为自有**
- data-room-legal-property-fleet · p. 3 · found · 嘉兴总部：自有。
- data-room-legal-property-fleet · p. 3 · found · 天津冷库：向津门物流园有限公司租赁
- cim · p. 3 · found · **集团拥有全部冷链车队**
- data-room-legal-property-fleet · p. 4 · found · 其中 28 辆为自有，12 辆为融资租赁
- cim · p. 3 · found · **管理层预计 2027 年 EBITDA 达到 1.2 亿元**

## earnings-review-en

Verdict: fail

- The note does not state /57\.2/.

Steps:

- use_skill {"name":"earnings-review"}
- use_skill {"name":"earnings-review"}
- add_to_mind {"content":"# Halden Quay Logistics — Q3 2026 review\n\nRevenue grew and EBITDA 

Halden Quay Logistics — Q3 2026 review
Revenue grew and EBITDA rose, but gross margin fell, mainly because of energy costs. Full-year guidance is unchanged. Q3 is the 13 weeks to 26 September 2026 and the figures are unaudited.
The quarter
Revenue: £142.6 million, up 8.1% on Q3 2025 Gross margin: 27.4%, down from 29.1% a year earlier Underlying EBITDA: £19.8 million Net debt at quarter end: £196.4 million ; net debt to EBITDA was 2.8 times, on last-twelve-month EBITDA Nine months to Q3: revenue £401.2 million . This is a year-to-date figure, not a quarter's.
Against the prior period
MeasureQ3 2026Change vs Q3 2025Change vs Q2 2026Revenue£142.6m+£10.7 million (8.1% as reported) +£4.2 million, +3.0% (Q2: £138.4m) Gross margin27.4%-1.7 percentage points (29.1%) -0.6 percentage points (Q2: 28.0%) Underlying EBITDA£19.8m+£1.7 million, +9.4%+£0.7 million, +3.7% (Q2: £19.1m) Net debt£196.4mnot given+£2.6 million (Q2: £193.8m) 
The Q3 2025 EBITDA comparative (£18.1 million) comes from the Q3 statement. The changes are calculated from the figures cited. Q2 2026 is the previous quarter.
Against guidance
Guidance for the full year is revenue of £550 million to £570 million and underlying EBITDA of £74 million to £78 million . It is unchanged from the guidance given with the half-year results on 30 July 2026 .Capital expenditure is expected to be about £38 million, including the Goole depot .Revenue: after nine months, the guidance implies Q4 revenue of £148.8 million to £168.8 million (calculated from the guidance and the nine-month figure) . The Documents don't say whether that is on track.Underlying EBITDA: the nine-month figure is in the Q3 Document, but I haven't compared it with the guided range. The Documents give no verdict on delivery against guidance.
What drove it
Cold-store energy costs rose again, and the group absorbed most of the increase rather than pass it on in full .The new Goole depot opened in July and traded in line with plan .The Bracken Foods contract, signed in May, added volume from August .The CEO said margin is not where expected, and energy is most of the reason .
What to watch
Margin pressure from energy costs, which the group is absorbing .Whether Goole and Bracken volume can lift revenue to the guided range, which the CEO says gives volume to grow into next year .Net debt rose from the Q2 level .Segment, profit and cash figures are not in the Documents.

### Citations

- q3-2026-results · p. 2 · found · Group revenue was £142.6 million, up 8.1% on the third quarter of 2025, when it was £131.9
- q3-2026-results · p. 2 · found · Group gross margin was 27.4%, down from 29.1% a year earlier.
- q3-2026-results · p. 2 · found · Underlying EBITDA was £19.8
- q3-2026-results · p. 2 · found · Net debt was £196.4 million at the end
- q3-2026-results · p. 2 · found · net debt to EBITDA was 2.8
- q3-2026-results · p. 2 · found · Revenue for the first nine months of 2026 was £401.2 million
- q3-2026-results · p. 2 · found · Group revenue was £142.6 million, up 8.1% on the third quarter of 2025, when it was £131.9
- q3-2026-results · p. 2 · found · when it was £131.9
million
- q2-2026-results · p. 2 · found · Group revenue was £138.4 million, up 7.4% on the second quarter of 2025.
- q3-2026-results · p. 2 · found · Group revenue was £142.6 million
- q3-2026-results · p. 2 · found · Group gross margin was 27.4%, down from 29.1% a year earlier.
- q2-2026-results · p. 2 · found · Group gross margin was
28.0%
- q3-2026-results · p. 2 · found · Group gross margin was 27.4%, down from 29.1% a year earlier.
- q3-2026-results · p. 2 · found · Underlying EBITDA was £19.8
million
- q3-2026-results · p. 2 · found · against £18.1 million in the third quarter of 2025
- q2-2026-results · p. 2 · found · Underlying EBITDA was £19.1 million
- q3-2026-results · p. 2 · found · Underlying EBITDA was £19.8
million
- q2-2026-results · p. 2 · found · Net debt was £193.8 million at the end of the quarter.
- q3-2026-results · p. 2 · found · Net debt was £196.4 million at the end
- q3-2026-results · p. 4 · found · The board expects full-year revenue of £550 million to £570 million and underlying EBITDA of £74
- q3-2026-results · p. 4 · found · This is the guidance given with the half-year results on 30 July 2026,
- q3-2026-results · p. 4 · found · Capital expenditure for the year is expected to be about £38 million, including the
- q3-2026-results · p. 4 · found · full-year revenue of £550 million
- q3-2026-results · p. 4 · found · to £570 million
- q3-2026-results · p. 2 · found · Revenue for the first nine months of 2026 was £401.2 million
- q3-2026-results · p. 3 · found · Cold-store energy costs rose again, and the group absorbed most of the increase rather than pass it
- q3-2026-results · p. 3 · found · The new Goole depot opened in July and traded in line with plan.
- q3-2026-results · p. 3 · found · The
contract with
Bracken Foods, signed in May, added volume from August.
- q3-2026-results · p. 4 · found · Margin is not, and energy is most of
- q3-2026-results · p. 3 · found · Cold-store energy costs rose again, and the group absorbed most of the increase rather than pass it
- q3-2026-results · p. 4 · found · Margin is not, and energy is most of
- q3-2026-results · p. 2 · found · Net debt was £196.4 million at the end

## earnings-review-zh

Verdict: pass

Steps:

- use_skill {"name":"earnings-review"}
- use_skill {"name":"earnings-review"}
- create_mind {"title":"第三季度回顾","content":"# 海川冷链物流有限公司 — 2026 年第三季度业绩回顾\n\n## 摘要\n\n第三季度（13 周

海川冷链物流有限公司 — 2026 年第三季度业绩回顾
摘要
第三季度（13 周，截至 2026 年 9 月 26 日，未经审计）收入同比增长，EBITDA 也高于上年同期，但毛利率同比下降。全年指引与 7 月 30 日半年度业绩给出的指引一致，未作调整。
一、本季度数据
收入：人民币 14,260 万元，比 2025 年第三季度的 13,190 万元增长 8.1%毛利率：27.4%，上年同期为 29.1%EBITDA：人民币 1,980 万元，上年同期为 1,810 万元季度末净债务：人民币 19,640 万元；过去十二个月 EBITDA 为人民币 7,010 万元，净债务与 EBITDA 之比为 2.8 倍前九个月累计（非单季）：收入人民币 40,120 万元，EBITDA 人民币 5,720 万元
二、与前一期对比
同比（2025 年第三季度）
收入增长 8.1%。EBITDA 增加 170万元，增幅 9.4%（根据中两个数字计算）。毛利率变动 -1.7个百分点（根据中两个数字计算）。
环比（2026 年第二季度）
指标第二季度第三季度变动收入（万元）13,84014,260+420万元，+3.0%毛利率28.0%27.4%-0.6个百分点EBITDA（万元）1,9101,980+70万元，+3.7%季度末净债务（万元）19,38019,640+260万元
环比变动均为根据两份文档的数字计算所得。
三、与业绩指引对比
全年指引（2026 年 7 月 30 日半年度业绩给出，第三季度未调整）：收入人民币 5.5 亿元至 5.7 亿元，EBITDA 人民币 7,400 万元至 7,800 万元。前九个月收入 40,120 万元，相当于指引下限的 72.9%、上限的 70.4%；前九个月 EBITDA 5,720 万元，相当于指引下限的 77.3%、上限的 73.3%（均为计算所得）。文档没有给出第四季度的单独指引，也没有说明目前是“符合”“高于”还是“低于”指引。上述占比只能说明进度，不能据此推断结论。全年资本开支预计约为人民币 3,800 万元，包括嘉兴新仓。
四、变动原因
冷库能源成本继续上升，集团承担了大部分涨幅，未全部转嫁给客户。嘉兴新仓于 7 月启用，经营情况符合计划。5 月与青禾食品签订的合同从 8 月起带来业务量。首席执行官韩素梅表示：“业务量符合预期，利润率不符合，主要原因是能源成本。”上一季度同样把能源成本称为利润率的主要压力。
五、需关注事项
能源成本：利润率不符合预期，主要原因是能源成本；部分成本涨幅未转嫁给客户。增长动力：管理层称嘉兴新仓和青禾食品合同为明年增长提供业务量。文档未提供分部数据、经营利润或净利润，因此本回顾不涉及这些指标。

### Citations

- q3-2026-results · p. 4 · found · 该指引与 2026 年 7 月 30 日半年度业绩给出的指引一致，未作调整
- q3-2026-results · p. 2 · found · 集团收入为人民币 14,260 万元，比 2025 年第三季度的 13,190 万元增长 8.1%
- q3-2026-results · p. 2 · found · 集团毛利率为 27.4%，低于上年同期的 29.1%
- q3-2026-results · p. 2 · found · 息税折旧摊销前利润（EBITDA）为人民币 1,980 万元，上年同期为 1,810 万元
- q3-2026-results · p. 2 · found · 季度末净债务为人民币 19,640 万元，过去十二个月 EBITDA 为人民币 7,010 万元，净债务与 EBITDA 之比为 2.8 倍
- q3-2026-results · p. 2 · found · 2026 年前九个月收入为人民币 40,120 万元，EBITDA 为人民币 5,720 万元
- q3-2026-results · p. 2 · found · 集团收入为人民币 14,260 万元，比 2025 年第三季度的 13,190 万元增长 8.1%
- q3-2026-results · p. 2 · found · 息税折旧摊销前利润（EBITDA）为人民币 1,980 万元，上年同期为 1,810 万元
- q3-2026-results · p. 2 · found · 集团毛利率为 27.4%，低于上年同期的 29.1%
- q2-2026-results · p. 2 · found · 集团收入为人民币 13,840 万元，比 2025 年第二季度增长 7.4%
- q3-2026-results · p. 2 · found · 集团收入为人民币 14,260 万元，比 2025 年第三季度的 13,190 万元增长 8.1%
- q3-2026-results · p. 2 · found · 集团收入为人民币 14,260 万元，比 2025 年第三季度的 13,190 万元增长 8.1%
- q2-2026-results · p. 2 · found · 集团收入为人民币 13,840 万元，比 2025 年第二季度增长 7.4%
- q2-2026-results · p. 2 · found · 集团毛利率为 28.0%，低于上年同期的 29.4%
- q3-2026-results · p. 2 · found · 集团毛利率为 27.4%，低于上年同期的 29.1%
- q3-2026-results · p. 2 · found · 集团毛利率为 27.4%，低于上年同期的 29.1%
- q2-2026-results · p. 2 · found · 集团毛利率为 28.0%，低于上年同期的 29.4%
- q2-2026-results · p. 2 · found · EBITDA 为人民币 1,910 万元，上年同期为 1,790 万元。季度末净债务为人民币 19,380 万元
- q3-2026-results · p. 2 · found · 息税折旧摊销前利润（EBITDA）为人民币 1,980 万元，上年同期为 1,810 万元
- q3-2026-results · p. 2 · found · 息税折旧摊销前利润（EBITDA）为人民币 1,980 万元，上年同期为 1,810 万元
- q2-2026-results · p. 2 · found · EBITDA 为人民币 1,910 万元，上年同期为 1,790 万元。季度末净债务为人民币 19,380 万元
- q2-2026-results · p. 2 · found · EBITDA 为人民币 1,910 万元，上年同期为 1,790 万元。季度末净债务为人民币 19,380 万元
- q3-2026-results · p. 2 · found · 季度末净债务为人民币 19,640 万元，过去十二个月 EBITDA 为人民币 7,010 万元，净债务与 EBITDA 之比为 2.8 倍
- q3-2026-results · p. 2 · found · 季度末净债务为人民币 19,640 万元，过去十二个月 EBITDA 为人民币 7,010 万元，净债务与 EBITDA 之比为 2.8 倍
- q2-2026-results · p. 2 · found · EBITDA 为人民币 1,910 万元，上年同期为 1,790 万元。季度末净债务为人民币 19,380 万元
- q3-2026-results · p. 4 · found · 董事会预计全年收入为人民币 5.5 亿元至 5.7 亿元，EBITDA 为人民币 7,400 万元至 7,800 万元
- q3-2026-results · p. 4 · found · 该指引与 2026 年 7 月 30 日半年度业绩给出的指引一致，未作调整
- q3-2026-results · p. 2 · found · 2026 年前九个月收入为人民币 40,120 万元，EBITDA 为人民币 5,720 万元
- q3-2026-results · p. 2 · found · 2026 年前九个月收入为人民币 40,120 万元，EBITDA 为人民币 5,720 万元
- q3-2026-results · p. 4 · found · 董事会预计全年收入为人民币 5.5 亿元至 5.7 亿元，EBITDA 为人民币 7,400 万元至 7,800 万元
- q3-2026-results · p. 4 · found · 全年资本开支预计约为人民币 3,800 万元，包括嘉兴新仓
- q3-2026-results · p. 3 · found · 冷库能源成本继续上升，集团承担了大部分涨幅，未全部转嫁给客户
- q3-2026-results · p. 3 · found · 嘉兴新仓于 7 月启用，经营情况符合计划
- q3-2026-results · p. 3 · found · 5 月与青禾食品签订的合同从 8 月起带来业务量
- q3-2026-results · p. 4 · found · 业务量符合预期，利润率不符合，主要原因是能源成本
- q2-2026-results · p. 3 · found · 上半年经营符合董事会预期，能源成本是利润率的主要压力
- q3-2026-results · p. 4 · found · 业务量符合预期，利润率不符合，主要原因是能源成本
- q3-2026-results · p. 3 · found · 冷库能源成本继续上升，集团承担了大部分涨幅，未全部转嫁给客户
- q3-2026-results · p. 4 · found · 业务量符合预期，利润率不符合，主要原因是能源成本

## credit-memo-outline-en

Verdict: fail

- The note does not state /Merrowgate/.

- The note does not state /Bracken|19(?:\.0)?\s*%|customer/i.

Steps:

- use_skill {"name":"credit-memo-outline"}
- add_to_mind {"content":"# Credit committee paper: Halden Quay Logistics Limited, £240 millio

Credit committee paper: Halden Quay Logistics Limited, £240 million senior facilities
Executive summary
Halden Quay Logistics Limited is a cold-chain logistics group. The group seeks £240 million of senior facilities to refinance existing debt, fund the Goole depot and provide working capital. The latest covenant tests are met, with leverage at 2.80:1. The main risk visible in the Documents is margin pressure from energy costs. Management's EBITDA target of £120 million by 2027 sits far above current guidance of £74 million to £78 million for the year.
Borrower and group
The group is owned 62% by Marta Halden, founder and chief executive, and 38% by Kestrel Capital Partners.
Transaction
Facility A: a sterling term loan of £180,000,000.Facility B: a sterling revolving credit facility of £60,000,000.Purpose: general corporate purposes, including refinancing existing debt and cold-store capex.Termination Date: 14 February 2029. Each Loan is repaid in full on that date.
Financial analysis
Q3 2026 net debt was £196.4 million. Gross margin fell to 27.4% from 29.1% a year earlier.
CovenantLevelQ3 2026Leveragemax 3.25:12.80:1Interest covermin 3.5:14.61:1
No Event of Default is continuing.
Risks and mitigants
Energy costs: they rose again and the group absorbed most of the increase. The Documents give no mitigant.Forecast risk: the CIM's £120 million EBITDA target compares with FY2026 guidance of £74 million to £78 million.
Recommendation
The Documents don't state a request for approval. The decision is for the committee.

### Citations

- cim · p. 2 · found · is a cold-chain logistics group that stores, handles and distributes
- cim · p. 4 · found · The group seeks £240 million of senior facilities to refinance its existing debt
- compliance-certificate-q3-2026 · p. 3 · found · Leverage was therefore 2.80:1
- q3-2026-results · p. 3 · found · Cold-store energy costs rose again
- cim · p. 3 · found · Management expects EBITDA to reach £120 million by 2027
- q3-2026-results · p. 4 · found · underlying EBITDA of £74
million to £78 million
- cim · p. 2 · found · owned 62% by its founder and chief executive, Marta Halden, and 38% by Kestrel Capital
- facility-agreement · p. 3 · found · a sterling term loan facility in an aggregate amount of £180,000,000 ("Facility A")
- facility-agreement · p. 3 · found · a sterling revolving credit facility in an aggregate amount of £60,000,000 ("Facility B")
- facility-agreement · p. 3 · found · including the refinancing of its existing debt and capital expenditure on cold-store capacity
- facility-agreement · p. 2 · found · "Termination Date" means 14 February 2029.
- facility-agreement · p. 5 · found · The Company shall repay each Loan in full on the Termination Date.
- q3-2026-results · p. 2 · found · Net debt was £196.4 million at the end
of the quarter
- q3-2026-results · p. 2 · found · Group gross margin was 27.4%, down from 29.1% a year earlier
- facility-agreement · p. 4 · found · Leverage in respect of each Relevant Period does not
exceed 3.25:1.
- compliance-certificate-q3-2026 · p. 3 · found · Leverage was therefore 2.80:1
- facility-agreement · p. 4 · found · is not less than 3.5:1
- compliance-certificate-q3-2026 · p. 3 · found · was therefore 4.61:1
- compliance-certificate-q3-2026 · p. 4 · found · No Event of Default is continuing
- q3-2026-results · p. 3 · found · Cold-store energy costs rose again
- cim · p. 3 · found · Management expects EBITDA to reach £120 million by 2027
- q3-2026-results · p. 4 · found · underlying EBITDA of £74
million to £78 million

## credit-memo-outline-zh

Verdict: fail

- The note does not state /澜石银行/.

Steps:

- use_skill {"name":"credit-memo-outline"}
- use_skill {"name":"credit-memo-outline"}
- create_mind {"title":"授信报告","content":"# 海川冷链物流有限公司 — 优先级融资信贷委员会报告提纲\n\n## 1. 执行摘要\n\n- 借款人：

海川冷链物流有限公司 — 优先级融资信贷委员会报告提纲
1. 执行摘要
借款人：海川冷链物流有限公司，冷链物流集团。融资：集团拟取得人民币 2.4 亿元优先级融资，用于现有债务再融资、嘉兴新仓建设和营运资金。主要风险：能源成本上升压低毛利率，且 EBITDA 低于 CIM 披露的上年水平（见第 5 节）。
2. 借款人与集团
业务：集团经营四个站点和 40 辆冷藏挂车，总部位于嘉兴。股东：创始人兼首席执行官韩素梅持股 62%，凯岭资本持股 38%。管理层：董事长为黎志远，财务总监为沈瑜。客户集中度：CIM 称最大客户占收入的 8%。
3. 交易
甲类额度：金额为人民币 1.8 亿元的定期贷款额度；已偿还部分不得再借。乙类额度：金额为人民币 6,000 万元的循环授信额度。用途：集团的一般经营用途，包括现有债务的再融资和冷库产能的资本开支。到期日：2029 年 2 月 14 日。财务约定：杠杆率不超过 3.25:1；利息覆盖率不低于 3.5:1。
4. 财务分析
契约测试（相关期间 2025 年 10 月 1 日至 2026 年 9 月 30 日）
杠杆率 2.80:1，低于上限，已满足。利息覆盖率 4.61:1，高于下限，已满足。合规证明书称不存在持续中的违约事件。
经营数据
2026 年第三季度 EBITDA 为人民币 1,980 万元，上年同期为 1,810 万元。毛利率 27.4%，低于上年同期的 29.1%。过去十二个月 EBITDA 为人民币 7,010 万元；2023 年 EBITDA 为人民币 8,200 万元（CIM）。全年指引：EBITDA 为人民币 7,400 万元至 7,800 万元。所有业绩数字均未经审计。
5. 风险与缓释
能源成本：冷库能源成本继续上升，集团承担了大部分涨幅，未全部转嫁给客户。文档未给出针对该风险的缓释措施。盈利下滑：过去十二个月 EBITDA（7,010 万元）低于 2023 年（8,200 万元），而 CIM 的预期是 2027 年 EBITDA 达到 1.2 亿元。这一缺口值得委员会关注。
6. 建议
文档没有写明具体的审批申请，决定由信贷委员会作出。

### Citations

- cim · p. 4 · found · 集团拟取得人民币 2.4 亿元优先级融资，用于现有债务再融资、嘉兴新仓建设和营运资金。
- cim · p. 2 · found · 集团经营四个站点和 40 辆冷藏挂车，总部位于嘉兴。
- cim · p. 2 · found · 集团由创始人兼首席执行官韩素梅持股 62%，凯岭资本持股 38%
- cim · p. 2 · found · 董事长为黎志远，财务总监为沈瑜。
- cim · p. 3 · found · **最大客户占收入的 8%**，客户集中度低。
- facility-agreement · p. 3 · found · 金额为人民币 1.8 亿元的定期贷款额度（“甲类额度”）
- facility-agreement · p. 5 · found · 甲类额度已偿还的部分不得再借。
- facility-agreement · p. 3 · found · 金额为人民币 6,000 万元的循环授信额度（“乙类额度”）
- facility-agreement · p. 3 · found · 包括现有债务的再融资和冷库产能的资本开支
- facility-agreement · p. 2 · found · “到期日”指 2029 年 2 月 14 日。
- facility-agreement · p. 4 · found · 公司应确保每个相关期间的杠杆率不超过 3.25:1。
- facility-agreement · p. 4 · found · 7.2 利息覆盖率。
- compliance-certificate-q3-2026 · p. 3 · found · 杠杆率为 2.80:1，低于第 7.1 条要求的 3.25:1 上限。该项约定已满足。
- compliance-certificate-q3-2026 · p. 3 · found · EBITDA 与净财务费用之比为 4.61:1，高于第 7.2 条要求的 3.5:1 下限。该项约定已满足。
- compliance-certificate-q3-2026 · p. 4 · found · 不存在持续中的违约事件
- q3-2026-results · p. 2 · found · EBITDA）为人民币 1,980 万元，上年同期为 1,810 万元
- q3-2026-results · p. 2 · found · 集团毛利率为 27.4%，低于上年同期的 29.1%
- q3-2026-results · p. 2 · found · 过去十二个月 EBITDA 为人民币 7,010 万元
- cim · p. 5 · found · EBITDA 为人民币 8,200 万元
- q3-2026-results · p. 4 · found · EBITDA 为人民币 7,400 万元至 7,800 万元
- q3-2026-results · p. 3 · found · 冷库能源成本继续上升，集团承担了大部分涨幅，未全部转嫁给客户。

## deposition-summary-en

Verdict: fail

- The Skill answered in the panel instead of writing a note.

Steps:

- use_skill {"name":"deposition-summary"}
- use_skill {"name":"deposition-summary"}

(no note)

### Citations

None.

## deposition-summary-zh

Verdict: pass

Steps:

- use_skill {"name":"deposition-summary"}
- add_to_mind {"content":"# 林嘉禾证词摘要（2026 年 3 月 12 日，远岚科技诉青禾健康技术服务合同仲裁案）\n\n林嘉禾是青禾健康系统有限公司的前运营总

林嘉禾证词摘要（2026 年 3 月 12 日，远岚科技诉青禾健康技术服务合同仲裁案）
林嘉禾是青禾健康系统有限公司的前运营总监，在明州仲裁委员会（案号：明仲裁字〔2024〕第 018 号）作证。本笔录为节选，仅含第 12 页至第 17 页，涉及合同与交付、延迟原因、9 月仪表盘、终止和索赔金额。
一、证人身份与职责
2023 年 3 月至 2023 年 11 月任运营总监（第 12 页第 4 行）。自称是远岚科技账户的日常联系人，从签约到她离职（第 12 页第 8 行）。
二、合同与首次交付
合同于 2023 年 3 月 3 日签订；她未在场，但看过签署本（第 13 页第 2 行）。青禾健康承诺的服务：“为远岚科技的仓库网络提供数据分析服务，每月 4 万元。”（第 13 页第 4 行）工作说明书写明首次交付日为 2023 年 6 月 30 日（第 13 页第 6 行）。实际交付日为 2023 年 7 月 28 日（第 13 页第 8 行）。
三、延迟原因
她称：“远岚科技提供仓库数据晚了。没有数据我们无法搭建。”（第 13 页第 10 行）她记得向对方索要数据是在 2023 年 5 月（第 14 页第 2 行）。经提问，她确认 2023 年 6 月 12 日的邮件是她发的（第 14 页第 5–6 行）。邮件中有“我们还没有开始搭建。”一句（第 14 页第 7 行）。她答：“邮件是这么写的。我不记得延迟全部是远岚科技造成的。”（第 14 页第 10 行）
冲突： 她在第 13 页第 10 行称延迟是因远岚科技数据晚了，但在第 14 页第 10 行说不记得延迟全部由远岚科技造成；6 月 12 日邮件称青禾健康尚未开始搭建。
四、9 月仪表盘
她承认：“9 月的仪表盘不符合要求。这一点我承认。”（第 15 页第 4 行）问题是库存数字没有刷新，团队在 2023 年 10 月 2 日之前修好（第 15 页第 6 行）。她在 10 月 2 日告诉远岚科技修复已经上线（第 15 页第 8 行）。
五、合同终止
终止通知日期为 2023 年 11 月 6 日，她在 11 月 7 日看到（第 16 页第 2 行）。青禾健康不接受，认为是违约终止，且“合同没有为此规定终止权”（第 16 页第 4 行）。青禾健康于 2023 年 11 月 7 日停止工作（第 16 页第 6 行）。被问是否提出继续履行，她答：“我不记得提出过继续履行。”（第 16 页第 8 行）
六、索赔与费用
对远岚科技索赔 31 万元的计算方式，她答：“我不知道他们怎么计算的。”（第 17 页第 2 行）青禾健康的人员和平台成本“大约 18 万元”（第 17 页第 4 行）。关于退款，她答：“我不记得退过费用。”（第 17 页第 6 行） 被问是否有人与她讨论过退款，她答“我不记得。”（第 17 页第 8 行）

### Citations

- deposition-lin-jiahe · p. 2 · found · 我从 2023 年 3 月到 2023 年 11 月担任运营总监。
- deposition-lin-jiahe · p. 2 · found · 从签约到我离职，我是日常联系人。
- deposition-lin-jiahe · p. 3 · found · 2023 年 3 月 3 日签订。我没有在场，但我看过签署本。
- deposition-lin-jiahe · p. 3 · found · 为远岚科技的仓库网络提供数据分析服务，每月 4 万元。
- deposition-lin-jiahe · p. 3 · found · 工作说明书写的是 2023 年 6 月 30 日。
- deposition-lin-jiahe · p. 3 · found · 没有。我们在 2023 年 7 月 28 日交付。
- deposition-lin-jiahe · p. 3 · found · 远岚科技提供仓库数据晚了。没有数据我们无法搭建。
- deposition-lin-jiahe · p. 4 · found · 我记得是 2023 年 5 月。
- deposition-lin-jiahe · p. 4 · found · 是我发的。
- deposition-lin-jiahe · p. 4 · found · 邮件里写“我们还没有开始搭建。”你看到了吗？
- deposition-lin-jiahe · p. 4 · found · 邮件是这么写的。我不记得延迟全部是远岚科技造成的。
- deposition-lin-jiahe · p. 3 · found · 远岚科技提供仓库数据晚了。没有数据我们无法搭建。
- deposition-lin-jiahe · p. 4 · found · 邮件是这么写的。我不记得延迟全部是远岚科技造成的。
- deposition-lin-jiahe · p. 4 · found · 邮件里写“我们还没有开始搭建。”你看到了吗？
- deposition-lin-jiahe · p. 5 · found · 9 月的仪表盘不符合要求。这一点我承认。
- deposition-lin-jiahe · p. 5 · found · 库存数字没有刷新。团队在 2023 年 10 月 2 日之前修好了。
- deposition-lin-jiahe · p. 5 · found · 我在 10 月 2 日告诉他们修复已经上线。
- deposition-lin-jiahe · p. 6 · found · 通知日期是 2023 年 11 月 6 日。我在 11 月 7 日看到。
- deposition-lin-jiahe · p. 6 · found · 不接受。我们认为这是违约终止。合同没有为此规定终止权。
- deposition-lin-jiahe · p. 6 · found · 停止了，2023 年 11 月 7 日。
- deposition-lin-jiahe · p. 6 · found · 我不记得提出过继续履行。
- deposition-lin-jiahe · p. 7 · found · 我不知道他们怎么计算的。
- deposition-lin-jiahe · p. 7 · found · 人员成本和平台成本大约 18 万元。
- deposition-lin-jiahe · p. 7 · found · 我不记得退过费用。

## chronology-en

Verdict: pass

Steps:

- use_skill {"name":"chronology"}
- add_to_mind {"content":"# Chronology: Ravensworth Analytics Ltd v Kestrel Health Systems Ltd

Chronology: Ravensworth Analytics Ltd v Kestrel Health Systems Ltd (Claim No. KB-2024-000418), record of contract, correspondence and filings
3 March 2023: Services agreement between Ravensworth and Kestrel is dated. 1 April 2023: Agreement takes effect, with an initial term of 12 months. 14 April 2023: Ravensworth issues purchase order RA-2023-017. 12 June 2023: Dana Whitlock (Kestrel) writes to Ravensworth: "We have not yet started the build." 30 June 2023: First delivery due under the agreement. 28 July 2023: Kestrel's delivery note records the first dashboard as delivered on this date. 2 August 2023: Kestrel's letter says delivery "took place on 29 July 2023". This differs from the delivery note's 28 July 2023. 19 September 2023: Ravensworth complains by email that the dashboard's stock figures were not refreshing. 2 October 2023: Dana Whitlock's email says the fix was live. 6 November 2023: Ravensworth's termination notice is dated. 7 November 2023: The covering email sending the notice is dated. 22 January 2024: Claim form issued. 18 March 2024: Kestrel serves its defence. 5 June 2024: Court makes a case management order.  It lists disclosure for 28 February 2025, witness statements for 30 May 2025 and trial for 14 July 2026. 
Undated
File note of a call between Dana Whitlock and Ravensworth's operations manager about the September dashboard. 

### Citations

- record-contract-correspondence-filings · p. 2 · found · is dated 3
March 2023
- record-contract-correspondence-filings · p. 2 · found · It took effect on 1 April 2023 and had an initial term of 12 months.
- record-contract-correspondence-filings · p. 3 · found · Ravensworth issued purchase order RA-2023-017 on 14 April 2023.
- record-contract-correspondence-filings · p. 4 · found · We have not yet
started the build.
- record-contract-correspondence-filings · p. 2 · found · the
first delivery was due on 30 June 2023
- record-contract-correspondence-filings · p. 5 · found · records that the first dashboard was delivered on 28
July 2023
- record-contract-correspondence-filings · p. 6 · found · took place on 29 July 2023
- record-contract-correspondence-filings · p. 7 · found · the dashboard's stock figures were not
refreshing
- record-contract-correspondence-filings · p. 8 · found · says that the fix was live
- record-contract-correspondence-filings · p. 9 · found · is dated 6 November 2023
- record-contract-correspondence-filings · p. 9 · found · The covering email that sent it is dated
7 November 2023.
- record-contract-correspondence-filings · p. 10 · found · The claim form was issued on 22 January 2024.
- record-contract-correspondence-filings · p. 11 · found · Kestrel served its defence on 18 March 2024.
- record-contract-correspondence-filings · p. 12 · found · The court made a case management order on 5 June 2024.
- record-contract-correspondence-filings · p. 12 · found · disclosure for 28 February 2025,
witness statements for 30 May 2025 and trial for 14 July 2026
- record-contract-correspondence-filings · p. 13 · found · The note gives no date for the call.

## chronology-zh

Verdict: fail

- The note does not state /2023\s*年\s*11\s*月\s*7\s*日/.

Steps:

- use_skill {"name":"chronology"}
- use_skill {"name":"chronology"}
- create_mind {"title":"事件时间线","content":"# 远岚科技与青禾健康技术服务合同争议仲裁案（明仲裁字〔2024〕第 018 号）事件时间线\n\n记录

远岚科技与青禾健康技术服务合同争议仲裁案（明仲裁字〔2024〕第 018 号）事件时间线
记录范围：《事件记录 — 合同、往来函件与仲裁文件》。
2023 年 3 月 3 日：远岚科技与青禾健康签订技术服务合同。2023 年 4 月 1 日：合同生效，初始期限 12 个月。2023 年 4 月 14 日：远岚科技发出采购订单 RA-2023-017。2023 年 6 月 12 日：青禾健康运营总监林嘉禾致函远岚科技，称“我们还没有开始搭建。”2023 年 6 月 30 日：合同原定的第一次交付日期。2023 年 7 月 28 日：青禾健康交付单载明第一个仪表盘已于当日交付。2023 年 8 月 2 日：青禾健康函件称交付“已于 2023 年 7 月 29 日完成”。该日期与交付单的 7 月 28 日不同。2023 年 9 月 19 日：远岚科技通过电子邮件投诉仪表盘库存数字没有刷新。2023 年 10 月 2 日：林嘉禾的电子邮件称修复已经上线。2023 年 11 月 6 日 / 7 日：远岚科技的终止通知日期为 11 月 6 日，发送该通知的电子邮件日期为 11 月 7 日，两者不同。2024 年 1 月 22 日：仲裁申请提交。2024 年 3 月 18 日：青禾健康提交答辩。2024 年 6 月 5 日：仲裁庭作出案件管理令。2025 年 2 月 28 日、2025 年 5 月 30 日、2026 年 7 月 14 日：案件管理令确定的证据交换、证人陈述和开庭日期。
无日期
一份内部备忘记录了林嘉禾与远岚科技运营经理关于 9 月仪表盘的一次电话，备忘未写明通话日期。

### Citations

- record-contract-correspondence-filings · p. 2 · found · 技术服务合同日期为 2023 年 3 月 3 日
- record-contract-correspondence-filings · p. 2 · found · 合同自 2023 年 4 月 1 日起生效，初始期限 12 个月
- record-contract-correspondence-filings · p. 3 · found · 远岚科技于 2023 年 4 月 14 日发出采购订单 RA-2023-017
- record-contract-correspondence-filings · p. 4 · found · 我们还没有开始搭建。
- record-contract-correspondence-filings · p. 2 · found · 第一次交付原定于 2023 年 6 月 30 日
- record-contract-correspondence-filings · p. 5 · found · 第一个仪表盘已于 2023 年 7 月 28 日交付
- record-contract-correspondence-filings · p. 6 · found · 交付“已于 2023 年 7 月 29 日完成”
- record-contract-correspondence-filings · p. 7 · found · 仪表盘的库存数字没有刷新
- record-contract-correspondence-filings · p. 8 · found · 修复已经上线
- record-contract-correspondence-filings · p. 9 · found · 远岚科技的终止通知日期为 2023 年 11 月 6 日。发送该通知的电子邮件日期为 2023 年 11 月 7 日。
- record-contract-correspondence-filings · p. 10 · found · 仲裁申请于 2024 年 1 月 22 日提交
- record-contract-correspondence-filings · p. 11 · found · 青禾健康于 2024 年 3 月 18 日提交答辩
- record-contract-correspondence-filings · p. 12 · found · 仲裁庭于 2024 年 6 月 5 日作出案件管理令
- record-contract-correspondence-filings · p. 12 · found · 证据交换日期为 2025 年 2 月 28 日，证人陈述日期为 2025 年 5 月 30 日，开庭日期为 2026 年 7 月 14 日
- record-contract-correspondence-filings · p. 13 · found · 该备忘没有写明通话日期
