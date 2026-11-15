# Checks evaluation: Find support and verify (#86)

Run 2026-11-14T06:50:15.858Z at b283bc51c (with uncommitted changes), 2195 s, with anthropic/claude-haiku-5-5. Claims extracted and checked by the app's claim check (checkClaim); claim extraction: the evaluation's baseline (eval/checks/lib/pipeline.ts).

Set: 208 Find support sentences and 165 claims in 10 received documents; 0 labels confirmed (none reviewed yet).

## Bars (reported only: they gate once #96 and #97 exist)

| Bar | Value | Needed | Met |
| --- | --- | --- | --- |
| Verify: claims extracted | 100.0% | ≥ 90.0% | yes |
| Verify: "contradicted" precision | 89.1% | ≥ 90.0% | no |
| Verify: "contradicted" recall | 94.2% | ≥ 70.0% | yes |
| Find support: "supported" precision | 100.0% | ≥ 90.0% | yes |
| Find support: "supported" recall | 70.2% | ≥ 80.0% | no |

## Find support

|  | "Supported" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 100.0% | 70.2% | 80 / 0 / 34 |
| English | 100.0% | 71.2% | 42 / 0 / 17 |
| Chinese | 100.0% | 69.1% | 38 / 0 / 17 |
| docx | 100.0% | 61.9% | 13 / 0 / 8 |
| transcript | 100.0% | 66.7% | 6 / 0 / 3 |
| pptx | 100.0% | 75.0% | 12 / 0 / 4 |
| xlsx | 100.0% | 57.1% | 8 / 0 / 6 |
| csv | 100.0% | 100.0% | 6 / 0 / 0 |
| markdown | 100.0% | 50.0% | 4 / 0 / 4 |
| text | 100.0% | 75.0% | 6 / 0 / 2 |
| pdf | 100.0% | 75.0% | 15 / 0 / 5 |
| web | 100.0% | 83.3% | 10 / 0 / 2 |

- Rightly supported, on the labelled Passage: 80/80 (100.0%).
- "Contradicted" (reported): precision 94.1%, recall 88.9%.
- Not checked: 23 (no evidence 20: quote not found 6, calculation not made 14; malformed reply 3; other 0).

## Verify

- Claims extracted: 165/165 (100.0%); English 85/85 (100.0%), Chinese 80/80 (100.0%).
- Extracted claims that match no label: 10. Not checked: 22 (no evidence 18: quote not found 10, calculation not made 8; malformed reply 4; other 0).

|  | "Contradicted" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 89.1% | 94.2% | 49 / 6 / 3 |
| English | 86.7% | 96.3% | 26 / 4 / 1 |
| Chinese | 92.0% | 92.0% | 23 / 2 / 2 |
| "Supported" (reported) | 93.1% | 64.3% | 27 / 2 / 15 |

Model calls: 10, 5972 input and 15464 output tokens.

## Misses

### Find support

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fs-004 | en | supported | not-checked | Ascend Access is delivering the lifts and ramps for £385,000. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Lifts and ramps Ascend Access £385,000" | no-evidence |
| fs-006 | en | supported | not-checked | The north wing will close for eleven weeks from 1 February 2027. | – | Riverside Library Renovation Report.docx, § 2.1 North wing: "Temporary closure starts on 1 February 2027 and lasts eleven weeks." | no-evidence |
| fs-008 | en | supported | not-checked | Longer opening hours were the change most requested in the consultation, by 62 per cent of respondents. | – | Riverside Library Renovation Report.docx, § 5 Consultation findings: "The most requested change was longer opening hours, named by 62 per cent of respondents." | malformed |
| fs-013 | en | contradicted | not-checked | The café and community room are being built by Hartley Building Ltd. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Café and community room Brookside Joinery £178,000 October 2027" | no-evidence |
| fs-019 | en | supported | contradicted | The opening hours survey drew 380 responses. | Riverside Library Steering Meeting.vtt, Units 1–1: "We had three hundred and eighty responses to the survey." | Riverside Library Steering Meeting.vtt, 1:17: "We had three hundred and eighty responses to the survey." |  |
| fs-021 | en | supported | unsupported | The council lends a stair climber for free if it is booked two weeks ahead. | – | Riverside Library Steering Meeting.vtt, 1:04: "The council lends one for free if we book it two weeks ahead." |  |
| fs-031 | en | supported | not-checked | The Explorer tier, one bag a month for £12.50, had 4,180 subscribers. | – | Coffee Subscription Launch Review.pptx, slide 4: "Explorer 1 £12.50 4,180" | number-not-worked-out |
| fs-037 | en | supported | unsupported | Customer churn dropped to 4.2 per cent after the onboarding was redesigned. | – | Quarterly Research Update.pptx, slide 2: "Customer churn fell to 4.2 per cent after the onboarding redesign." |  |
| fs-041 | en | supported | not-checked | Barnsfield, in the East region, plans for 13 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 4: "Barnsfield East 13 7 813 £1,206,700" | no-evidence |
| fs-042 | en | supported | unsupported | Lowfield's planned budget is £673,600. | Clinic Staffing Plan 2027.xlsx, Units 1–1: "Lowfield	North	7	4	444	£673,600" | Clinic Staffing Plan 2027.xlsx, Staffing, row 31: "Lowfield North 7 4 444 £673,600" |  |
| fs-044 | en | supported | not-checked | Forty examination couches are due in November 2026. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 5: "Examination couch Wardrobe Healthcare £640 40 November 2026" | no-evidence |
| fs-049 | en | supported | not-checked | The West region's revenue rose every quarter of 2026, from £350,200 in Q1 to £466,100 in Q4. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | malformed |
| fs-053 | en | contradicted | unsupported | Q1 closed late because of a payroll migration. | – | Regional Revenue.xlsx, Notes, row 2: "Q1 closed two days late because of the ledger migration." |  |
| fs-054 | en | unsupported | not-checked | The South region has the smallest sales team. | – | – | no-evidence |
| fs-062 | en | supported | unsupported | The tablet tries to sync every 20 minutes, on port 8443. | Field Kit Setup Guide.md, Units 6–6: "Call the base office at 08:00 and 18:00 every day you are out, even when there is nothing to report. If a call is missed, base tries again after thirty minutes and then raises the alarm after a second missed call. Use plain language and give your grid reference to the nearest hundred metres." | Field Kit Setup Guide.md, § Syncing data: "port = 8443 interval_minutes = 20" |  |
| fs-064 | en | supported | unsupported | The water filter's cartridge is replaced after 1,000 litres. | – | Field Kit Setup Guide.md, § Packing list: "Replace the cartridge after 1,000 litres" |  |
| fs-070 | en | supported | not-checked | A NEWS2 score of 5 or more means calling the on-call registrar. | – | Night Shift Handbook.txt, line 26: "Call the on-call registrar for a NEWS2 score of 5 or more" | malformed |
| fs-079 | en | supported | unsupported | Sea breezes cooled the Docks district by about 2 °C, but only within 300 metres of the shore. | – | Urban Heat in Six Districts.pdf, p. 1: "Wind from the sea cooled the Docks district by about 2 °C on most afternoons, but only within 300 metres of the shore." |  |
| fs-083 | en | supported | unsupported | Until radiation shields were fitted on 3 July, sensors in direct sun read up to 1.5 °C high. | – | Urban Heat in Six Districts.pdf, p. 2: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." |  |
| fs-086 | en | contradicted | unsupported | The residents' survey had 1,410 respondents. | Urban Heat in Six Districts.pdf, Units 1–1: "A survey of 1,140 residents found that 41 per cent of" | Urban Heat in Six Districts.pdf, p. 1: "A survey of 1,140 residents" |  |
| fs-098 | en | contradicted | unsupported | The reading room's stained glass window was made in 1994. | – | Roof contract signed for Riverside Library, § The stained glass window, ¶ 1: "made for the library's opening in 1968" |  |
| fs-102 | zh | supported | not-checked | 评估期内试点累计供餐41.6万份，日均约1,140份。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "评估期内累计供餐41.6万份，日均供餐约1,140份" | number-not-worked-out |
| fs-103 | zh | supported | not-checked | 城东街道约有3,100名独居老人。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "其中独居老人约3,100人" | number-not-worked-out |
| fs-104 | zh | supported | not-checked | 滨江食堂由邻里膳坊运营，满意度为89%。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "滨江食堂 邻里膳坊 215 89%" | no-evidence |
| fs-105 | zh | supported | not-checked | 食材成本约占每餐成本的六成以上。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "其中食材成本约占62%" | number-not-worked-out |
| fs-109 | zh | supported | not-checked | 新村食堂计划在2026年第四季度扩建，座位将增加到80个。 | – | 社区食堂试点评估报告.docx, § 六、下一步工作: "2026年第四季度完成新村食堂的场地扩建，座位增加到80个。" | no-evidence |
| fs-119 | zh | supported | not-checked | 登记送餐的行动不便老人有23位。 | – | 社区食堂周例会.vtt, 1:27: "行动不便的老人有二十三位登记了送餐。" | number-not-worked-out |
| fs-127 | zh | supported | not-checked | 9路共有28辆车，日均客流11,300人次。 | – | 新能源公交季度运营汇报.pptx, slide 4: "9路 28 11,300" | number-not-worked-out |
| fs-130 | zh | supported | unsupported | 现金支付的比例比去年下降了5个百分点。 | – | 新能源公交季度运营汇报.pptx, slide 7: "现金支付比例比去年下降了5个百分点。" |  |
| fs-138 | zh | supported | not-checked | 全麦吐司的安全库存为1200，补货周期为1天。 | – | 门店销售与库存2026.xlsx, 库存, row 3: "全麦吐司 滨江中心仓 1850 1200 1" | number-not-worked-out |
| fs-144 | zh | contradicted | not-checked | 坚果礼盒库存为7,280。 | – | 门店销售与库存2026.xlsx, 库存, row 7: "坚果礼盒 余杭常温仓 2780" | no-evidence |
| fs-154 | zh | supported | unsupported | 实验结束后24小时内必须上传原始数据。 | – | 实验室数据管理规范.md, § 数据提交流程: "实验结束后24小时内上传原始数据。" |  |
| fs-155 | zh | supported | unsupported | 超过200GB的单个文件要先联系平台工程师分卷。 | – | 实验室数据管理规范.md, § 数据提交流程: "单个文件超过200GB时，须先联系平台工程师分卷。" |  |
| fs-162 | zh | supported | not-checked | 叉车电量低于30%时要立即充电。 | – | 冷链仓库值班手册.txt, line 17: "检查叉车电量，低于30%时立即充电" | number-not-worked-out |
| fs-169 | zh | supported | not-checked | 调查在江城市五个城区测量了地表温度和气温。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "我们在江城市五个城区测量了地表温度和气温" | no-evidence |
| fs-171 | zh | supported | contradicted | 屋顶绿化使顶层住户室内气温平均下降了2.2℃。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "屋顶绿化单位面积成本最高，但顶层住户室内气温平均下降2.2℃。" | 城市绿地与夏季降温调查.pdf, p. 1: "顶层住户室内气温平均下降2.2℃" |  |
| fs-172 | zh | supported | contradicted | 问卷调查了1,260名居民。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "对1,260名居民的问卷显示，老城区有46%的受访者在高温天改变了步行路线，全市平均为19%。" | 城市绿地与夏季降温调查.pdf, p. 1: "对1,260名居民的问卷显示" |  |
| fs-189 | zh | supported | unsupported | N3路每天晚上10点到次日凌晨5点运营。 | – | 夜班线路N3将于12月1日开通, § Start, ¶ 1: "每天晚上10点至次日凌晨5点运营" |  |
| fs-191 | zh | supported | not-checked | N3路夜间每30分钟发一班车。 | – | 夜班线路N3将于12月1日开通, § 线路走向, ¶ 2: "夜间发车间隔为30分钟" | no-evidence |
| fs-196 | zh | contradicted | unsupported | N3路的终点站是北站枢纽。 | – | 夜班线路N3将于12月1日开通, § 线路走向, ¶ 1: "N3路由北站枢纽发车，经人民路、解放路和中山路，开往高铁西站" |  |
| fs-205 | en | supported | not-checked | West's revenue in the first two quarters of 2026 came to £739,800. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | number-not-worked-out |

### Verify

Labelled claims not extracted, claims checked otherwise than labelled, and claims called contradicted that match no label.

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vf-01-02 | en | contradicted | unsupported | Under our contract, the roof and insulation package is due to be completed in April 2027. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000 June 2027" |  |
| vf-01-03 | en | supported | not-checked | Our contract for the roof and insulation package is valued at £1,240,000. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000" | no-evidence |
| vf-02-04 | en | supported | unsupported | A new roastery in Leeds begins shipping on 3 November, halving delivery times in the north. | Coffee Subscription Launch Review.pptx, Units 2–2: "If asked: the Leeds roastery starts shipping on 3 November, which halves delivery times in the north." | Coffee Subscription Launch Review.pptx, slide 2: "the Leeds roastery starts shipping on 3 November, which halves delivery times in the north" |  |
| vf-02-06 | en | supported | contradicted | Customers named freshness as the feature they liked best. | Coffee Subscription Launch Review.pptx, Units 3–3: "Freshness was the most praised feature, named in one comment in three." | Coffee Subscription Launch Review.pptx, slide 3: "Freshness was the most praised feature" |  |
| vf-02-09 | en | contradicted | unsupported | Subscribers in Scotland are served from a depot in Edinburgh, which opened in July. | Coffee Subscription Launch Review.pptx, Units 8–8: "Scotland is served from the Glasgow depot, which opened in July." | Coffee Subscription Launch Review.pptx, slide 8: "Scotland is served from the Glasgow depot, which opened in July." |  |
| vf-02-13 | en | unsupported | not-checked | The boxes are fully compostable. | – | – | no-evidence |
| vf-03-01 | en | supported | not-checked | Your 2027 staffing plan sets a total budget of £50,929,200. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 56: "Total budget £50,929,200" | no-evidence |
| vf-03-02 | en | supported | not-checked | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" | malformed |
| vf-03-04 | en | supported | not-checked | Marsh End, a South region clinic, is planned at 350 weekly hours. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 33: "Marsh End South 6 2 350" | no-evidence |
| vf-03-04 | en | supported | unsupported | Marsh End, a South region clinic, is planned at 350 weekly hours. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 33: "Marsh End South 6 2 350" |  |
| vf-03-05 | en | contradicted | supported | Hawthorn, in the West region, is planned with 12 nurses. | Clinic Staffing Plan 2027.xlsx, Units 1–1: "Hawthorn	West	19	7	1047	£1,456,300" | Clinic Staffing Plan 2027.xlsx, Staffing, row 22: "Hawthorn West 19 7 1047" |  |
| vf-03-08 | en | supported | not-checked | The plan is due for review on 30 November 2026. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 58: "Review date 2026-11-30" | no-evidence |
| vf-04-02 | en | contradicted | not-checked | Science Park recorded 5,750 trips in September. | – | Bike Share Stations September 2026.csv, row 52: "BS-1051 Science Park Central 12 4750" | no-evidence |
| vf-04-08 | en | supported | not-checked | Ferry Terminal, in Old Town, has 22 docks. | – | Bike Share Stations September 2026.csv, row 24: "BS-1023 Ferry Terminal Old Town 22" | no-evidence |
| vf-04-08 | en | supported | not-checked | Ferry Terminal, in Old Town, has 22 docks. | – | Bike Share Stations September 2026.csv, row 24: "BS-1023 Ferry Terminal Old Town 22" | malformed |
| vf-04-10 | en | unsupported | not-checked | E-bikes made up 35 per cent of the fleet in September. | – | – | number-not-worked-out |
| vf-05-02 | en | contradicted | unsupported | The highest surface temperature, 47.2 °C, was recorded in Old Market on 19 July. | – | Urban Heat in Six Districts.pdf, p. 1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July" |  |
| vf-05-03 | en | supported | contradicted | Eastgate's tree cover is 6 per cent, well below the city average of 19 per cent. | Urban Heat in Six Districts.pdf, Units 1–1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." | Urban Heat in Six Districts.pdf, p. 1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." |  |
| vf-05-09 | en | supported | contradicted | Each misting station uses about 40 litres of water an hour. | Urban Heat in Six Districts.pdf, Units 1–1: "Misting stations cooled the air within five metres by up to 3.1 °C, but each used about 40 litres of water an hour." | Urban Heat in Six Districts.pdf, p. 1: "each used about 40 litres of water an hour" |  |
| vf-05-14 | en | supported | contradicted | A follow-up study with 80 indoor loggers will start in June 2027. | Urban Heat in Six Districts.pdf, Units 2–2: "We did not measure indoor temperatures... a follow-up study with 80 indoor loggers starts in June 2027." | Urban Heat in Six Districts.pdf, p. 2: "a follow-up study with 80 indoor loggers starts in June 2027" |  |
| vf-06-01 | zh | supported | not-checked | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" | no-evidence |
| vf-06-01 | zh | supported | not-checked | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" | number-not-worked-out |
| vf-06-02 | zh | contradicted | not-checked | 新村食堂日均供餐210份，满意度达到92%。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "新村食堂 禾丰餐饮公司 150 86%" | no-evidence |
| vf-06-03 | zh | supported | not-checked | 老年居民每餐自付8元，其余部分由区财政补贴。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "老年居民每餐自付8元，其余部分由区财政补贴。" | no-evidence |
| vf-06-05 | zh | supported | not-checked | 食材统一由区农产品配送中心采购配送。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "食材采购统一由区农产品配送中心负责。" | malformed |
| vf-06-07 | zh | supported | not-checked | 增设第二个打饭窗口后，桂花苑食堂高峰排队时间缩短到8分钟左右。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "增设第二个打饭窗口后缩短到8分钟左右" | malformed |
| vf-06-10 | zh | unsupported | not-checked | 新村食堂的志愿者送餐员有9人。 | – | – | no-evidence |
| vf-07-02 | zh | contradicted | unsupported | 第三季度准点率提升至95.3%。 | 新能源公交季度运营汇报.pptx, Units 2–2: "准点率提升至93.5%。" | 新能源公交季度运营汇报.pptx, slide 2: "准点率提升至93.5%" |  |
| vf-07-04 | zh | supported | not-checked | 1路日均客流18,600人次，准点率95.2%。 | – | 新能源公交季度运营汇报.pptx, slide 4: "1路 42 18,600 95.2%" | number-not-worked-out |
| vf-07-05 | zh | contradicted | not-checked | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | – | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" | no-evidence |
| vf-07-05 | zh | contradicted | unsupported | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | 新能源公交季度运营汇报.pptx, Units 2–2: "如被问到：第二座充电站将于2027年1月投入使用，位于北站枢纽。" | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" |  |
| vf-07-13 | zh | unsupported | not-checked | 百公里电耗比去年同期下降了4%。 | – | – | number-not-worked-out |
| vf-08-07 | zh | supported | not-checked | 鲜榨橙汁的补货周期为2天。 | – | 门店销售与库存2026.xlsx, 库存, row 6: "鲜榨橙汁 滨江中心仓 1320 1500 2" | no-evidence |
| vf-09-08 | zh | supported | contradicted | 喷雾降温设施每套每小时耗水约45升。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "喷雾降温设施可使周边五米内气温降低最多3.4℃，但每套每小时耗水约45升" | 城市绿地与夏季降温调查.pdf, p. 1: "每套每小时耗水约45升" |  |
| vf-09-14 | zh | unsupported | contradicted | 调查共花费经费120万元。 | 社区食堂试点评估报告.docx, Units 7–7: "试点总投入1,260万元，其中区财政补贴占71%，街道配套资金占18%，其余来自企业和个人捐赠。" | – |  |
| vf-10-01 | zh | supported | unsupported | 仓库规定冷冻区温度不得高于零下18度。 | – | 冷链仓库值班手册.txt, line 16: "冷冻区不得高于零下18度" |  |
| vf-10-03 | zh | supported | unsupported | 灭火器每月15日由安保部检查。 | – | 冷链仓库值班手册.txt, line 50: "灭火器每月15日由安保部检查" |  |
| vf-10-05 | zh | contradicted | supported | 夜班负责人为孙雅琴，交接时间为00:00。 | 冷链仓库值班手册.txt, Units 1–1: "夜班    马文涛    00:00       8" | 冷链仓库值班手册.txt, line 9: "夜班 马文涛 00:00" |  |
