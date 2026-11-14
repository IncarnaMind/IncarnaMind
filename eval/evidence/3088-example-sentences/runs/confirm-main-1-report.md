# Checks evaluation: Find support and verify (#86)

Run 2026-11-14T21:35:16.333Z at 23df13e89 (with uncommitted changes), 1322 s, with anthropic/claude-haiku-5-5. Claims extracted and checked by the app's claim check (checkClaim); claim extraction: the evaluation's baseline (eval/checks/lib/pipeline.ts).

Set: 208 Find support sentences and 165 claims in 10 received documents; 0 labels confirmed (none reviewed yet).

## Bars (reported only: they gate once #96 and #97 exist)

| Bar | Value | Needed | Met |
| --- | --- | --- | --- |
| Verify: claims extracted | 0.0% | ≥ 90.0% | no |
| Verify: "contradicted" precision | – | ≥ 90.0% | no |
| Verify: "contradicted" recall | 0.0% | ≥ 70.0% | no |
| Find support: "supported" precision | 100.0% | ≥ 90.0% | yes |
| Find support: "supported" recall | 76.3% | ≥ 80.0% | no |

## Find support

|  | "Supported" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | 100.0% | 76.3% | 87 / 0 / 27 |
| English | 100.0% | 78.0% | 46 / 0 / 13 |
| Chinese | 100.0% | 74.5% | 41 / 0 / 14 |
| docx | 100.0% | 85.7% | 18 / 0 / 3 |
| transcript | 100.0% | 77.8% | 7 / 0 / 2 |
| pptx | 100.0% | 81.3% | 13 / 0 / 3 |
| xlsx | 100.0% | 64.3% | 9 / 0 / 5 |
| csv | 100.0% | 83.3% | 5 / 0 / 1 |
| markdown | 100.0% | 37.5% | 3 / 0 / 5 |
| text | 100.0% | 100.0% | 8 / 0 / 0 |
| pdf | 100.0% | 70.0% | 14 / 0 / 6 |
| web | 100.0% | 83.3% | 10 / 0 / 2 |

- Rightly supported, on the labelled Passage: 86/87 (98.9%).
- "Contradicted" (reported): precision 95.5%, recall 77.8%.
- Not checked: 29 (no evidence 24: quote not found 12, calculation not made 12; malformed reply 4; other 1).

## Verify

- Claims extracted: 0/165 (0.0%); English 0/85 (0.0%), Chinese 0/80 (0.0%).
- Extracted claims that match no label: 0. Not checked: 0 (no evidence 0: quote not found 0, calculation not made 0; malformed reply 0; other 0).

|  | "Contradicted" precision | Recall | True / false positives / misses |
| --- | --- | --- | --- |
| All | – | 0.0% | 0 / 0 / 52 |
| English | – | 0.0% | 0 / 0 / 27 |
| Chinese | – | 0.0% | 0 / 0 / 25 |
| "Supported" (reported) | – | 0.0% | 0 / 0 / 42 |

Model calls: 0, 0 input and 0 output tokens.

## Misses

### Find support

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fs-009 | en | supported | not-checked | The ramp at the front steps will have a gradient of 1 in 15. | – | Riverside Library Renovation Report.docx, § 6 Accessibility: "a ramp at a gradient of 1 in 15" | number-not-worked-out |
| fs-010 | en | contradicted | not-checked | The library's last major refurbishment was in 1984. | – | Riverside Library Renovation Report.docx, § 1 Background: "last had a major refurbishment in 1994" | no-evidence |
| fs-013 | en | contradicted | not-checked | The café and community room are being built by Hartley Building Ltd. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Café and community room Brookside Joinery £178,000 October 2027" | no-evidence |
| fs-021 | en | supported | not-checked | The council lends a stair climber for free if it is booked two weeks ahead. | – | Riverside Library Steering Meeting.vtt, 1:04: "The council lends one for free if we book it two weeks ahead." | malformed |
| fs-031 | en | supported | not-checked | The Explorer tier, one bag a month for £12.50, had 4,180 subscribers. | – | Coffee Subscription Launch Review.pptx, slide 4: "Explorer 1 £12.50 4,180" | no-evidence |
| fs-041 | en | supported | not-checked | Barnsfield, in the East region, plans for 13 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 4: "Barnsfield East 13 7 813 £1,206,700" | no-evidence |
| fs-046 | en | contradicted | not-checked | Vaccine fridges from ColdChain Direct cost £3,210 each. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 7: "Vaccine fridge ColdChain Direct £2,310" | no-evidence |
| fs-052 | en | contradicted | not-checked | Central region revenue for 2026 was £2,421,600. | – | Regional Revenue.xlsx, Revenue, row 5: "Central £530,400 £547,900 £561,000 £602,300 £2,241,600" | no-evidence |
| fs-053 | en | contradicted | unsupported | Q1 closed late because of a payroll migration. | – | Regional Revenue.xlsx, Notes, row 2: "Q1 closed two days late because of the ledger migration." |  |
| fs-055 | en | supported | not-checked | Clock Tower station, in Central, logged 4,005 trips in September. | – | Bike Share Stations September 2026.csv, row 17: "BS-1016 Clock Tower Central 12 4005" | malformed |
| fs-059 | en | contradicted | not-checked | The Museum station recorded 3,890 trips in September. | – | Bike Share Stations September 2026.csv, row 42: "BS-1041 Museum Central 12 3980" | malformed |
| fs-061 | en | supported | unsupported | Trip plans have to be registered with the base office at least 48 hours in advance. | – | Field Kit Setup Guide.md, § Before you leave: "Register the trip plan with the base office at least 48 hours ahead." |  |
| fs-064 | en | supported | not-checked | The water filter's cartridge is replaced after 1,000 litres. | – | Field Kit Setup Guide.md, § Packing list: "Replace the cartridge after 1,000 litres" | number-not-worked-out |
| fs-073 | en | contradicted | not-checked | Each nurse takes a 30-minute break during the night. | – | Night Shift Handbook.txt, line 43: "Each nurse takes a 45-minute break between 01:00 and 04:00" | no-evidence |
| fs-074 | en | contradicted | not-checked | For a cardiac arrest, staff dial 3333. | – | Night Shift Handbook.txt, line 28: "For a cardiac arrest, dial 2222" | no-evidence |
| fs-078 | en | supported | not-checked | In Old Market, night-time air temperatures stayed above 24 °C for nine nights running. | – | Urban Heat in Six Districts.pdf, p. 1: "Night-time air temperatures stayed above 24 °C for nine nights in a row in the Old Market area" | number-not-worked-out |
| fs-079 | en | supported | unsupported | Sea breezes cooled the Docks district by about 2 °C, but only within 300 metres of the shore. | – | Urban Heat in Six Districts.pdf, p. 1: "Wind from the sea cooled the Docks district by about 2 °C on most afternoons, but only within 300 metres of the shore." |  |
| fs-083 | en | supported | contradicted | Until radiation shields were fitted on 3 July, sensors in direct sun read up to 1.5 °C high. | Urban Heat in Six Districts.pdf, Units 2–3: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." | Urban Heat in Six Districts.pdf, p. 2: "Sensors in direct sun read up to 1.5 °C high until radiation shields were fitted on 3 July." |  |
| fs-085 | en | contradicted | unsupported | Eastgate stayed above 30 °C for 12 hours on the hottest day. | – | Urban Heat in Six Districts.pdf, p. 1: "Eastgate stayed above 30 °C for 9.5 hours." |  |
| fs-086 | en | contradicted | unsupported | The residents' survey had 1,410 respondents. | Urban Heat in Six Districts.pdf, Units 1–1: "A survey of 1,140 residents found that 41 per cent of" | Urban Heat in Six Districts.pdf, p. 1: "A survey of 1,140 residents" |  |
| fs-092 | en | supported | not-checked | The roof and insulation contract went to Hartley Building Ltd, the first of four works packages. | – | Roof contract signed for Riverside Library, § Start, ¶ 1: "with Hartley Building Ltd, the first of the renovation's four works packages" | no-evidence |
| fs-095 | en | supported | unsupported | While the north wing is shut, the mobile library van will park outside the leisure centre on Tuesdays and Fridays. | – | Roof contract signed for Riverside Library, § Using the library during the works, ¶ 1: "the mobile library van will stop outside the leisure centre every Tuesday and Friday" |  |
| fs-104 | zh | supported | not-checked | 滨江食堂由邻里膳坊运营，满意度为89%。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "滨江食堂 邻里膳坊 215 89%" | no-evidence |
| fs-105 | zh | supported | not-checked | 食材成本约占每餐成本的六成以上。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "其中食材成本约占62%" | number-not-worked-out |
| fs-118 | zh | supported | not-checked | 周三用餐人数最多，因为当天有免费量血压活动。 | – | 社区食堂周例会.vtt, 0:19: "周三的人最多，因为那天有免费量血压的活动。" | refused |
| fs-127 | zh | supported | not-checked | 9路共有28辆车，日均客流11,300人次。 | – | 新能源公交季度运营汇报.pptx, slide 4: "9路 28 11,300" | number-not-worked-out |
| fs-128 | zh | supported | not-checked | 动力电池的质保期为8年或60万公里，以先到者为准。 | – | 新能源公交季度运营汇报.pptx, slide 5: "电池质保期为8年或60万公里，以先到者为准。" | malformed |
| fs-138 | zh | supported | not-checked | 全麦吐司的安全库存为1200，补货周期为1天。 | – | 门店销售与库存2026.xlsx, 库存, row 3: "全麦吐司 滨江中心仓 1850 1200 1" | number-not-worked-out |
| fs-139 | zh | supported | not-checked | 门店销售表由李晓雯制作。 | – | 门店销售与库存2026.xlsx, 销售, row 80: "制表人 李晓雯" | no-evidence |
| fs-141 | zh | supported | not-checked | 黄河路旗舰店第三季度销售额为810,978元。 | – | 门店销售与库存2026.xlsx, 销售, row 65: "黄河路旗舰店 温州 ¥810,978" | no-evidence |
| fs-152 | zh | unsupported | not-checked | 阳光花园9月的分类准确率比8月提高了5个百分点。 | – | – | number-not-worked-out |
| fs-153 | zh | supported | not-checked | 原始测序数据存放在冷存储阵列B，保留10年。 | – | 实验室数据管理规范.md, § 存储位置与保留期限: "原始测序数据 \| 冷存储阵列B \| 10年" | no-evidence |
| fs-154 | zh | supported | not-checked | 实验结束后24小时内必须上传原始数据。 | – | 实验室数据管理规范.md, § 数据提交流程: "实验结束后24小时内上传原始数据。" | no-evidence |
| fs-156 | zh | supported | unsupported | 访问权限每半年复核一次。 | – | 实验室数据管理规范.md, § 访问权限: "权限每半年复核一次" |  |
| fs-171 | zh | supported | unsupported | 屋顶绿化使顶层住户室内气温平均下降了2.2℃。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "屋顶绿化单位面积成本最高，但顶层住户室内气温平均下降2.2℃。行道树需要两个夏季才能形成树荫，但树下路面降温最明显。" | 城市绿地与夏季降温调查.pdf, p. 1: "顶层住户室内气温平均下降2.2℃" |  |
| fs-172 | zh | supported | contradicted | 问卷调查了1,260名居民。 | 城市绿地与夏季降温调查.pdf, Units 1–1: "对1,260名居民的问卷显示，老城区有46%的受访者在高温天改变了步行路线，全市平均为19%。" | 城市绿地与夏季降温调查.pdf, p. 1: "对1,260名居民的问卷显示" |  |
| fs-175 | zh | supported | not-checked | 下一轮调查将在2027年夏季进行。 | – | 城市绿地与夏季降温调查.pdf, p. 3: "下一轮调查将在2027年夏季进行" | no-evidence |
| fs-196 | zh | contradicted | unsupported | N3路的终点站是北站枢纽。 | – | 夜班线路N3将于12月1日开通, § 线路走向, ¶ 1: "N3路由北站枢纽发车，经人民路、解放路和中山路，开往高铁西站" |  |
| fs-205 | en | supported | not-checked | West's revenue in the first two quarters of 2026 came to £739,800. | – | Regional Revenue.xlsx, Revenue, row 7: "West £350,200 £389,600 £421,800 £466,100" | no-evidence |
| fs-208 | en | contradicted | not-checked | There were 58,000 fewer library visits in 2025 than in 2019. | – | Riverside Library Renovation Report.docx, § 1 Background: "Visits fell from 212,000 in 2019 to 164,000 in 2025" | no-evidence |

### Verify

Labelled claims not extracted, claims checked otherwise than labelled, and claims called contradicted that match no label.

| Id | Language | Label | Verdict | Text | Found | Labelled evidence | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vf-01-01 | en | supported | not-extracted | Roof works were programmed to start on 4 January 2027. | – | Riverside Library Renovation Report.docx, § 4 Programme: "Works start on 4 January 2027 with the roof" |  |
| vf-01-02 | en | contradicted | not-extracted | Under our contract, the roof and insulation package is due to be completed in April 2027. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000 June 2027" |  |
| vf-01-03 | en | supported | not-extracted | Our contract for the roof and insulation package is valued at £1,240,000. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Roof and insulation Hartley Building Ltd £1,240,000" |  |
| vf-01-04 | en | unsupported | not-extracted | Forty-two operatives worked on site during March. | – | – |  |
| vf-01-05 | en | unsupported | not-extracted | Insulation to the reading room ceiling was 60 per cent complete by the end of March. | – | – |  |
| vf-01-06 | en | unsupported | not-extracted | Two working days were lost to high winds in the first week of March. | – | – |  |
| vf-01-07 | en | unsupported | not-extracted | The scaffolding was supplied and erected by Apex Access Ltd. | – | – |  |
| vf-01-08 | en | supported | not-extracted | The roof must be watertight before the lift installation can begin. | – | Riverside Library Renovation Report.docx, § 4 Programme: "which must be watertight before the lifts are installed" |  |
| vf-01-09 | en | contradicted | not-extracted | Lifts and ramps are being installed by Hartley Building Ltd under the same contract. | – | Riverside Library Renovation Report.docx, § 2 Costs: "Lifts and ramps Ascend Access £385,000" |  |
| vf-01-10 | en | supported | not-extracted | The site compound takes up half of the staff car park. | – | Riverside Library Renovation Report.docx, § 4 Programme: "site compound will take half of the staff car park" |  |
| vf-01-11 | en | supported | not-extracted | Progress meetings are held every Tuesday at the council offices. | – | Riverside Library Renovation Report.docx, § 4 Programme: "Progress meetings are held every Tuesday at the council offices" |  |
| vf-01-12 | en | unsupported | not-extracted | All waste from the strip-out has been recycled. | – | – |  |
| vf-01-13 | en | contradicted | not-extracted | Asbestos removal in the boiler room ceiling was priced at £64,000 in the March 2026 survey. | – | Riverside Library Renovation Report.docx, § 3 Risks: "removal is priced at £46,000" |  |
| vf-01-14 | en | contradicted | not-extracted | The bat survey found no roost under the eaves. | – | Riverside Library Renovation Report.docx, § 3 Risks: "A bat roost under the east eaves may delay the roof works" |  |
| vf-01-15 | en | unsupported | not-extracted | Our site manager walks the eaves with an ecologist every week. | – | – |  |
| vf-01-16 | en | contradicted | not-extracted | The council's contingency is held at 15 per cent of the works cost. | – | Riverside Library Renovation Report.docx, § 2 Costs: "A contingency of 10 per cent of the works cost is held by the council's capital programme board." |  |
| vf-01-17 | en | contradicted | not-extracted | The total renovation budget is £3.2 million. | – | Riverside Library Renovation Report.docx, § 2 Costs: "The total budget is £2.6 million" |  |
| vf-01-18 | en | unsupported | not-extracted | The new roof membrane carries a 25-year manufacturer's warranty. | – | – |  |
| vf-01-19 | en | unsupported | not-extracted | The replacement windows for the reading room will be triple-glazed. | – | – |  |
| vf-02-01 | en | supported | not-extracted | Harbour Roasters' coffee subscription reached 9,420 paid subscribers at the end of September. | – | Coffee Subscription Launch Review.pptx, slide 2: "Paid subscribers reached 9,420 by the end of September." |  |
| vf-02-02 | en | supported | not-extracted | Every bag is roasted no more than 48 hours before it is dispatched. | – | Coffee Subscription Launch Review.pptx, slide 5: "Beans are roasted no more than 48 hours before dispatch." |  |
| vf-02-03 | en | contradicted | not-extracted | Two roasting shifts run every weekday at the company's Manchester roastery. | – | Coffee Subscription Launch Review.pptx, slide 5: "Two roasting shifts run on weekdays at the Bristol roastery." |  |
| vf-02-04 | en | supported | not-extracted | A new roastery in Leeds begins shipping on 3 November, halving delivery times in the north. | – | Coffee Subscription Launch Review.pptx, slide 2: "the Leeds roastery starts shipping on 3 November, which halves delivery times in the north" |  |
| vf-02-05 | en | contradicted | not-extracted | In September's customer survey the service scored a net promoter score of 61. | – | Coffee Subscription Launch Review.pptx, slide 3: "Net promoter score was 52 in the September survey." |  |
| vf-02-06 | en | supported | not-extracted | Customers named freshness as the feature they liked best. | – | Coffee Subscription Launch Review.pptx, slide 3: "Freshness was the most praised feature" |  |
| vf-02-07 | en | contradicted | not-extracted | About 9 per cent of subscribers cancelled in their first month. | – | Coffee Subscription Launch Review.pptx, slide 2: "Cancellations in the first month stayed below 6 per cent." |  |
| vf-02-08 | en | contradicted | not-extracted | The Office plan delivers four bags a month for £58. | – | Coffee Subscription Launch Review.pptx, slide 4: "Office 6 £58.00 1,280" |  |
| vf-02-09 | en | contradicted | not-extracted | Subscribers in Scotland are served from a depot in Edinburgh, which opened in July. | – | Coffee Subscription Launch Review.pptx, slide 8: "Scotland is served from the Glasgow depot, which opened in July." |  |
| vf-02-10 | en | contradicted | not-extracted | Referral codes have brought in more than 2,000 subscribers since launch. | – | Coffee Subscription Launch Review.pptx, slide 7: "Referral codes brought in 1,310 subscribers since launch." |  |
| vf-02-11 | en | unsupported | not-extracted | Harbour Roasters was founded in 2019 by two former baristas. | – | – |  |
| vf-02-12 | en | unsupported | not-extracted | All of its coffee is certified organic and Fairtrade. | – | – |  |
| vf-02-13 | en | unsupported | not-extracted | The boxes are fully compostable. | – | – |  |
| vf-02-14 | en | unsupported | not-extracted | Subscribers can pause their plan at any time from the app. | – | – |  |
| vf-02-15 | en | unsupported | not-extracted | Explorer subscribers receive a tasting card with every bag. | – | – |  |
| vf-02-16 | en | unsupported | not-extracted | Deliveries are carbon-neutral through the courier's offset programme. | – | – |  |
| vf-02-17 | en | unsupported | not-extracted | The company plans to open a coffee bar at its roastery next spring. | – | – |  |
| vf-03-01 | en | supported | not-extracted | Your 2027 staffing plan sets a total budget of £50,929,200. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 56: "Total budget £50,929,200" |  |
| vf-03-02 | en | supported | not-extracted | Westbury, in the East region, plans for 19 nurses and 7 doctors. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 52: "Westbury East 19 7" |  |
| vf-03-03 | en | supported | not-extracted | The plan budgets £438,000 for Ashford Vale. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 3: "Ashford Vale North 6 2 320 £438,000" |  |
| vf-03-04 | en | supported | not-extracted | Marsh End, a South region clinic, is planned at 350 weekly hours. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 33: "Marsh End South 6 2 350" |  |
| vf-03-05 | en | contradicted | not-extracted | Hawthorn, in the West region, is planned with 12 nurses. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 22: "Hawthorn West 19 7 1047" |  |
| vf-03-06 | en | contradicted | not-extracted | Kingsmead's budget is £656,800. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 27: "Kingsmead North 9 2 472 £565,800" |  |
| vf-03-07 | en | contradicted | not-extracted | The staffing plan was approved by Dr Helen Okafor. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 57: "Approved by Dr Helen Okoro" |  |
| vf-03-08 | en | supported | not-extracted | The plan is due for review on 30 November 2026. | – | Clinic Staffing Plan 2027.xlsx, Staffing, row 58: "Review date 2026-11-30" |  |
| vf-03-09 | en | contradicted | not-extracted | Sonaris Imaging is supplying six ultrasound scanners. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 4: "Ultrasound scanner Sonaris Imaging £18,200 4" |  |
| vf-03-10 | en | contradicted | not-extracted | The defibrillators are due for delivery in February 2027. | – | Clinic Staffing Plan 2027.xlsx, Equipment, row 3: "Defibrillator Lifeline Medical £1,390 26 December 2026" |  |
| vf-03-11 | en | unsupported | not-extracted | The ECG machines come with a five-year service contract. | – | – |  |
| vf-03-12 | en | unsupported | not-extracted | The vaccine fridges will be installed by ColdChain Direct's own engineers. | – | – |  |
| vf-03-13 | en | unsupported | not-extracted | Agency nurses currently fill 14 per cent of shifts across your network. | – | – |  |
| vf-03-14 | en | unsupported | not-extracted | The North region has the highest vacancy rate in your network. | – | – |  |
| vf-03-15 | en | unsupported | not-extracted | Each clinic must keep at least one doctor on site during opening hours. | – | – |  |
| vf-03-16 | en | unsupported | not-extracted | Your network employs 85 healthcare assistants. | – | – |  |
| vf-03-17 | en | unsupported | not-extracted | Cedar Park will open on Saturdays from January. | – | – |  |
| vf-04-01 | en | supported | not-extracted | Gas Works, in Central, recorded 4,775 trips in September. | – | Bike Share Stations September 2026.csv, row 27: "BS-1026 Gas Works Central 12 4775" |  |
| vf-04-02 | en | contradicted | not-extracted | Science Park recorded 5,750 trips in September. | – | Bike Share Stations September 2026.csv, row 52: "BS-1051 Science Park Central 12 4750" |  |
| vf-04-03 | en | supported | not-extracted | Abbey Road has 12 docks and averaged 9-minute trips. | – | Bike Share Stations September 2026.csv, row 2: "BS-1001 Abbey Road Central 12 900 9.0" |  |
| vf-04-04 | en | contradicted | not-extracted | Albert Dock is in the Old Town district. | – | Bike Share Stations September 2026.csv, row 3: "BS-1002 Albert Dock Docklands" |  |
| vf-04-05 | en | supported | not-extracted | Bus Station, in the University Quarter, averaged 27-minute trips. | – | Bike Share Stations September 2026.csv, row 10: "BS-1009 Bus Station University Quarter 27 4636 27.0" |  |
| vf-04-06 | en | contradicted | not-extracted | Wool Hall has 32 docks. | – | Bike Share Stations September 2026.csv, row 69: "BS-1068 Wool Hall Old Town 22" |  |
| vf-04-07 | en | contradicted | not-extracted | Trips from Canal Basin averaged 25.5 minutes. | – | Bike Share Stations September 2026.csv, row 11: "BS-1010 Canal Basin Riverside 32 1203 15.5" |  |
| vf-04-08 | en | supported | not-extracted | Ferry Terminal, in Old Town, has 22 docks. | – | Bike Share Stations September 2026.csv, row 24: "BS-1023 Ferry Terminal Old Town 22" |  |
| vf-04-09 | en | contradicted | not-extracted | Town Hall station sits in the Central district. | – | Bike Share Stations September 2026.csv, row 61: "BS-1060 Town Hall Riverside" |  |
| vf-04-10 | en | unsupported | not-extracted | E-bikes made up 35 per cent of the fleet in September. | – | – |  |
| vf-04-11 | en | unsupported | not-extracted | Bikes were available at 92 per cent of stations at peak times. | – | – |  |
| vf-04-12 | en | unsupported | not-extracted | We added 1,200 annual members in September. | – | – |  |
| vf-04-13 | en | unsupported | not-extracted | Twelve new stations will open in the Docklands next spring. | – | – |  |
| vf-04-14 | en | unsupported | not-extracted | Vandalism cost the scheme £14,000 in September. | – | – |  |
| vf-04-15 | en | unsupported | not-extracted | The Hospital station is used mostly by night-shift staff. | – | – |  |
| vf-04-16 | en | unsupported | not-extracted | Weekend trips were 40 per cent longer than weekday trips. | – | – |  |
| vf-05-01 | en | supported | not-extracted | The study measured temperatures in six districts between June and August 2026. | – | Urban Heat in Six Districts.pdf, p. 1: "We measured surface and air temperatures in six districts of a coastal city from June to August 2026" |  |
| vf-05-02 | en | contradicted | not-extracted | The highest surface temperature, 47.2 °C, was recorded in Old Market on 19 July. | – | Urban Heat in Six Districts.pdf, p. 1: "Surface temperatures in the Eastgate district peaked at 47.2 °C on 19 July" |  |
| vf-05-03 | en | supported | not-extracted | Eastgate's tree cover is 6 per cent, well below the city average of 19 per cent. | – | Urban Heat in Six Districts.pdf, p. 1: "Tree cover in Eastgate is 6 per cent, against a city average of 19 per cent." |  |
| vf-05-04 | en | contradicted | not-extracted | Hillside was on average 4.3 °C cooler than Eastgate at noon. | – | Urban Heat in Six Districts.pdf, p. 1: "was on average 3.4 °C cooler at noon than Eastgate" |  |
| vf-05-05 | en | unsupported | not-extracted | Heat-related hospital admissions in Eastgate doubled between 2020 and 2025. | – | – |  |
| vf-05-06 | en | unsupported | not-extracted | Older residents in Eastgate spend on average six hours a day indoors in summer. | – | – |  |
| vf-05-07 | en | contradicted | not-extracted | Cool roofs were the most expensive measure per square metre. | – | Urban Heat in Six Districts.pdf, p. 1: "were the cheapest measure per square metre" |  |
| vf-05-08 | en | contradicted | not-extracted | Street trees cost £130 each to plant. | – | Urban Heat in Six Districts.pdf, p. 3: "Street trees 2,150 trees 2.6 £310 per tree" |  |
| vf-05-09 | en | supported | not-extracted | Each misting station uses about 40 litres of water an hour. | – | Urban Heat in Six Districts.pdf, p. 1: "each used about 40 litres of water an hour" |  |
| vf-05-10 | en | contradicted | not-extracted | The city installed 20 misting stations in June 2026. | – | Urban Heat in Six Districts.pdf, p. 3: "The 12 misting stations installed in June 2026" |  |
| vf-05-11 | en | unsupported | not-extracted | Permeable paving also reduced surface flooding on the test streets. | – | – |  |
| vf-05-12 | en | unsupported | not-extracted | Cool roofs were first trialled in the city in 2019. | – | – |  |
| vf-05-13 | en | unsupported | not-extracted | Misting stations halved heat complaints at the bus stops where they were installed. | – | – |  |
| vf-05-14 | en | supported | not-extracted | A follow-up study with 80 indoor loggers will start in June 2027. | – | Urban Heat in Six Districts.pdf, p. 2: "a follow-up study with 80 indoor loggers starts in June 2027" |  |
| vf-05-15 | en | unsupported | not-extracted | The study was funded by a national research council grant. | – | – |  |
| vf-05-16 | en | unsupported | not-extracted | The city plans to plant 5,000 street trees by 2030. | – | – |  |
| vf-06-01 | zh | supported | not-extracted | 桂花苑食堂由我公司运营，日均供餐260份。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "桂花苑食堂 禾丰餐饮公司 260" |  |
| vf-06-02 | zh | contradicted | not-extracted | 新村食堂日均供餐210份，满意度达到92%。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "新村食堂 禾丰餐饮公司 150 86%" |  |
| vf-06-03 | zh | supported | not-extracted | 老年居民每餐自付8元，其余部分由区财政补贴。 | – | 社区食堂试点评估报告.docx, § 一、项目背景: "老年居民每餐自付8元，其余部分由区财政补贴。" |  |
| vf-06-04 | zh | contradicted | not-extracted | 试点期间各食堂平均每餐成本为16.8元。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "各食堂平均每餐成本为18.6元" |  |
| vf-06-05 | zh | supported | not-extracted | 食材统一由区农产品配送中心采购配送。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "食材采购统一由区农产品配送中心负责。" |  |
| vf-06-06 | zh | contradicted | not-extracted | 配送中心的合同将于2027年6月到期。 | – | 社区食堂试点评估报告.docx, § 二、运营数据, comment by Reviewer: "配送中心的合同将于2026年12月到期" |  |
| vf-06-07 | zh | supported | not-extracted | 增设第二个打饭窗口后，桂花苑食堂高峰排队时间缩短到8分钟左右。 | – | 社区食堂试点评估报告.docx, § 二、运营数据: "增设第二个打饭窗口后缩短到8分钟左右" |  |
| vf-06-08 | zh | contradicted | not-extracted | 桂花苑片区的晚餐供应将于2027年3月开始。 | – | 社区食堂试点评估报告.docx, § （一）桂花苑片区: "预计于2026年11月开始，新增厨师2名" |  |
| vf-06-09 | zh | contradicted | not-extracted | 评估期内新村食堂实现盈利约42万元。 | – | 社区食堂试点评估报告.docx, § 四、经费情况: "评估期内运营亏损最大的是新村食堂，全年亏损约42万元" |  |
| vf-06-10 | zh | unsupported | not-extracted | 新村食堂的志愿者送餐员有9人。 | – | – |  |
| vf-06-11 | zh | unsupported | not-extracted | 我公司厨房员工均持有有效健康证。 | – | – |  |
| vf-06-12 | zh | unsupported | not-extracted | 桂花苑食堂每周推出两款新菜品。 | – | – |  |
| vf-06-13 | zh | unsupported | not-extracted | 我公司已为新村食堂采购了一台新的蒸饭柜。 | – | – |  |
| vf-06-14 | zh | unsupported | not-extracted | 新村食堂的租金每年为36万元。 | – | – |  |
| vf-06-15 | zh | unsupported | not-extracted | 桂花苑食堂的厨房于2025年5月完成排烟改造。 | – | – |  |
| vf-06-16 | zh | unsupported | not-extracted | 我公司计划在2027年投资50万元建设中央厨房。 | – | – |  |
| vf-07-01 | zh | supported | not-extracted | 第三季度，江城公交集团纯电动公交车占比达到87%。 | – | 新能源公交季度运营汇报.pptx, slide 2: "纯电动公交车占比达到87%" |  |
| vf-07-02 | zh | contradicted | not-extracted | 第三季度准点率提升至95.3%。 | – | 新能源公交季度运营汇报.pptx, slide 2: "准点率提升至93.5%" |  |
| vf-07-03 | zh | supported | not-extracted | 本季度新增低地板无障碍车辆15辆。 | – | 新能源公交季度运营汇报.pptx, slide 3: "本季度新增低地板无障碍车辆15辆" |  |
| vf-07-04 | zh | supported | not-extracted | 1路日均客流18,600人次，准点率95.2%。 | – | 新能源公交季度运营汇报.pptx, slide 4: "1路 42 18,600 95.2%" |  |
| vf-07-05 | zh | contradicted | not-extracted | 第二座充电站将于2027年1月投入使用，位于高铁西站。 | – | 新能源公交季度运营汇报.pptx, slide 2: "第二座充电站将于2027年1月投入使用，位于北站枢纽" |  |
| vf-07-06 | zh | contradicted | not-extracted | 本季度共更换电池组16套。 | – | 新能源公交季度运营汇报.pptx, slide 5: "本季度更换电池组6套" |  |
| vf-07-07 | zh | contradicted | not-extracted | 夜班线路N3将于11月1日开通。 | – | 新能源公交季度运营汇报.pptx, slide 9: "N3路预计12月1日开通" |  |
| vf-07-08 | zh | contradicted | not-extracted | 乘客支付方式中，公交卡占比最高。 | – | 新能源公交季度运营汇报.pptx, slide 7: "手机扫码: 64, 公交卡: 29, 现金: 7" |  |
| vf-07-09 | zh | supported | not-extracted | 驾驶员疲劳监测系统已覆盖全部车辆。 | – | 新能源公交季度运营汇报.pptx, slide 8: "驾驶员疲劳监测系统已覆盖全部车辆" |  |
| vf-07-10 | zh | unsupported | not-extracted | 目前全市公交线路总数达到186条。 | – | – |  |
| vf-07-11 | zh | unsupported | not-extracted | 集团今年共招聘新驾驶员240名。 | – | – |  |
| vf-07-12 | zh | unsupported | not-extracted | 9路将于明年改为纯电动双层巴士。 | – | – |  |
| vf-07-13 | zh | unsupported | not-extracted | 百公里电耗比去年同期下降了4%。 | – | – |  |
| vf-07-14 | zh | unsupported | not-extracted | 老年人持卡乘车继续免费。 | – | – |  |
| vf-07-15 | zh | unsupported | not-extracted | 高新区自动驾驶接驳线路将投入10辆无人驾驶小巴。 | – | – |  |
| vf-07-16 | zh | unsupported | not-extracted | 第三季度共处理乘客投诉1,250件。 | – | – |  |
| vf-08-01 | zh | supported | not-extracted | 第三季度门店合计销售额为50,525,225元。 | – | 门店销售与库存2026.xlsx, 销售, rows 77–79: "合计销售额 ¥50,525,225" |  |
| vf-08-02 | zh | supported | not-extracted | 人民路广场店（嘉兴）第三季度同比增长22.0%。 | – | 门店销售与库存2026.xlsx, 销售, row 7: "人民路广场店 嘉兴 ¥531,676 22.0%" |  |
| vf-08-03 | zh | contradicted | not-extracted | 复兴路旗舰店第三季度销售额为1,050,573元。 | – | 门店销售与库存2026.xlsx, 销售, rows 69–70: "复兴路旗舰店 温州 ¥1,000,573" |  |
| vf-08-04 | zh | contradicted | not-extracted | 本季度销售数据截止到2026年10月15日。 | – | 门店销售与库存2026.xlsx, 销售, row 81: "数据截止日期 2026-09-30" |  |
| vf-08-05 | zh | supported | not-extracted | 萧山冷链仓有机鲜牛奶库存量为4200，高于3000的安全库存。 | – | 门店销售与库存2026.xlsx, 库存, row 2: "有机鲜牛奶 萧山冷链仓 4200 3000" |  |
| vf-08-06 | zh | contradicted | not-extracted | 鲜榨橙汁库存为2,320，高于安全库存。 | – | 门店销售与库存2026.xlsx, 库存, row 6: "鲜榨橙汁 滨江中心仓 1320 1500" |  |
| vf-08-07 | zh | supported | not-extracted | 鲜榨橙汁的补货周期为2天。 | – | 门店销售与库存2026.xlsx, 库存, row 6: "鲜榨橙汁 滨江中心仓 1320 1500 2" |  |
| vf-08-08 | zh | contradicted | not-extracted | 冷冻水饺存放在滨江中心仓。 | – | 门店销售与库存2026.xlsx, 库存, row 4: "冷冻水饺 萧山冷链仓" |  |
| vf-08-09 | zh | contradicted | not-extracted | 坚果礼盒的补货周期为14天。 | – | 门店销售与库存2026.xlsx, 库存, row 7: "坚果礼盒 余杭常温仓 2780 800 30" |  |
| vf-08-10 | zh | unsupported | not-extracted | 我公司供应的有机鲜牛奶保质期为7天。 | – | – |  |
| vf-08-11 | zh | unsupported | not-extracted | 第三季度我公司向各门店共配送鲜奶18万盒。 | – | – |  |
| vf-08-12 | zh | unsupported | not-extracted | 双方约定的结算周期为月结30天。 | – | – |  |
| vf-08-13 | zh | unsupported | not-extracted | 全麦吐司由我公司旗下烘焙工厂每日供货。 | – | – |  |
| vf-08-14 | zh | unsupported | not-extracted | 第四季度起，鲜奶供货价格上调3%。 | – | – |  |
| vf-08-15 | zh | unsupported | not-extracted | 滨江中心仓于2026年8月完成扩建。 | – | – |  |
| vf-08-16 | zh | unsupported | not-extracted | 手冲咖啡豆的主要产地为云南保山。 | – | – |  |
| vf-09-01 | zh | supported | not-extracted | 2025年，江城市日最高气温超过35℃的天数达到41天。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "2025年日最高气温超过35℃的天数达到41天" |  |
| vf-09-02 | zh | contradicted | not-extracted | 老城区正午地表温度最高达到48.6℃。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "老城区正午地表温度最高达到46.8℃" |  |
| vf-09-03 | zh | contradicted | not-extracted | 老城区绿地率仅为12%。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "老城区的绿地率仅为8%" |  |
| vf-09-04 | zh | supported | not-extracted | 西湖区绿地率最高，达到38%。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "西湖区绿地率最高，达到38%" |  |
| vf-09-05 | zh | unsupported | not-extracted | 北山区夏季平均气温比老城区低2℃。 | – | – |  |
| vf-09-06 | zh | unsupported | not-extracted | 高温天老城区急诊就诊人数增加了三成。 | – | – |  |
| vf-09-07 | zh | unsupported | not-extracted | 临江区居民中有一半以上家中没有空调。 | – | – |  |
| vf-09-08 | zh | supported | not-extracted | 喷雾降温设施每套每小时耗水约45升。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "每套每小时耗水约45升" |  |
| vf-09-09 | zh | contradicted | not-extracted | 行道树每棵种植成本为1,600元。 | – | 城市绿地与夏季降温调查.pdf, p. 3: "行道树 3,400棵 2.9 每棵2,600元" |  |
| vf-09-10 | zh | contradicted | not-extracted | 屋顶绿化在老城区坡屋顶住宅上效果良好，已全面推广。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "试点的六处中有两处出现渗漏，已停止推广" |  |
| vf-09-11 | zh | unsupported | not-extracted | 透水铺装还能减少暴雨时的路面积水。 | – | – |  |
| vf-09-12 | zh | unsupported | not-extracted | 市政府已决定明年新建20处喷雾降温设施。 | – | – |  |
| vf-09-13 | zh | contradicted | not-extracted | 这项调查由江城市气象台完成。 | – | 城市绿地与夏季降温调查.pdf, p. 1: "江城市生态环境研究所工作报告第9号" |  |
| vf-09-14 | zh | unsupported | not-extracted | 调查共花费经费120万元。 | – | – |  |
| vf-09-15 | zh | unsupported | not-extracted | 研究团队共有12名成员。 | – | – |  |
| vf-09-16 | zh | supported | not-extracted | 研究建议优先在老城区和临江区补种行道树。 | – | 城市绿地与夏季降温调查.pdf, p. 3: "建议优先在老城区和临江区补种行道树" |  |
| vf-10-01 | zh | supported | not-extracted | 仓库规定冷冻区温度不得高于零下18度。 | – | 冷链仓库值班手册.txt, line 16: "冷冻区不得高于零下18度" |  |
| vf-10-02 | zh | supported | not-extracted | 停电超过10分钟时须启动备用发电机。 | – | 冷链仓库值班手册.txt, line 26: "停电超过10分钟时，启动备用发电机" |  |
| vf-10-03 | zh | supported | not-extracted | 灭火器每月15日由安保部检查。 | – | 冷链仓库值班手册.txt, line 50: "灭火器每月15日由安保部检查" |  |
| vf-10-04 | zh | supported | not-extracted | 供应商车辆须提前一天预约卸货时段。 | – | 冷链仓库值班手册.txt, line 42: "供应商车辆须提前一天预约卸货时段" |  |
| vf-10-05 | zh | contradicted | not-extracted | 夜班负责人为孙雅琴，交接时间为00:00。 | – | 冷链仓库值班手册.txt, line 9: "夜班 马文涛 00:00" |  |
| vf-10-06 | zh | contradicted | not-extracted | 冷藏车车厢温度高于零下15度的不予接收。 | – | 冷链仓库值班手册.txt, line 43: "车厢温度高于零下12度的不予接收" |  |
| vf-10-07 | zh | contradicted | not-extracted | 制冷机组每四小时巡检一次。 | – | 冷链仓库值班手册.txt, line 54: "制冷机组每两小时巡检一次" |  |
| vf-10-08 | zh | contradicted | not-extracted | 门禁系统在门打开超过60秒后报警。 | – | 冷链仓库值班手册.txt, line 34: "ALARM_DELAY=90" |  |
| vf-10-09 | zh | contradicted | not-extracted | 按规定，外来司机可以进入冷库作业区协助卸货。 | – | 冷链仓库值班手册.txt, line 44: "外来司机不得进入冷库作业区，卸货由本库叉车司机完成。" |  |
| vf-10-10 | zh | unsupported | not-extracted | 仓库冷冻区面积为3,200平方米。 | – | – |  |
| vf-10-11 | zh | unsupported | not-extracted | 现场抽查的12台叉车中有2台电池老化。 | – | – |  |
| vf-10-12 | zh | unsupported | not-extracted | 仓库已通过ISO 22000食品安全管理体系认证。 | – | – |  |
| vf-10-13 | zh | unsupported | not-extracted | 备用发电机每月进行一次带载试运行。 | – | – |  |
| vf-10-14 | zh | unsupported | not-extracted | 温度记录保存期限为两年。 | – | – |  |
| vf-10-15 | zh | unsupported | not-extracted | 仓库共安装了48个监控摄像头。 | – | – |  |
| vf-10-16 | zh | unsupported | not-extracted | 叉车司机每年须参加一次安全培训。 | – | – |  |
