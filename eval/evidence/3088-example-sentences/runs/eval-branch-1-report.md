# Checks evaluation: Find support and verify (#86)

Run 2026-11-14T07:27:02.544Z at f99379156 (with uncommitted changes), 2198 s, with anthropic/claude-haiku-5-5. Claims extracted and checked by the app's claim check (checkClaim); claim extraction: the evaluation's baseline (eval/checks/lib/pipeline.ts).

Set: 208 Find support sentences and 165 claims in 10 received documents; 0 labels confirmed (none reviewed yet).

## Bars (reported only: they gate once #96 and #97 exist)

| Bar | Value | Needed | Met |
| --- | --- | --- | --- |
| Verify: claims extracted | 100.0% | ≥ 90.0% | yes |
| Verify: "contradicted" precision | 87.0% | ≥ 90.0% | no |
| Verify: "contradicted" recall | 90.4% | ≥ 70.0% | yes |
| Find support: "supported" precision | 100.0% | ≥ 90.0% | yes |
| Find support: "supported" recall | 69.3% | ≥ 80.0% | no |

## Find support

|  | "Supported" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 100.0% | 69.3% | 79 / 0 / 35 |
| English | 100.0% | 66.1% | 39 / 0 / 20 |
| Chinese | 100.0% | 72.7% | 40 / 0 / 15 |
| docx | 100.0% | 76.2% | 16 / 0 / 5 |
| transcript | 100.0% | 77.8% | 7 / 0 / 2 |
| pptx | 100.0% | 75.0% | 12 / 0 / 4 |
| xlsx | 100.0% | 50.0% | 7 / 0 / 7 |
| csv | 100.0% | 83.3% | 5 / 0 / 1 |
| markdown | 100.0% | 37.5% | 3 / 0 / 5 |
| text | 100.0% | 75.0% | 6 / 0 / 2 |
| pdf | 100.0% | 65.0% | 13 / 0 / 7 |
| web | 100.0% | 83.3% | 10 / 0 / 2 |

- Rightly supported, on the labelled Passage: 79/79 (100.0%).
- "Contradicted" (reported): precision 94.1%, recall 88.9%.
- Not checked: 25 (no evidence 22: quote not found 7, calculation not made 15; malformed reply 3; other 0).

## Verify

- Claims extracted: 165/165 (100.0%); English 85/85 (100.0%), Chinese 80/80 (100.0%).
- Extracted claims that match no label: 10. Not checked: 19 (no evidence 17: quote not found 8, calculation not made 9; malformed reply 2; other 0).

|  | "Contradicted" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 87.0% | 90.4% | 47 / 7 / 5 |
| English | 85.2% | 85.2% | 23 / 4 / 4 |
| Chinese | 88.9% | 96.0% | 24 / 3 / 1 |
| "Supported" (reported) | 91.7% | 78.6% | 33 / 3 / 9 |

Model calls: 10, 5972 input and 16230 output tokens.

## Misses

### Find support

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fs-004 | en | supported | not-checked | Ascend Access is delivering the lifts and ramps for £385,000. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Lifts and ramps Ascend Access £385,000" | no-evidence |
| fs-009 | en | supported | not-checked | The ramp at the front steps will have a gradient of 1 in 15. | – | Riverside Library Renovation Report.docx, § 6 Accessibility: "a ramp at a gradient of 1 in 15" | no-evidence |
| fs-016 | en | unsupported | not-checked | The local history archive will be digitised during the closure. | – | – | no-evidence |
| fs-021 | en | supported | unsupported | The council lends a stair climber for free if it is booked two weeks ahead. | – | Riverside Library Steering Meeting.vtt, 1:04: "The council lends one for free if we book it two weeks ahead." |  |
| fs-031 | en | supported | not-checked | The Explorer tier, one bag a month for £12.50, had 4,180 subscribers. | – | Coffee Subscription Launch Review.pptx, slide 4: "Explorer 1 £12.50 4,180" | number-not-worked-out |
| fs-037 | en | supported | not-checked | Customer churn dropped to 4.2 per cent after the onboarding was redesigned. | – | Quarterly Research Update.pptx, slide 2: "Customer churn fell to 4.2 per cent after the onboarding redesign." | malformed |
| fs-042 | en | supported | unsupported | Lowfield's planned budget is £673,600. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 31: "Lowfield North 7 4 444 £673,600" |  |
| fs-044 | en | supported | not-checked | Forty examination couches are due in November 2026. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 5: "Examination couch Wardrobe Healthcare £640 40 November 2026" | no-evidence |
| fs-049 | en | supported | not-checked | The West region's revenue rose every quarter of 2026, from £350,200 in Q1 to £466,100 in Q4. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | malformed |
| fs-050 | en | supported | not-checked | Revenue across all regions came to £6,812,100 in 2026. | – | Regional Revenue.xlsx, Revenue, row 8: "All regions £1,580,600 £1,637,750 £1,734,450 £1,859,300 £6,812,100" | number-not-worked-out |
| fs-053 | en | contradicted | unsupported | Q1 closed late because of a payroll migration. | Regional Revenue.xlsx, Units 2–2: "2026-04-02	A. Patel	Q1 closed two days late because of the ledger migration." | Regional Revenue.xlsx, Notes, row 2: "Q1 closed two days late because of the ledger migration." |  |
| fs-056 | en | supported | not-checked | The Cathedral station in Docklands has 17 docks. | – | Bike Share Stations September 2026.csv, row 13: "BS-1012 Cathedral Docklands 17" | malformed |
| fs-061 | en | supported | unsupported | Trip plans have to be registered with the base office at least 48 hours in advance. | – | Field Kit Setup Guide.md, § Before you leave: "Register the trip plan with the base office at least 48 hours ahead." |  |
| fs-062 | en | supported | unsupported | The tablet tries to sync every 20 minutes, on port 8443. | – | Field Kit Setup Guide.md, § Syncing data: "port = 8443 interval_minutes = 20" |  |
| fs-063 | en | supported | unsupported | The ford is closed when the Hollin gauge reads above 1.2 m. | – | Field Kit Setup Guide.md, § Before you leave: "A river level above 1.2 m at the Hollin gauge closes the ford." |  |
| fs-069 | en | supported | unsupported | Ward 7 has 30 beds, and its lead nurse hands over at 20:00. | – | Night Shift Handbook.txt, line 9: "Ward 7 Aileen Doherty 20:00 30" |  |
| fs-077 | en | supported | not-checked | Eastgate's surface temperatures peaked at 47.2 °C on 19 July. | – | Urban Heat in Six Districts.pdf, p. 1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July" | number-not-worked-out |
| fs-079 | en | supported | unsupported | Sea breezes cooled the Docks district by about 2 °C, but only within 300 metres of the shore. | – | Urban Heat in Six Districts.pdf, p. 1: "Wind from the sea cooled the Docks district by about 2 °C on most afternoons, but only within 300 metres of the shore." |  |
| fs-083 | en | supported | contradicted | Until radiation shields were fitted on 3 July, sensors in direct sun read up to 1.5 °C high. | Urban Heat in Six Districts.pdf, Units 2–3: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." | Urban Heat in Six Districts.pdf, p. 2: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." |  |
| fs-086 | en | contradicted | unsupported | The residents' survey had 1,410 respondents. | Urban Heat in Six Districts.pdf, Units 1–1: "A survey of 1,140 residents found that 41 per cent of" | Urban Heat in Six Districts.pdf, p. 1: "A survey of 1,140 residents" |  |
| fs-094 | en | supported | unsupported | A specialist studio will restore the reading room's stained glass window for £28,000. | – | Roof contract signed for Riverside Library, § The stained glass window, ¶ 1: "restored by a specialist studio at a cost of £28,000" |  |
| fs-103 | zh | supported | not-checked | 城东街道约有3,100名独居老人。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "其中独居老人约3,100人" | number-not-worked-out |
| fs-105 | zh | supported | not-checked | 食材成本约占每餐成本的六成以上。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "其中食材成本约占62%" | number-not-worked-out |
| fs-116 | zh | unsupported | not-checked | 新村食堂的租金比其他食堂高一倍。 | – | – | number-not-worked-out |
| fs-119 | zh | supported | not-checked | 登记送餐的行动不便老人有23位。 | – | 社区食堂周例会.vtt, 1:27: "行动不便的老人有二十三位登记了送餐。" | number-not-worked-out |
| fs-122 | zh | contradicted | not-checked | 街道消防检查定在十月十五日上午。 | – | 社区食堂周例会.vtt, 2:28: "街道消防检查定在十月十七日上午" | no-evidence |
| fs-127 | zh | supported | not-checked | 9路共有28辆车，日均客流11,300人次。 | – | 新能源公交季度运营汇报.pptx, slide 4: "9路 28 11,300" | number-not-worked-out |
| fs-129 | zh | supported | not-checked | 8月充电量为126万千瓦时。 | – | 新能源公交季度运营汇报.pptx, slide 6: "各月充电量（万千瓦时） 充电量 7月: 118, 8月: 126" | number-not-worked-out |
| fs-137 | zh | supported | not-checked | 中山路广场店（嘉兴）第三季度同比增长25.0%。 | – | 门店销售与库存2026.xlsx, 销售, row 17: "中山路广场店 嘉兴 ¥910,866 25.0%" | no-evidence |
| fs-138 | zh | supported | not-checked | 全麦吐司的安全库存为1200，补货周期为1天。 | – | 门店销售与库存2026.xlsx, 库存, row 3: "全麦吐司 滨江中心仓 1850 1200 1" | number-not-worked-out |
| fs-142 | zh | contradicted | unsupported | 延安路店（杭州）第三季度销售额同比下降3.0%。 | – | 门店销售与库存2026.xlsx, 销售, row 53: "延安路店 杭州 ¥995,950 3.0%" |  |
| fs-151 | zh | contradicted | not-checked | 翠湖名邸9月分类准确率为78%。 | – | 小区垃圾分类统计2026年9月.csv, row 13: "翠湖名邸 北山街道 903 92%" | no-evidence |
| fs-154 | zh | supported | unsupported | 实验结束后24小时内必须上传原始数据。 | – | 实验室数据管理规范.md, § 数据提交流程: "实验结束后24小时内上传原始数据。" |  |
| fs-155 | zh | supported | not-checked | 超过200GB的单个文件要先联系平台工程师分卷。 | – | 实验室数据管理规范.md, § 数据提交流程: "单个文件超过200GB时，须先联系平台工程师分卷。" | no-evidence |
| fs-159 | zh | unsupported | contradicted | 原始数据每季度做一次异地备份。 | 实验室数据管理规范.md, Units 4–4: "平台每晚自动备份，配置如下：" | – |  |
| fs-162 | zh | supported | unsupported | 叉车电量低于30%时要立即充电。 | – | 冷链仓库值班手册.txt, line 17: "检查叉车电量，低于30%时立即充电" |  |
| fs-169 | zh | supported | not-checked | 调查在江城市五个城区测量了地表温度和气温。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "我们在江城市五个城区测量了地表温度和气温" | no-evidence |
| fs-170 | zh | supported | unsupported | 临江区高层建筑密集，夜间气温连续七晚高于25℃。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "临江区夜间气温连续七晚高于25℃，主要原因是高层建筑密集" |  |
| fs-171 | zh | supported | contradicted | 屋顶绿化使顶层住户室内气温平均下降了2.2℃。 | 城市绿地与夏季降温调查.pdf, Units 2–2: "本研究没有测量室内温度。" | 城市绿地与夏季降温调查.pdf, p. 1: "顶层住户室内气温平均下降2.2℃" |  |
| fs-172 | zh | supported | not-checked | 问卷调查了1,260名居民。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "对1,260名居民的问卷显示" | no-evidence |
| fs-189 | zh | supported | unsupported | N3路每天晚上10点到次日凌晨5点运营。 | – | 夜班线路N3将于12月1日开通, § Start, ¶ 1: "每天晚上10点至次日凌晨5点运营" |  |
| fs-196 | zh | contradicted | unsupported | N3路的终点站是北站枢纽。 | – | 夜班线路N3将于12月1日开通, § 线路走向, ¶ 1: "N3路由北站枢纽发车，经人民路、解放路和中山路，开往高铁西站" |  |
| fs-203 | en | supported | not-checked | Library visits fell by about 23 per cent between 2019 and 2025. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | no-evidence |
| fs-205 | en | supported | not-checked | West's revenue in the first two quarters of 2026 came to £739,800. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | number-not-worked-out |

### Verify

Labelled claims not extracted, claims checked otherwise than labelled, and claims called contradicted that match no label.

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vf-01-02 | en | contradicted | not-checked | Under our contract, the roof and insulation package is due to be completed in April 2027. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000 June 2027" | no-evidence |
| vf-01-09 | en | contradicted | unsupported | Lifts and ramps are being installed by Hartley Building Ltd under the same contract. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Lifts and ramps Ascend Access £385,000" |  |
| vf-01-10 | en | supported | unsupported | The site compound takes up half of the staff car park. | – | Riverside Library Renovation Report.docx, § 4 Programme: "site compound will take half of the staff car park" |  |
| vf-01-13 | en | contradicted | not-checked | Asbestos removal in the boiler room ceiling was priced at £64,000 in the March 2026 survey. | – | Riverside Library Renovation Report.docx, § 3 Risks: "removal is priced at £46,000" | no-evidence |
| vf-02-02 | en | supported | unsupported | Every bag is roasted no more than 48 hours before it is dispatched. | – | Coffee Subscription Launch Review.pptx, slide 5: "Beans are roasted no more than 48 hours before dispatch." |  |
| vf-02-04 | en | supported | unsupported | A new roastery in Leeds begins shipping on 3 November, halving delivery times in the north. | Coffee Subscription Launch Review.pptx, Units 2–2: "If asked: the Leeds roastery starts shipping on 3 November, which halves delivery times in the north." | Coffee Subscription Launch Review.pptx, slide 2: "the Leeds roastery starts shipping on 3 November, which halves delivery times in the north" |  |
| vf-02-09 | en | contradicted | unsupported | Subscribers in Scotland are served from a depot in Edinburgh, which opened in July. | Coffee Subscription Launch Review.pptx, Units 8–8: "Scotland is served from the Glasgow depot, which opened in July." | Coffee Subscription Launch Review.pptx, slide 8: "Scotland is served from the Glasgow depot, which opened in July." |  |
| vf-03-02 | en | supported | not-checked | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" | malformed |
| vf-03-02 | en | supported | not-checked | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" | no-evidence |
| vf-03-04 | en | supported | not-checked | Marsh End, a South region clinic, is planned at 350 weekly hours. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 33: "Marsh End South 6 2 350" | no-evidence |
| vf-03-05 | en | contradicted | supported | Hawthorn, in the West region, is planned with 12 nurses. | Clinic Staffing Plan 2027.xlsx, Units 1–1: "Hawthorn	West	19	7	1047	£1,456,300" | Clinic Staffing Plan 2027.xlsx, Staffing, row 22: "Hawthorn West 19 7 1047" |  |
| vf-03-06 | en | contradicted | not-checked | Kingsmead's budget is £656,800. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 27: "Kingsmead North 9 2 472 £565,800" | no-evidence |
| vf-03-09 | en | contradicted | not-checked | Sonaris Imaging is supplying six ultrasound scanners. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 4: "Ultrasound scanner Sonaris Imaging £18,200 4" | no-evidence |
| vf-04-08 | en | supported | not-checked | Ferry Terminal, in Old Town, has 22 docks. | – | Bike Share Stations September 2026.csv, row 24: "BS-1023 Ferry Terminal Old Town 22" | no-evidence |
| vf-04-12 | en | unsupported | contradicted | We added 1,200 annual members in September. | Coffee Subscription Launch Review.pptx, Units 6–6: "Apr: 820, May: 1140, Jun: 1560, Jul: 1710, Aug: 1930, Sep: 2260" | – |  |
| vf-05-02 | en | contradicted | unsupported | The highest surface temperature, 47.2 °C, was recorded in Old Market on 19 July. | – | Urban Heat in Six Districts.pdf, p. 1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July" |  |
| vf-05-03 | en | supported | contradicted | Eastgate's tree cover is 6 per cent, well below the city average of 19 per cent. | Urban Heat in Six Districts.pdf, Units 1–1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." | Urban Heat in Six Districts.pdf, p. 1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." |  |
| vf-05-09 | en | supported | contradicted | Each misting station uses about 40 litres of water an hour. | Urban Heat in Six Districts.pdf, Units 1–1: "Misting stations cooled the air within five metres by up to 3.1 °C, but each used about 40 litres of water an hour." | Urban Heat in Six Districts.pdf, p. 1: "each used about 40 litres of water an hour" |  |
| vf-05-14 | en | supported | contradicted | A follow-up study with 80 indoor loggers will start in June 2027. | 城市绿地与夏季降温调查.pdf, Units 2–2: "2027年6月将启动后续研究，在100户居民家中布设室内温度记录仪" | Urban Heat in Six Districts.pdf, p. 2: "a follow-up study with 80 indoor loggers starts in June 2027" |  |
| vf-06-01 | zh | supported | not-checked | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" | no-evidence |
| vf-06-01 | zh | supported | not-checked | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" | number-not-worked-out |
| vf-06-03 | zh | supported | not-checked | 老年居民每餐自付8元，其余部分由区财政补贴。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "老年居民每餐自付8元，其余部分由区财政补贴。" | no-evidence |
| vf-07-04 | zh | supported | not-checked | 1路日均客流18,600人次，准点率95.2%。 | – | 新能源公交季度运营汇报.pptx, slide 4: "1路 42 18,600 95.2%" | number-not-worked-out |
| vf-07-05 | zh | contradicted | not-checked | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | – | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" | no-evidence |
| vf-07-13 | zh | unsupported | not-checked | 百公里电耗比去年同期下降了4%。 | – | – | number-not-worked-out |
| vf-08-02 | zh | supported | not-checked | 人民路广场店（嘉兴）第三季度同比增长22.0%。 | – | 门店销售与库存2026.xlsx, 销售, row 7: "人民路广场店 嘉兴 ¥531,676 22.0%" | number-not-worked-out |
| vf-08-05 | zh | supported | not-checked | 萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。 | – | 门店销售与库存2026.xlsx, 库存, row 2: "有机鲜牛奶 萧山冷链仓 4200 3000" | number-not-worked-out |
| vf-08-07 | zh | supported | not-checked | 鲜榨橙汁的补货周期为2天。 | – | 门店销售与库存2026.xlsx, 库存, row 6: "鲜榨橙汁 滨江中心仓 1320 1500 2" | number-not-worked-out |
| vf-09-04 | zh | supported | not-checked | 西湖区绿地率最高，达到38%。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "西湖区绿地率最高，达到38%" | malformed |
| vf-09-05 | zh | unsupported | not-checked | 北山区夏季平均气温比老城区低2℃。 | – | – | number-not-worked-out |
| vf-09-08 | zh | supported | contradicted | 喷雾降温设施每套每小时耗水约45升。 | Urban Heat in Six Districts.pdf, Units 1–1: "each used about 40 litres of water an hour" | 城市绿地与夏季降温调查.pdf, p. 1: "每套每小时耗水约45升" |  |
| vf-09-12 | zh | unsupported | contradicted | 市政府已决定明年新建20处喷雾降温设施。 | 城市绿地与夏季降温调查.pdf, Units 3–3: "喷雾降温设施 15处 3.4 每处7.5万元" | – |  |
| vf-09-13 | zh | contradicted | unsupported | 这项调查由江城市气象台完成。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "江城市生态环境研究所工作报告第9号" |  |
| vf-09-14 | zh | unsupported | contradicted | 调查共花费经费120万元。 | 社区食堂试点评估报告.docx, Units 7–7: "试点总投入1,260万元，其中区财政补贴占71%，街道配套资金占18%，其余来自企业和个人捐赠。" | – |  |
| vf-10-05 | zh | contradicted | supported | 夜班负责人为孙雅琴，交接时间为00:00。 | 冷链仓库值班手册.txt, Units 1–1: "夜班    马文涛    00:00       8" | 冷链仓库值班手册.txt, line 9: "夜班 马文涛 00:00" |  |
