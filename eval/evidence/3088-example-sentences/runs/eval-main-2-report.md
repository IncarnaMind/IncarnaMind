# Checks evaluation: Find support and verify (#86)

Run 2026-11-14T08:03:49.892Z at b283bc51c (with uncommitted changes), 2191 s, with anthropic/claude-haiku-5-5. Claims extracted and checked by the app's claim check (checkClaim); claim extraction: the evaluation's baseline (eval/checks/lib/pipeline.ts).

Set: 208 Find support sentences and 165 claims in 10 received documents; 0 labels confirmed (none reviewed yet).

## Bars (reported only: they gate once #96 and #97 exist)

| Bar | Value | Needed | Met |
| --- | --- | --- | --- |
| Verify: claims extracted | 98.8% | ≥ 90.0% | yes |
| Verify: "contradicted" precision | 91.7% | ≥ 90.0% | yes |
| Verify: "contradicted" recall | 84.6% | ≥ 70.0% | yes |
| Find support: "supported" precision | 100.0% | ≥ 90.0% | yes |
| Find support: "supported" recall | 64.0% | ≥ 80.0% | no |

## Find support

|  | "Supported" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 100.0% | 64.0% | 73 / 0 / 41 |
| English | 100.0% | 57.6% | 34 / 0 / 25 |
| Chinese | 100.0% | 70.9% | 39 / 0 / 16 |
| docx | 100.0% | 57.1% | 12 / 0 / 9 |
| transcript | 100.0% | 55.6% | 5 / 0 / 4 |
| pptx | 100.0% | 75.0% | 12 / 0 / 4 |
| xlsx | 100.0% | 50.0% | 7 / 0 / 7 |
| csv | 100.0% | 83.3% | 5 / 0 / 1 |
| markdown | 100.0% | 62.5% | 5 / 0 / 3 |
| text | 100.0% | 75.0% | 6 / 0 / 2 |
| pdf | 100.0% | 55.0% | 11 / 0 / 9 |
| web | 100.0% | 83.3% | 10 / 0 / 2 |

- Rightly supported, on the labelled Passage: 72/73 (98.6%).
- "Contradicted" (reported): precision 94.0%, recall 87.0%.
- Not checked: 33 (no evidence 31: quote not found 11, calculation not made 20; malformed reply 2; other 0).

## Verify

- Claims extracted: 163/165 (98.8%); English 83/85 (97.6%), Chinese 80/80 (100.0%).
- Extracted claims that match no label: 11. Not checked: 21 (no evidence 16: quote not found 7, calculation not made 9; malformed reply 5; other 0).

|  | "Contradicted" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 91.7% | 84.6% | 44 / 4 / 8 |
| English | 92.0% | 85.2% | 23 / 2 / 4 |
| Chinese | 91.3% | 84.0% | 21 / 2 / 4 |
| "Supported" (reported) | 91.4% | 76.2% | 32 / 3 / 10 |

Model calls: 10, 5972 input and 15604 output tokens.

## Misses

### Find support

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fs-001 | en | supported | not-checked | The Riverside Library first opened its doors in 1968. | – | Riverside Library Renovation Report.docx, § 1 Background: "The Riverside Library opened in 1968" | no-evidence |
| fs-002 | en | supported | not-checked | Annual visits to the library dropped from 212,000 in 2019 to 164,000 in 2025. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | number-not-worked-out |
| fs-008 | en | supported | not-checked | Longer opening hours were the change most requested in the consultation, by 62 per cent of respondents. | – | Riverside Library Renovation Report.docx, § 5 Consultation findings: "The most requested change was longer opening hours, named by 62 per cent of respondents." | malformed |
| fs-009 | en | supported | not-checked | The ramp at the front steps will have a gradient of 1 in 15. | – | Riverside Library Renovation Report.docx, § 6 Accessibility: "a ramp at a gradient of 1 in 15" | number-not-worked-out |
| fs-013 | en | contradicted | not-checked | The café and community room are being built by Hartley Building Ltd. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Café and community room Brookside Joinery £178,000 October 2027" | no-evidence |
| fs-020 | en | supported | not-checked | Harbour Street Kitchen made the lower of the two café bids. | – | Riverside Library Steering Meeting.vtt, 1:49: "Two bids came in, and the lower one is from Harbour Street Kitchen." | no-evidence |
| fs-021 | en | supported | unsupported | The council lends a stair climber for free if it is booked two weeks ahead. | – | Riverside Library Steering Meeting.vtt, 1:04: "The council lends one for free if we book it two weeks ahead." |  |
| fs-031 | en | supported | not-checked | The Explorer tier, one bag a month for £12.50, had 4,180 subscribers. | – | Coffee Subscription Launch Review.pptx, slide 4: "Explorer 1 £12.50 4,180" | number-not-worked-out |
| fs-037 | en | supported | unsupported | Customer churn dropped to 4.2 per cent after the onboarding was redesigned. | – | Quarterly Research Update.pptx, slide 2: "Customer churn fell to 4.2 per cent after the onboarding redesign." |  |
| fs-041 | en | supported | not-checked | Barnsfield, in the East region, plans for 13 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 4: "Barnsfield East 13 7 813 £1,206,700" | number-not-worked-out |
| fs-042 | en | supported | not-checked | Lowfield's planned budget is £673,600. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 31: "Lowfield North 7 4 444 £673,600" | no-evidence |
| fs-048 | en | unsupported | not-checked | Greystone has had two doctor posts vacant since the summer. | – | – | no-evidence |
| fs-049 | en | supported | not-checked | The West region's revenue rose every quarter of 2026, from £350,200 in Q1 to £466,100 in Q4. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | malformed |
| fs-052 | en | contradicted | not-checked | Central region revenue for 2026 was £2,421,600. | – | Regional Revenue.xlsx, Revenue, row 5: "Central £530,400 £547,900 £561,000 £602,300 £2,241,600" | no-evidence |
| fs-053 | en | contradicted | unsupported | Q1 closed late because of a payroll migration. | – | Regional Revenue.xlsx, Notes, row 2: "Q1 closed two days late because of the ledger migration." |  |
| fs-057 | en | supported | not-checked | Trips from Rope Walk averaged 10.5 minutes in September. | – | Bike Share Stations September 2026.csv, row 51: "BS-1050 Rope Walk Riverside 32 4283 10.5" | no-evidence |
| fs-061 | en | supported | unsupported | Trip plans have to be registered with the base office at least 48 hours in advance. | – | Field Kit Setup Guide.md, § Before you leave: "Register the trip plan with the base office at least 48 hours ahead." |  |
| fs-062 | en | supported | unsupported | The tablet tries to sync every 20 minutes, on port 8443. | Field Kit Setup Guide.md, Units 6–6: "Call the base office at 08:00 and 18:00 every day you are out, even when there is nothing to report. If a call is missed, base tries again after thirty minutes and then raises the alarm after a second missed call. Use plain language and give your grid reference to the nearest hundred metres." | Field Kit Setup Guide.md, § Syncing data: "port = 8443 interval_minutes = 20" |  |
| fs-063 | en | supported | unsupported | The ford is closed when the Hollin gauge reads above 1.2 m. | – | Field Kit Setup Guide.md, § Before you leave: "A river level above 1.2 m at the Hollin gauge closes the ford." |  |
| fs-070 | en | supported | unsupported | A NEWS2 score of 5 or more means calling the on-call registrar. | – | Night Shift Handbook.txt, line 26: "Call the on-call registrar for a NEWS2 score of 5 or more" |  |
| fs-078 | en | supported | not-checked | In Old Market, night-time air temperatures stayed above 24 °C for nine nights running. | – | Urban Heat in Six Districts.pdf, p. 1: "Night-time air temperatures stayed above 24 °C for nine nights in a row in the Old Market area" | number-not-worked-out |
| fs-079 | en | supported | unsupported | Sea breezes cooled the Docks district by about 2 °C, but only within 300 metres of the shore. | – | Urban Heat in Six Districts.pdf, p. 1: "Wind from the sea cooled the Docks district by about 2 °C on most afternoons, but only within 300 metres of the shore." |  |
| fs-082 | en | supported | not-checked | Median household income in Eastgate is 38 per cent below the city's. | – | Urban Heat in Six Districts.pdf, p. 1: "median household income in Eastgate is 38 per cent below the city's" | number-not-worked-out |
| fs-083 | en | supported | unsupported | Until radiation shields were fitted on 3 July, sensors in direct sun read up to 1.5 °C high. | – | Urban Heat in Six Districts.pdf, p. 2: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." |  |
| fs-084 | en | supported | not-checked | Permeable paving cost £41 per square metre. | – | Urban Heat in Six Districts.pdf, p. 3: "Permeable paving 6,700 m² 0.9 £41 per m²" | no-evidence |
| fs-086 | en | contradicted | unsupported | The residents' survey had 1,410 respondents. | Urban Heat in Six Districts.pdf, Units 1–1: "A survey of 1,140 residents found that 41 per cent of" | Urban Heat in Six Districts.pdf, p. 1: "A survey of 1,140 residents" |  |
| fs-095 | en | supported | unsupported | While the north wing is shut, the mobile library van will park outside the leisure centre on Tuesdays and Fridays. | – | Roof contract signed for Riverside Library, § Using the library during the works, ¶ 1: "the mobile library van will stop outside the leisure centre every Tuesday and Friday" |  |
| fs-096 | en | supported | unsupported | The council expects the library to reopen in full in November 2027. | – | Roof contract signed for Riverside Library, § Reopening, ¶ 1: "The council expects the renovated library to reopen in full in November 2027" |  |
| fs-102 | zh | supported | not-checked | 评估期内试点累计供餐41.6万份，日均约1,140份。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "评估期内累计供餐41.6万份，日均供餐约1,140份" | number-not-worked-out |
| fs-103 | zh | supported | not-checked | 城东街道约有3,100名独居老人。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "其中独居老人约3,100人" | number-not-worked-out |
| fs-104 | zh | supported | unsupported | 滨江食堂由邻里膳坊运营，满意度为89%。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "滨江食堂 邻里膳坊 215 89%" |  |
| fs-105 | zh | supported | contradicted | 食材成本约占每餐成本的六成以上。 | 社区食堂试点评估报告.docx, Units 3–3: "各食堂平均每餐成本为18.6元，其中食材成本约占62%" | 社区食堂试点评估报告.docx, § 二、运营数据: "其中食材成本约占62%" |  |
| fs-116 | zh | unsupported | not-checked | 新村食堂的租金比其他食堂高一倍。 | – | – | number-not-worked-out |
| fs-118 | zh | supported | not-checked | 周三用餐人数最多，因为当天有免费量血压活动。 | – | 社区食堂周例会.vtt, 0:19: "周三的人最多，因为那天有免费量血压的活动。" | no-evidence |
| fs-119 | zh | supported | not-checked | 登记送餐的行动不便老人有23位。 | – | 社区食堂周例会.vtt, 1:27: "行动不便的老人有二十三位登记了送餐。" | number-not-worked-out |
| fs-122 | zh | contradicted | not-checked | 街道消防检查定在十月十五日上午。 | – | 社区食堂周例会.vtt, 2:28: "街道消防检查定在十月十七日上午" | no-evidence |
| fs-127 | zh | supported | not-checked | 9路共有28辆车，日均客流11,300人次。 | – | 新能源公交季度运营汇报.pptx, slide 4: "9路 28 11,300" | number-not-worked-out |
| fs-130 | zh | supported | not-checked | 现金支付的比例比去年下降了5个百分点。 | – | 新能源公交季度运营汇报.pptx, slide 7: "现金支付比例比去年下降了5个百分点。" | no-evidence |
| fs-138 | zh | supported | not-checked | 全麦吐司的安全库存为1200，补货周期为1天。 | – | 门店销售与库存2026.xlsx, 库存, row 3: "全麦吐司 滨江中心仓 1850 1200 1" | no-evidence |
| fs-140 | zh | supported | not-checked | 胜利路社区店（绍兴）的客单价为86.0。 | – | 门店销售与库存2026.xlsx, 销售, row 31: "胜利路社区店 绍兴 ¥801,732 21.0% 86.0" | no-evidence |
| fs-141 | zh | supported | not-checked | 黄河路旗舰店第三季度销售额为810,978元。 | – | 门店销售与库存2026.xlsx, 销售, row 65: "黄河路旗舰店 温州 ¥810,978" | no-evidence |
| fs-152 | zh | unsupported | not-checked | 阳光花园9月的分类准确率比8月提高了5个百分点。 | – | – | number-not-worked-out |
| fs-159 | zh | unsupported | contradicted | 原始数据每季度做一次异地备份。 | 实验室数据管理规范.md, Units 4–4: "平台每晚自动备份，配置如下：" | – |  |
| fs-162 | zh | supported | unsupported | 叉车电量低于30%时要立即充电。 | – | 冷链仓库值班手册.txt, line 17: "检查叉车电量，低于30%时立即充电" |  |
| fs-169 | zh | supported | not-checked | 调查在江城市五个城区测量了地表温度和气温。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "我们在江城市五个城区测量了地表温度和气温" | no-evidence |
| fs-171 | zh | supported | unsupported | 屋顶绿化使顶层住户室内气温平均下降了2.2℃。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "顶层住户室内气温平均下降2.2℃" |  |
| fs-172 | zh | supported | contradicted | 问卷调查了1,260名居民。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "对1,260名居民的问卷显示，老城区有46%的受访者在高温天改变了步行路线，全市平均为19%。" | 城市绿地与夏季降温调查.pdf, p. 1: "对1,260名居民的问卷显示" |  |
| fs-175 | zh | supported | not-checked | 下一轮调查将在2027年夏季进行。 | – | 城市绿地与夏季降温调查.pdf, p. 3: "下一轮调查将在2027年夏季进行" | no-evidence |
| fs-196 | zh | contradicted | unsupported | N3路的终点站是北站枢纽。 | – | 夜班线路N3将于12月1日开通, § 线路走向, ¶ 1: "N3路由北站枢纽发车，经人民路、解放路和中山路，开往高铁西站" |  |
| fs-203 | en | supported | not-checked | Library visits fell by about 23 per cent between 2019 and 2025. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | no-evidence |
| fs-205 | en | supported | not-checked | West's revenue in the first two quarters of 2026 came to £739,800. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | number-not-worked-out |
| fs-208 | en | contradicted | not-checked | There were 58,000 fewer library visits in 2025 than in 2019. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | no-evidence |

### Verify

Labelled claims not extracted, claims checked otherwise than labelled, and claims called contradicted that match no label.

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vf-01-02 | en | contradicted | not-checked | Under our contract, the roof and insulation package is due to be completed in April 2027. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000 June 2027" | no-evidence |
| vf-01-03 | en | supported | not-checked | Our contract for the roof and insulation package is valued at £1,240,000. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000" | no-evidence |
| vf-01-05 | en | unsupported | not-checked | Insulation to the reading room ceiling was 60 per cent complete by the end of March. | – | – | number-not-worked-out |
| vf-01-08 | en | supported | not-extracted | The roof must be watertight before the lift installation can begin. | – | Riverside Library Renovation Report.docx, § 4 Programme: "which must be watertight before the lifts are installed" |  |
| vf-01-10 | en | supported | unsupported | The site compound takes up half of the staff car park. | – | Riverside Library Renovation Report.docx, § 4 Programme: "site compound will take half of the staff car park" |  |
| vf-01-14 | en | contradicted | unsupported | The bat survey found no roost under the eaves. | – | Riverside Library Renovation Report.docx, § 3 Risks: "A bat roost under the east eaves may delay the roof works" |  |
| vf-01-15 | en | unsupported | not-extracted | Our site manager walks the eaves with an ecologist every week. | – | – |  |
| vf-01-19 | en | unsupported | not-checked | The replacement windows for the reading room will be triple-glazed. | – | – | no-evidence |
| vf-02-04 | en | supported | unsupported | A new roastery in Leeds begins shipping on 3 November, halving delivery times in the north. | Coffee Subscription Launch Review.pptx, Units 2–2: "If asked: the Leeds roastery starts shipping on 3 November, which halves delivery times in the north." | Coffee Subscription Launch Review.pptx, slide 2: "the Leeds roastery starts shipping on 3 November, which halves delivery times in the north" |  |
| vf-02-09 | en | contradicted | unsupported | Subscribers in Scotland are served from a depot in Edinburgh, which opened in July. | Coffee Subscription Launch Review.pptx, Units 8–8: "Scotland is served from the Glasgow depot, which opened in July." | Coffee Subscription Launch Review.pptx, slide 8: "Scotland is served from the Glasgow depot, which opened in July." |  |
| vf-02-15 | en | unsupported | not-checked | Explorer subscribers receive a tasting card with every bag. | – | – | no-evidence |
| vf-03-01 | en | supported | not-checked | Your 2027 staffing plan sets a total budget of £50,929,200. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 56: "Total budget £50,929,200" | no-evidence |
| vf-03-02 | en | supported | not-checked | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" | malformed |
| vf-03-02 | en | supported | not-checked | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" | malformed |
| vf-03-05 | en | contradicted | supported | Hawthorn, in the West region, is planned with 12 nurses. | Clinic Staffing Plan 2027.xlsx, Units 1–2: "Hawthorn	West	19	7	1047	£1,456,300" | Clinic Staffing Plan 2027.xlsx, Staffing, row 22: "Hawthorn West 19 7 1047" |  |
| vf-03-07 | en | contradicted | unsupported | The staffing plan was approved by Dr Helen Okafor. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 57: "Approved by Dr Helen Okoro" |  |
| vf-03-09 | en | contradicted | not-checked | Sonaris Imaging is supplying six ultrasound scanners. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 4: "Ultrasound scanner Sonaris Imaging £18,200 4" | no-evidence |
| vf-04-08 | en | supported | not-checked | Ferry Terminal, in Old Town, has 22 docks. | – | Bike Share Stations September 2026.csv, row 24: "BS-1023 Ferry Terminal Old Town 22" | malformed |
| vf-04-16 | en | unsupported | not-checked | Weekend trips were 40 per cent longer than weekday trips. | – | – | number-not-worked-out |
| vf-05-02 | en | contradicted | supported | The highest surface temperature, 47.2 °C, was recorded in Old Market on 19 July. | Urban Heat in Six Districts.pdf, Units 1–1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July, the highest of the six districts measured." | Urban Heat in Six Districts.pdf, p. 1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July" |  |
| vf-05-03 | en | supported | contradicted | Eastgate's tree cover is 6 per cent, well below the city average of 19 per cent. | Urban Heat in Six Districts.pdf, Units 1–1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." | Urban Heat in Six Districts.pdf, p. 1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." |  |
| vf-05-09 | en | supported | contradicted | Each misting station uses about 40 litres of water an hour. | 城市绿地与夏季降温调查.pdf, Units 1–1: "每套每小时耗水约45升" | Urban Heat in Six Districts.pdf, p. 1: "each used about 40 litres of water an hour" |  |
| vf-05-10 | en | contradicted | not-checked | The city installed 20 misting stations in June 2026. | – | Urban Heat in Six Districts.pdf, p. 3: "The 12 misting stations installed in June 2026" | malformed |
| vf-05-14 | en | supported | unsupported | A follow-up study with 80 indoor loggers will start in June 2027. | – | Urban Heat in Six Districts.pdf, p. 2: "a follow-up study with 80 indoor loggers starts in June 2027" |  |
| vf-06-01 | zh | supported | not-checked | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" | number-not-worked-out |
| vf-07-04 | zh | supported | not-checked | 1路日均客流18,600人次，准点率95.2%。 | – | 新能源公交季度运营汇报.pptx, slide 4: "1路 42 18,600 95.2%" | no-evidence |
| vf-07-05 | zh | contradicted | not-checked | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | – | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" | no-evidence |
| vf-07-05 | zh | contradicted | unsupported | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | 新能源公交季度运营汇报.pptx, Units 2–2: "如被问到：第二座充电站将于2027年1月投入使用，位于北站枢纽。" | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" |  |
| vf-08-03 | zh | contradicted | not-checked | 复兴路旗舰店第三季度销售额为1,050,573元。 | – | 门店销售与库存2026.xlsx, 销售, rows 69–70: "复兴路旗舰店 温州 ¥1,000,573" | no-evidence |
| vf-08-07 | zh | supported | not-checked | 鲜榨橙汁的补货周期为2天。 | – | 门店销售与库存2026.xlsx, 库存, row 6: "鲜榨橙汁 滨江中心仓 1320 1500 2" | no-evidence |
| vf-08-08 | zh | contradicted | not-checked | 冷冻水饺存放在滨江中心仓。 | – | 门店销售与库存2026.xlsx, 库存, row 4: "冷冻水饺 萧山冷链仓" | no-evidence |
| vf-09-01 | zh | supported | not-checked | 2025年，江城市日最高气温超过35℃的天数达到41天。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "2025年日最高气温超过35℃的天数达到41天" | no-evidence |
| vf-09-05 | zh | unsupported | not-checked | 北山区夏季平均气温比老城区低2℃。 | – | – | number-not-worked-out |
| vf-09-08 | zh | supported | contradicted | 喷雾降温设施每套每小时耗水约45升。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "喷雾降温设施可使周边五米内气温降低最多3.4℃，但每套每小时耗水约45升。" | 城市绿地与夏季降温调查.pdf, p. 1: "每套每小时耗水约45升" |  |
| vf-09-13 | zh | contradicted | unsupported | 这项调查由江城市气象台完成。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "江城市生态环境研究所工作报告第9号" |  |
| vf-09-14 | zh | unsupported | contradicted | 调查共花费经费120万元。 | 社区食堂试点评估报告.docx, Units 7–7: "试点总投入1,260万元" | – |  |
| vf-09-16 | zh | supported | not-checked | 研究建议优先在老城区和临江区补种行道树。 | – | 城市绿地与夏季降温调查.pdf, p. 3: "建议优先在老城区和临江区补种行道树" | malformed |
| vf-10-05 | zh | contradicted | supported | 夜班负责人为孙雅琴，交接时间为00:00。 | 冷链仓库值班手册.txt, Units 1–1: "夜班    马文涛    00:00       8" | 冷链仓库值班手册.txt, line 9: "夜班 马文涛 00:00" |  |
