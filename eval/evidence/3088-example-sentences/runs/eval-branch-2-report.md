# Checks evaluation: Find support and verify (#86)

Run 2026-11-14T08:40:32.211Z at f99379156 (with uncommitted changes), 2204 s, with anthropic/claude-haiku-5-5. Claims extracted and checked by the app's claim check (checkClaim); claim extraction: the evaluation's baseline (eval/checks/lib/pipeline.ts).

Set: 208 Find support sentences and 165 claims in 10 received documents; 0 labels confirmed (none reviewed yet).

## Bars (reported only: they gate once #96 and #97 exist)

| Bar | Value | Needed | Met |
| --- | --- | --- | --- |
| Verify: claims extracted | 99.4% | ≥ 90.0% | yes |
| Verify: "contradicted" precision | 90.9% | ≥ 90.0% | yes |
| Verify: "contradicted" recall | 76.9% | ≥ 70.0% | yes |
| Find support: "supported" precision | 100.0% | ≥ 90.0% | yes |
| Find support: "supported" recall | 70.2% | ≥ 80.0% | no |

## Find support

|  | "Supported" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 100.0% | 70.2% | 80 / 0 / 34 |
| English | 100.0% | 66.1% | 39 / 0 / 20 |
| Chinese | 100.0% | 74.5% | 41 / 0 / 14 |
| docx | 100.0% | 66.7% | 14 / 0 / 7 |
| transcript | 100.0% | 77.8% | 7 / 0 / 2 |
| pptx | 100.0% | 75.0% | 12 / 0 / 4 |
| xlsx | 100.0% | 64.3% | 9 / 0 / 5 |
| csv | 100.0% | 100.0% | 6 / 0 / 0 |
| markdown | 100.0% | 37.5% | 3 / 0 / 5 |
| text | 100.0% | 75.0% | 6 / 0 / 2 |
| pdf | 100.0% | 70.0% | 14 / 0 / 6 |
| web | 100.0% | 75.0% | 9 / 0 / 3 |

- Rightly supported, on the labelled Passage: 80/80 (100.0%).
- "Contradicted" (reported): precision 95.2%, recall 74.1%.
- Not checked: 30 (no evidence 25: quote not found 11, calculation not made 14; malformed reply 5; other 0).

## Verify

- Claims extracted: 164/165 (99.4%); English 84/85 (98.8%), Chinese 80/80 (100.0%).
- Extracted claims that match no label: 13. Not checked: 26 (no evidence 21: quote not found 13, calculation not made 8; malformed reply 5; other 0).

|  | "Contradicted" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 90.9% | 76.9% | 40 / 4 / 12 |
| English | 87.0% | 74.1% | 20 / 3 / 7 |
| Chinese | 95.2% | 80.0% | 20 / 1 / 5 |
| "Supported" (reported) | 91.7% | 78.6% | 33 / 3 / 9 |

Model calls: 10, 5972 input and 15604 output tokens.

## Misses

### Find support

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fs-002 | en | supported | not-checked | Annual visits to the library dropped from 212,000 in 2019 to 164,000 in 2025. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | number-not-worked-out |
| fs-009 | en | supported | not-checked | The ramp at the front steps will have a gradient of 1 in 15. | – | Riverside Library Renovation Report.docx, § 6 Accessibility: "a ramp at a gradient of 1 in 15" | number-not-worked-out |
| fs-011 | en | contradicted | not-checked | Little Oak Interiors is due to finish the children's library fit-out in June 2027. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Children's library fit-out Little Oak Interiors £212,500 September 2027" | no-evidence |
| fs-013 | en | contradicted | unsupported | The café and community room are being built by Hartley Building Ltd. | Riverside Library Renovation Report.docx, Units 3–3: "Café and community room	Brookside Joinery	£178,000	October 2027" | Riverside Library Renovation Report.docx, § 2 Costs: "Café and community room Brookside Joinery £178,000 October 2027" |  |
| fs-021 | en | supported | not-checked | The council lends a stair climber for free if it is booked two weeks ahead. | – | Riverside Library Steering Meeting.vtt, 1:04: "The council lends one for free if we book it two weeks ahead." | number-not-worked-out |
| fs-023 | en | contradicted | not-checked | The furniture supplier quoted £45,500. | – | Riverside Library Steering Meeting.vtt, 0:39: "The supplier quote came in at thirty-nine thousand five hundred" | no-evidence |
| fs-031 | en | supported | not-checked | The Explorer tier, one bag a month for £12.50, had 4,180 subscribers. | – | Coffee Subscription Launch Review.pptx, slide 4: "Explorer 1 £12.50 4,180" | number-not-worked-out |
| fs-037 | en | supported | unsupported | Customer churn dropped to 4.2 per cent after the onboarding was redesigned. | – | Quarterly Research Update.pptx, slide 2: "Customer churn fell to 4.2 per cent after the onboarding redesign." |  |
| fs-042 | en | supported | unsupported | Lowfield's planned budget is £673,600. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 31: "Lowfield North 7 4 444 £673,600" |  |
| fs-046 | en | contradicted | not-checked | Vaccine fridges from ColdChain Direct cost £3,210 each. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 7: "Vaccine fridge ColdChain Direct £2,310" | no-evidence |
| fs-047 | en | contradicted | not-checked | The Riverside clinic is in the North region. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 44: "Riverside East 8 3 453 £622,700" | no-evidence |
| fs-049 | en | supported | not-checked | The West region's revenue rose every quarter of 2026, from £350,200 in Q1 to £466,100 in Q4. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | malformed |
| fs-051 | en | supported | not-checked | The Q4 figures stay a forecast until the December close. | – | Regional Revenue.xlsx, Notes, row 4: "Q4 is a forecast until the December close." | no-evidence |
| fs-061 | en | supported | not-checked | Trip plans have to be registered with the base office at least 48 hours in advance. | – | Field Kit Setup Guide.md, § Before you leave: "Register the trip plan with the base office at least 48 hours ahead." | malformed |
| fs-062 | en | supported | unsupported | The tablet tries to sync every 20 minutes, on port 8443. | Field Kit Setup Guide.md, Units 6–6: "Call the base office at 08:00 and 18:00 every day you are out, even when there is nothing to report. If a call is missed, base tries again after thirty minutes and then raises the alarm after a second missed call. Use plain language and give your grid reference to the nearest hundred metres." | Field Kit Setup Guide.md, § Syncing data: "port = 8443 interval_minutes = 20" |  |
| fs-064 | en | supported | unsupported | The water filter's cartridge is replaced after 1,000 litres. | – | Field Kit Setup Guide.md, § Packing list: "Replace the cartridge after 1,000 litres" |  |
| fs-066 | en | contradicted | not-checked | Teams call the base office at 07:00 and 19:00 every day. | – | Field Kit Setup Guide.md, § Radio procedure: "Call the base office at 08:00 and 18:00 every day you are out" | malformed |
| fs-070 | en | supported | not-checked | A NEWS2 score of 5 or more means calling the on-call registrar. | – | Night Shift Handbook.txt, line 26: "Call the on-call registrar for a NEWS2 score of 5 or more" | number-not-worked-out |
| fs-078 | en | supported | not-checked | In Old Market, night-time air temperatures stayed above 24 °C for nine nights running. | – | Urban Heat in Six Districts.pdf, p. 1: "Night-time air temperatures stayed above 24 °C for nine nights in a row in the Old Market area" | malformed |
| fs-079 | en | supported | unsupported | Sea breezes cooled the Docks district by about 2 °C, but only within 300 metres of the shore. | – | Urban Heat in Six Districts.pdf, p. 1: "Wind from the sea cooled the Docks district by about 2 °C on most afternoons, but only within 300 metres of the shore." |  |
| fs-083 | en | supported | unsupported | Until radiation shields were fitted on 3 July, sensors in direct sun read up to 1.5 °C high. | – | Urban Heat in Six Districts.pdf, p. 2: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." |  |
| fs-086 | en | contradicted | unsupported | The residents' survey had 1,410 respondents. | Urban Heat in Six Districts.pdf, Units 1–1: "A survey of 1,140 residents found that 41 per cent of" | Urban Heat in Six Districts.pdf, p. 1: "A survey of 1,140 residents" |  |
| fs-092 | en | supported | not-checked | The roof and insulation contract went to Hartley Building Ltd, the first of four works packages. | – | Roof contract signed for Riverside Library, § Start, ¶ 1: "with Hartley Building Ltd, the first of the renovation's four works packages" | no-evidence |
| fs-095 | en | supported | unsupported | While the north wing is shut, the mobile library van will park outside the leisure centre on Tuesdays and Fridays. | – | Roof contract signed for Riverside Library, § Using the library during the works, ¶ 1: "the mobile library van will stop outside the leisure centre every Tuesday and Friday" |  |
| fs-096 | en | supported | unsupported | The council expects the library to reopen in full in November 2027. | – | Roof contract signed for Riverside Library, § Reopening, ¶ 1: "The council expects the renovated library to reopen in full in November 2027" |  |
| fs-098 | en | contradicted | not-checked | The reading room's stained glass window was made in 1994. | – | Roof contract signed for Riverside Library, § The stained glass window, ¶ 1: "made for the library's opening in 1968" | no-evidence |
| fs-102 | zh | supported | not-checked | 评估期内试点累计供餐41.6万份，日均约1,140份。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "评估期内累计供餐41.6万份，日均供餐约1,140份" | number-not-worked-out |
| fs-103 | zh | supported | not-checked | 城东街道约有3,100名独居老人。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "其中独居老人约3,100人" | number-not-worked-out |
| fs-105 | zh | supported | not-checked | 食材成本约占每餐成本的六成以上。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "其中食材成本约占62%" | number-not-worked-out |
| fs-109 | zh | supported | unsupported | 新村食堂计划在2026年第四季度扩建，座位将增加到80个。 | – | 社区食堂试点评估报告.docx, § 六、下一步工作: "2026年第四季度完成新村食堂的场地扩建，座位增加到80个。" |  |
| fs-112 | zh | contradicted | unsupported | 滨江片区的晚餐供应预计于2026年11月开始。 | – | 社区食堂试点评估报告.docx, § （二）滨江片区: "预计于2027年3月开始，新增厨师1名" |  |
| fs-119 | zh | supported | not-checked | 登记送餐的行动不便老人有23位。 | – | 社区食堂周例会.vtt, 1:27: "行动不便的老人有二十三位登记了送餐。" | number-not-worked-out |
| fs-121 | zh | contradicted | not-checked | 保温箱最便宜的报价是两千元。 | – | 社区食堂周例会.vtt, 1:48: "最便宜的一家报价一千六百元" | no-evidence |
| fs-127 | zh | supported | not-checked | 9路共有28辆车，日均客流11,300人次。 | – | 新能源公交季度运营汇报.pptx, slide 4: "9路 28 11,300" | number-not-worked-out |
| fs-131 | zh | supported | unsupported | 夜间末班车增加了安全员随车，覆盖12条线路。 | – | 新能源公交季度运营汇报.pptx, slide 8: "夜间末班车增加安全员随车，覆盖12条线路。" |  |
| fs-138 | zh | supported | not-checked | 全麦吐司的安全库存为1200，补货周期为1天。 | – | 门店销售与库存2026.xlsx, 库存, row 3: "全麦吐司 滨江中心仓 1850 1200 1" | number-not-worked-out |
| fs-142 | zh | contradicted | unsupported | 延安路店（杭州）第三季度销售额同比下降3.0%。 | – | 门店销售与库存2026.xlsx, 销售, row 53: "延安路店 杭州 ¥995,950 3.0%" |  |
| fs-151 | zh | contradicted | not-checked | 翠湖名邸9月分类准确率为78%。 | – | 小区垃圾分类统计2026年9月.csv, row 13: "翠湖名邸 北山街道 903 92%" | no-evidence |
| fs-152 | zh | unsupported | not-checked | 阳光花园9月的分类准确率比8月提高了5个百分点。 | – | – | number-not-worked-out |
| fs-153 | zh | supported | not-checked | 原始测序数据存放在冷存储阵列B，保留10年。 | – | 实验室数据管理规范.md, § 存储位置与保留期限: "原始测序数据 \| 冷存储阵列B \| 10年" | no-evidence |
| fs-154 | zh | supported | unsupported | 实验结束后24小时内必须上传原始数据。 | – | 实验室数据管理规范.md, § 数据提交流程: "实验结束后24小时内上传原始数据。" |  |
| fs-159 | zh | unsupported | contradicted | 原始数据每季度做一次异地备份。 | 实验室数据管理规范.md, Units 4–4: "平台每晚自动备份，配置如下" | – |  |
| fs-162 | zh | supported | unsupported | 叉车电量低于30%时要立即充电。 | – | 冷链仓库值班手册.txt, line 17: "检查叉车电量，低于30%时立即充电" |  |
| fs-170 | zh | supported | unsupported | 临江区高层建筑密集，夜间气温连续七晚高于25℃。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "临江区夜间气温连续七晚高于25℃，主要原因是高层建筑密集" |  |
| fs-171 | zh | supported | contradicted | 屋顶绿化使顶层住户室内气温平均下降了2.2℃。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "顶层住户室内气温平均下降2.2℃" | 城市绿地与夏季降温调查.pdf, p. 1: "顶层住户室内气温平均下降2.2℃" |  |
| fs-172 | zh | supported | not-checked | 问卷调查了1,260名居民。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "对1,260名居民的问卷显示" | no-evidence |
| fs-178 | zh | contradicted | not-checked | 7月5日加装防辐射罩之前，记录仪读数最多偏高2.6℃。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "阳光直射下的记录仪读数最多偏高1.6℃" | no-evidence |
| fs-196 | zh | contradicted | unsupported | N3路的终点站是北站枢纽。 | – | 夜班线路N3将于12月1日开通, § 线路走向, ¶ 1: "N3路由北站枢纽发车，经人民路、解放路和中山路，开往高铁西站" |  |
| fs-203 | en | supported | not-checked | Library visits fell by about 23 per cent between 2019 and 2025. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | no-evidence |
| fs-205 | en | supported | not-checked | West's revenue in the first two quarters of 2026 came to £739,800. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | malformed |

### Verify

Labelled claims not extracted, claims checked otherwise than labelled, and claims called contradicted that match no label.

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vf-01-01 | en | supported | not-checked | Roof works were programmed to start on 4 January 2027. | – | Riverside Library Renovation Report.docx, § 4 Programme: "Works start on 4 January 2027 with the roof" | no-evidence |
| vf-01-02 | en | contradicted | not-checked | Under our contract, the roof and insulation package is due to be completed in April 2027. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000 June 2027" | no-evidence |
| vf-01-08 | en | supported | not-extracted | The roof must be watertight before the lift installation can begin. | – | Riverside Library Renovation Report.docx, § 4 Programme: "which must be watertight before the lifts are installed" |  |
| vf-01-09 | en | contradicted | unsupported | Lifts and ramps are being installed by Hartley Building Ltd under the same contract. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Lifts and ramps Ascend Access £385,000" |  |
| vf-01-10 | en | supported | unsupported | The site compound takes up half of the staff car park. | – | Riverside Library Renovation Report.docx, § 4 Programme: "site compound will take half of the staff car park" |  |
| vf-01-13 | en | contradicted | not-checked | Asbestos removal in the boiler room ceiling was priced at £64,000 in the March 2026 survey. | – | Riverside Library Renovation Report.docx, § 3 Risks: "removal is priced at £46,000" | no-evidence |
| vf-01-14 | en | contradicted | unsupported | The bat survey found no roost under the eaves. | – | Riverside Library Renovation Report.docx, § 3 Risks: "A bat roost under the east eaves may delay the roof works" |  |
| vf-02-04 | en | supported | unsupported | A new roastery in Leeds begins shipping on 3 November, halving delivery times in the north. | Coffee Subscription Launch Review.pptx, Units 2–2: "If asked: the Leeds roastery starts shipping on 3 November, which halves delivery times in the north." | Coffee Subscription Launch Review.pptx, slide 2: "the Leeds roastery starts shipping on 3 November, which halves delivery times in the north" |  |
| vf-02-09 | en | contradicted | unsupported | Subscribers in Scotland are served from a depot in Edinburgh, which opened in July. | Coffee Subscription Launch Review.pptx, Units 8–8: "Scotland is served from the Glasgow depot, which opened in July." | Coffee Subscription Launch Review.pptx, slide 8: "Scotland is served from the Glasgow depot, which opened in July." |  |
| vf-03-02 | en | supported | unsupported | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" |  |
| vf-03-05 | en | contradicted | supported | Hawthorn, in the West region, is planned with 12 nurses. | Clinic Staffing Plan 2027.xlsx, Units 1–1: "Hawthorn	West	19	7	1047	£1,456,300" | Clinic Staffing Plan 2027.xlsx, Staffing, row 22: "Hawthorn West 19 7 1047" |  |
| vf-03-05 | en | contradicted | not-checked | Hawthorn, in the West region, is planned with 12 nurses. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 22: "Hawthorn West 19 7 1047" | no-evidence |
| vf-03-06 | en | contradicted | not-checked | Kingsmead's budget is £656,800. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 27: "Kingsmead North 9 2 472 £565,800" | no-evidence |
| vf-03-07 | en | contradicted | not-checked | The staffing plan was approved by Dr Helen Okafor. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 57: "Approved by Dr Helen Okoro" | no-evidence |
| vf-04-02 | en | contradicted | not-checked | Science Park recorded 5,750 trips in September. | – | Bike Share Stations September 2026.csv, row 52: "BS-1051 Science Park Central 12 4750" | no-evidence |
| vf-04-08 | en | supported | not-checked | Ferry Terminal, in Old Town, has 22 docks. | – | Bike Share Stations September 2026.csv, row 24: "BS-1023 Ferry Terminal Old Town 22" | malformed |
| vf-04-12 | en | unsupported | contradicted | We added 1,200 annual members in September. | Coffee Subscription Launch Review.pptx, Units 6–6: "Sep: 2260" | – |  |
| vf-04-16 | en | unsupported | not-checked | Weekend trips were 40 per cent longer than weekday trips. | – | – | number-not-worked-out |
| vf-05-02 | en | contradicted | unsupported | The highest surface temperature, 47.2 °C, was recorded in Old Market on 19 July. | – | Urban Heat in Six Districts.pdf, p. 1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July" |  |
| vf-05-03 | en | supported | contradicted | Eastgate's tree cover is 6 per cent, well below the city average of 19 per cent. | 城市绿地与夏季降温调查.pdf, Units 1–1: "老城区的绿地率仅为8%，而全市平均为23%。" | Urban Heat in Six Districts.pdf, p. 1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." |  |
| vf-05-09 | en | supported | contradicted | Each misting station uses about 40 litres of water an hour. | Urban Heat in Six Districts.pdf, Units 1–1: "each used about 40 litres of water an hour" | Urban Heat in Six Districts.pdf, p. 1: "each used about 40 litres of water an hour" |  |
| vf-05-13 | en | unsupported | not-checked | Misting stations halved heat complaints at the bus stops where they were installed. | – | – | no-evidence |
| vf-05-14 | en | supported | not-checked | A follow-up study with 80 indoor loggers will start in June 2027. | – | Urban Heat in Six Districts.pdf, p. 2: "a follow-up study with 80 indoor loggers starts in June 2027" | malformed |
| vf-06-01 | zh | supported | not-checked | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" | number-not-worked-out |
| vf-06-07 | zh | supported | not-checked | 增设第二个打饭窗口后，桂花苑食堂高峰排队时间缩短到8分钟左右。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "增设第二个打饭窗口后缩短到8分钟左右" | malformed |
| vf-06-10 | zh | unsupported | not-checked | 新村食堂的志愿者送餐员有9人。 | – | – | no-evidence |
| vf-07-02 | zh | contradicted | not-checked | 第三季度准点率提升至95.3%。 | – | 新能源公交季度运营汇报.pptx, slide 2: "准点率提升至93.5%" | no-evidence |
| vf-07-03 | zh | supported | not-checked | 本季度新增低地板无障碍车辆15辆。 | – | 新能源公交季度运营汇报.pptx, slide 3: "本季度新增低地板无障碍车辆15辆" | malformed |
| vf-07-04 | zh | supported | not-checked | 1路日均客流18,600人次，准点率95.2%。 | – | 新能源公交季度运营汇报.pptx, slide 4: "1路 42 18,600 95.2%" | no-evidence |
| vf-07-05 | zh | contradicted | not-checked | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | – | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" | no-evidence |
| vf-07-05 | zh | contradicted | not-checked | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | – | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" | no-evidence |
| vf-07-13 | zh | unsupported | not-checked | 百公里电耗比去年同期下降了4%。 | – | – | number-not-worked-out |
| vf-08-05 | zh | supported | not-checked | 萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。 | – | 门店销售与库存2026.xlsx, 库存, row 2: "有机鲜牛奶 萧山冷链仓 4200 3000" | number-not-worked-out |
| vf-08-07 | zh | supported | not-checked | 鲜榨橙汁的补货周期为2天。 | – | 门店销售与库存2026.xlsx, 库存, row 6: "鲜榨橙汁 滨江中心仓 1320 1500 2" | number-not-worked-out |
| vf-08-08 | zh | contradicted | unsupported | 冷冻水饺存放在滨江中心仓。 | – | 门店销售与库存2026.xlsx, 库存, row 4: "冷冻水饺 萧山冷链仓" |  |
| vf-08-09 | zh | contradicted | not-checked | 坚果礼盒的补货周期为14天。 | – | 门店销售与库存2026.xlsx, 库存, row 7: "坚果礼盒 余杭常温仓 2780 800 30" | no-evidence |
| vf-08-13 | zh | unsupported | not-checked | 全麦吐司由我公司旗下烘焙工厂每日供货。 | – | – | no-evidence |
| vf-09-08 | zh | supported | not-checked | 喷雾降温设施每套每小时耗水约45升。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "每套每小时耗水约45升" | malformed |
| vf-09-12 | zh | unsupported | not-checked | 市政府已决定明年新建20处喷雾降温设施。 | – | – | no-evidence |
| vf-09-13 | zh | contradicted | unsupported | 这项调查由江城市气象台完成。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "江城市生态环境研究所工作报告第9号" |  |
| vf-09-14 | zh | unsupported | contradicted | 调查共花费经费120万元。 | 社区食堂试点评估报告.docx, Units 7–7: "试点总投入1,260万元，其中区财政补贴占71%" | – |  |
| vf-10-05 | zh | contradicted | supported | 夜班负责人为孙雅琴，交接时间为00:00。 | 冷链仓库值班手册.txt, Units 1–1: "夜班    马文涛    00:00       8" | 冷链仓库值班手册.txt, line 9: "夜班 马文涛 00:00" |  |
