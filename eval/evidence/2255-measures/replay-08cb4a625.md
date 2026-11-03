# Replay of the b971c404e runs through 08cb4a625's rules

Every figure that #2397's held-out and tie-out runs at b971c404e bound to a quote (71: 22
held-out, 49 tie-out), as the check read it with `INCARNAMIND_LIVE_MEASURES` set, run again offline
through this change's `measureFinding` (08cb4a625). No prompt is kept, and no model was asked
again: each row is the sentence, the quote Claude Haiku 5.5 recorded, the measure it named, what
#2397's rules made of it in that run (`same` or `unread`, Not checked) and what this change's do.

- `same`: the quote's words are its table cell's own row label or column heading.
- `unknown`: the code can't tell the measure apart, and the check goes on as it did before measures.
- `other-cell`: the quote's words are just the column heading or row label of another number in the
  cell's table; with an equal number, Not checked. None of the 71 comes out so.
- `differs`: Unsupported. None of the 71 does.
- Truth: for the held-out set, which list the sentence is in (right, wrong measure, swap); for the
  tie-out, the memo's own truth for the figure.

## Recall, on the cells both runs checked (Claude Haiku 5.5)

| Code | Tie-out EN (20 cells) | Tie-out ZH (25 cells) | Held-out right, EN / ZH |
|---|---|---|---|
| `main`, its own runs | 20 of 20 | 25 of 25 | 9 / 9 |
| #2397 at b971c404e | 18 of 20 | 21 of 25 | 7 / 8 |
| This change, on b971c404e's replies | 20 of 20 | 25 of 25 | 9 / 10 |

A right figure #2397 held back (`unread`) comes out `same` or `unknown` here, and every check
before the measure's had passed for it, so it is Supported. No wrong measure, swap or wrong figure
was held back by #2397's measure rules alone in those runs, so none becomes Supported here: held-out
wrong measures Supported stay 0 of 10 and 0 of 10, swaps 0 of 5 and 0 of 5.

| # | Set | Lang | Figure | Truth | Sentence | Quote | Measure: sentence / quote / match | #2397 at b971c404e | This change |
|---|---|---|---|---|---|---|---|---|---|
| 1 | held-out | en | 1,840 | right | Harbourline employed 1,840 drivers at the end of 2025. | At the end of 2025 the company employed 1,840 drivers. | drivers employed / employed 1,840 drivers / same | same | unknown |
| 2 | held-out | en | 7% | right | In 2025 freight volumes grew by 7%. | Freight volumes rose 7% in 2025 | freight volumes / Freight volumes / same | same | unknown |
| 3 | held-out | en | 18% | right | Customer complaints fell 18% from 2024. | Customer complaints fell 18% compared with 2024. | customer complaints / Customer complaints / same | same | unknown |
| 4 | held-out | en | 96 million kilometres | right | The fleet covered 96 million kilometres in 2025. | The fleet drove 96 million kilometres over the year. | kilometres covered by the fleet / The fleet drove 96 million kilometres / same | unread | unknown |
| 5 | held-out | en | 11% | right | Carbon emissions per tonne fell 11% in 2025. | Carbon emissions per tonne moved fell 11%. | carbon emissions per tonne / Carbon emissions per tonne moved fell 11% / same | unread | unknown |
| 6 | held-out | en | £38m | right | Capital expenditure came to £38m in 2025. | Capital expenditure was £38m, mostly on electric vans. | Capital expenditure / Capital expenditure / same | same | unknown |
| 7 | held-out | en | 94% | right | Felixstowe's on-time rate was 94% in 2025. | \| Felixstowe \| 94% \| | on-time rate / On-time rate / same | same | same |
| 8 | held-out | en | 94% | swap | Leeds's was 94%. | \| Leeds \| 89% \| | on-time rate / On-time rate / same | same | same |
| 9 | held-out | zh | 1,840名 | right | 2025年末公司有1,840名司机 | 截至2025年末，公司共有司机1,840名。 | 司机人数 / 司机1,840名 / same | unread | unknown |
| 10 | held-out | zh | 1,420万元 | right | 2025年燃油成本为1,420万元 | 全年燃油成本为1,420万元 | 燃油成本 / 全年燃油成本 / same | same | unknown |
| 11 | held-out | zh | 18% | right | 客户投诉比2024年减少了18% | 客户投诉较2024年下降18%。 | 客户投诉 / 客户投诉 / same | same | unknown |
| 12 | held-out | zh | 11% | right | 2025年每吨货物的碳排放下降了11% | 每吨货物的碳排放下降11% | 每吨货物的碳排放下降 / 每吨货物的碳排放下降11% / same | same | unknown |
| 13 | held-out | zh | 0.65元 | right | 末期股息为每股0.65元 | 董事会建议派发末期股息每股0.65元。 | 末期股息每股 / 末期股息每股0.65元 / same | unread | unknown |
| 14 | held-out | zh | 3,800万元 | right | 2025年资本开支为3,800万元 | 资本开支为3,800万元，主要用于电动货车 | 资本开支 / 资本开支 / same | same | unknown |
| 15 | held-out | zh | 94% | right | 苏州仓库2025年准时率为94% | \| 苏州 \| 94% \| | 准时率 / 准时率 / same | same | same |
| 16 | held-out | zh | 11% | swap | 2025年货运量增长11% | 2025年两份零售合同开始执行，货运量增长7%。 | 货运量增长 / 货运量增长 / same | same | unknown |
| 17 | held-out | zh | 7% | swap | 每吨货物的碳排放下降7% | 每吨货物的碳排放下降11%。 | 每吨货物的碳排放下降 / 每吨货物的碳排放下降 / same | same | unknown |
| 18 | held-out | zh | 1,420万元 | swap | 资本开支为1,420万元 | 资本开支为3,800万元，主要用于电动货车 | 资本开支 / 资本开支 / same | same | unknown |
| 19 | held-out | zh | 89% | swap | 苏州仓库2025年准时率为89% | \| 苏州 \| 94% \| | 准时率 / 准时率 / same | same | same |
| 20 | held-out | zh | 94% | swap | 成都仓库为94% | \| 苏州 \| 94% \| ⏎ \| 成都 \| 89% \| | 成都仓库准时率 / 成都 / same | unread | same |
| 21 | held-out | zh | 11% | swap | 客户投诉下降11% | 客户投诉较2024年下降18%。 | 客户投诉下降 / 客户投诉较2024年下降18% / same | unread | unknown |
| 22 | held-out | zh | 18% | swap | 每吨货物的碳排放下降18% | 每吨货物的碳排放下降11%。 | 每吨货物的碳排放下降 / 每吨货物的碳排放下降 / same | same | unknown |
| 23 | tie-out | en | £1,922m | supported | Gross profit was £1,922m | Gross profit ⇥ 1922 ⇥ 1968.3 | Gross profit / Gross profit / same | same | same |
| 24 | tie-out | en | 38.6% | supported | gross margin was 38.6% | Gross margin was 38.6%, against 40.5% in the third quarter of 2025. | gross margin / Gross margin / same | same | unknown |
| 25 | tie-out | en | £4,983m | rounded | Revenue was £4,983m | Revenue was £4,983.4m in the third quarter of 2026 | revenue / Revenue / same | same | unknown |
| 26 | tie-out | en | 40.5% | supported | down from 40.5% a year earlier | Gross margin was 38.6%, against 40.5% in the third quarter of 2025. | gross margin / Gross margin / same | same | unknown |
| 27 | tie-out | en | £4,860m | supported | up from £4,860m a year earlier | up from £4,860.0m a year earlier | revenue / Revenue / same | same | unknown |
| 28 | tie-out | en | 3.1x | supported | leverage was 3.1x on EBITDA of £1,840m | leverage was 3.1x EBITDA of £1,840m | leverage / leverage / same | same | unknown |
| 29 | tie-out | en | £1,840m | supported | leverage was 3.1x on EBITDA of £1,840m | EBITDA ⇥ 1840 ⇥ 1795 | EBITDA / EBITDA / same | same | same |
| 30 | tie-out | en | £248.5m | supported | Capital expenditure was £248.5m in the quarter. | Capital expenditure ⇥ 248.5 ⇥ 231 | Capital expenditure / Capital expenditure / same | same | same |
| 31 | tie-out | en | 2.4% | supported | Like-for-like sales grew 2.4% | Like-for-like sales grew 2.4%, and online sales fell 4.2%. | Like-for-like sales / Like-for-like sales / same | same | unknown |
| 32 | tie-out | en | 3.5x | supported | inside the 3.5x covenant limit | The leverage covenant limit is 3.5x. | covenant limit / The leverage covenant limit is 3.5x / same | unread | unknown |
| 33 | tie-out | en | 14 | supported | The group opened 14 new stores | The group opened 14 new stores and closed 6 in the quarter. | new stores opened / The group opened 14 new stores / same | same | unknown |
| 34 | tie-out | en | 9 | wrong | closed 9 in the quarter | The group opened 14 new stores and closed 6 in the quarter. | stores closed / closed 6 / same | unread | unknown |
| 35 | tie-out | en | 4.2 | supported | the interim dividend is 4.2 pence per share | The interim dividend is 4.2 pence per share. | interim dividend / The interim dividend is 4.2 pence per share / same | same | unknown |
| 36 | tie-out | en | 12.6 million square feet | supported | store space was 12.6 million square feet | store space was 12.6 million square feet | store space / store space / same | same | unknown |
| 37 | tie-out | en | 41,250 people | supported | The group employed 41,250 people | The group employed 41,250 people at the quarter end. | employed / The group employed / same | same | unknown |
| 38 | tie-out | en | 8.4 million | supported | Customer numbers rose to 8.4 million | Customer numbers rose to 8.4 million, and store space was 12.6 million square feet. | customer numbers / Customer numbers / same | same | unknown |
| 39 | tie-out | en | £2,160m | supported | Groceries sold £2,160m | Groceries ⇥ 2160 ⇥ 2100 | Groceries sold / Groceries / same | same | same |
| 40 | tie-out | en | £3,061.4m | supported | Cost of sales was £3,061.4m. | Cost of sales ⇥ 3061.4 ⇥ 2891.7 | Cost of sales / Cost of sales / same | same | same |
| 41 | tie-out | en | £1,420m | supported | fresh food £1,420m | Fresh food ⇥ 1420 ⇥ 1350 | fresh food / Fresh food / same | same | same |
| 42 | tie-out | en | £510m | supported | fuel £510m in the quarter | Fuel ⇥ 510 ⇥ 450 | fuel / Fuel / same | same | same |
| 43 | tie-out | en | £130m | supported | the Other segment £130m in the quarter | Other ⇥ 130 ⇥ 170 | Other segment / Other / same | same | same |
| 44 | tie-out | en | £300m | supported | Clothing brought in £300m | Clothing ⇥ 300 ⇥ 310 | Clothing revenue / Clothing / same | unread | same |
| 45 | tie-out | zh | 40.5% | supported | 上年同期为40.5% | 毛利率为38.6%，2025年第三季度为40.5% | 上年同期毛利率 / 毛利率 / same | unread | unknown |
| 46 | tie-out | zh | 19.22亿元 | supported | 毛利为19.22亿元 | 毛利 ⇥ 1922 ⇥ 1968.3 | 毛利 / 毛利 / same | same | same |
| 47 | tie-out | zh | 38.6% | supported | 毛利率为38.6% | 毛利率为38.6%，2025年第三季度为40.5%。 | 毛利率 / 毛利率 / same | same | unknown |
| 48 | tie-out | zh | 48.60亿元 | supported | 上年同期为48.60亿元 | 上年同期为人民币4,860.0百万元 | 营业收入 / 营业收入 / same | same | unknown |
| 49 | tie-out | zh | 3.5倍 | supported | 低于3.5倍的契约上限 | 杠杆率契约上限为3.5倍 | 契约上限 / 杠杆率契约上限为3.5倍 / same | unread | unknown |
| 50 | tie-out | zh | 2.485亿元 | supported | 本季度资本开支为2.485亿元 | 资本开支 ⇥ 248.5 ⇥ 231 | 资本开支 / 资本开支 / same | same | same |
| 51 | tie-out | zh | 3.1倍 | supported | 杠杆率为3.1倍 | 杠杆率为息税折旧摊销前利润（人民币1,840百万元）的3.1倍 | 杠杆率 / 杠杆率 / same | same | unknown |
| 52 | tie-out | zh | 18.40亿元 | supported | 息税折旧摊销前利润为18.40亿元 | 息税折旧摊销前利润 ⇥ 1840 ⇥ 1795 | 息税折旧摊销前利润 / 息税折旧摊销前利润 / same | same | same |
| 53 | tie-out | zh | 57亿元 | rounded | 净债务为57亿元 | 净债务 ⇥ 5704 | 净债务 / 净债务 / same | same | same |
| 54 | tie-out | zh | 2.4% | supported | 同店销售增长2.4% | 同店销售增长2.4%，线上销售下降4.2%。 | 同店销售增长 / 同店销售增长 / same | same | unknown |
| 55 | tie-out | zh | 4.8% | wrong | 线上销售下降4.8% | 同店销售增长2.4%，线上销售下降4.2%。 | 线上销售 / 线上销售 / same | same | unknown |
| 56 | tie-out | zh | 14家 | supported | 本季度新开门店14家 | 本季度新开门店14家，关闭门店6家。 | 新开门店 / 本季度新开门店14家 / same | same | unknown |
| 57 | tie-out | zh | 41,250人 | supported | 员工人数为41,250人 | 季度末员工人数为41,250人 | 员工人数 / 季度末员工人数 / same | same | unknown |
| 58 | tie-out | zh | 840万 | supported | 客户数量增至840万 | 客户数量增至840万 | 客户数量 / 客户数量增至840万 / same | same | unknown |
| 59 | tie-out | zh | 0.42元 | supported | 中期股息为每股0.42元 | 中期股息为每股0.42元 | 中期股息每股 / 中期股息为每股0.42元 / same | unread | unknown |
| 60 | tie-out | zh | 1,260万 | supported | 门店面积为1,260万平方英尺 | 客户数量增至840万，门店面积为1,260万平方英尺。 | 门店面积 / 门店面积为1,260万平方英尺 / same | unread | unknown |
| 61 | tie-out | zh | 30.614亿元 | supported | 营业成本为30.614亿元 | 营业成本 ⇥ 3061.4 ⇥ 2891.7 | 营业成本 / 营业成本 / same | same | same |
| 62 | tie-out | zh | 5.10亿元 | supported | 燃油5.10亿元 | 燃油 ⇥ 510 ⇥ 450 | 燃油收入 / 燃油 / same | same | same |
| 63 | tie-out | zh | 21.60亿元 | supported | 本季度日用食品收入21.60亿元 | 日用食品 ⇥ 2160 ⇥ 2100 | 日用食品收入 / 日用食品 / same | same | same |
| 64 | tie-out | zh | 3.00亿元 | supported | 本季度服装分部收入3.00亿元 | 服装 ⇥ 300 ⇥ 310 | 服装分部收入 / 服装 / same | same | same |
| 65 | tie-out | zh | 2,160 | supported | 2,160 | 日用食品 ⇥ 2160 ⇥ 2100 | 日用食品 · 2026年第三季度 / 日用食品 / same | same | same |
| 66 | tie-out | zh | 1.30亿元 | supported | “其他”分部收入1.30亿元 | 其他 ⇥ 130 ⇥ 170 | 其他分部收入 / 其他 / same | same | same |
| 67 | tie-out | zh | 1,420 | supported | 1,420 | 生鲜食品 ⇥ 1420 ⇥ 1350 | 生鲜食品收入 / 生鲜食品 / same | same | same |
| 68 | tie-out | zh | 460 | supported | 460 | 线上 ⇥ 460 ⇥ 480 | 线上 · 2026年第三季度 / 线上 / same | same | same |
| 69 | tie-out | zh | 300 | supported | 300 | 服装 ⇥ 300 ⇥ 310 | 服装 · 2026年第三季度 / 服装 / same | same | same |
| 70 | tie-out | zh | 510 | supported | 510 | 燃油 ⇥ 510 | 燃油 / 燃油 / same | same | same |
| 71 | tie-out | zh | 4,980 | total-off | 4,980 | 合计 ⇥ 4980 ⇥ 4860 | 合计 · 2026年第三季度 / 合计 / same | same | same |
