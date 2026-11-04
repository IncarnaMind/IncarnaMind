/**
 * Which Analysis a request should go to (ADR-0025, #2351): `run_code` for what an Analysis in
 * Pyodide can't do (more rows than it reads, a log, a workbook's own formulas, a shell), and
 * `run_analysis` for the rest, which needs nothing downloaded; neither for a question a search
 * answers. Held out: written before the routing was measured, and never shown to the model in its
 * instructions or a Tool's description, so a run measures how it routes, not what it remembers.
 */
export type Route = "run_code" | "run_analysis" | "none";

export interface RoutingCase {
  id: string;
  language: "en" | "zh-CN";
  question: string;
  route: Route;
}

export const ROUTING_CASES: readonly RoutingCase[] = [
  {
    id: "rows-total",
    language: "en",
    question: "What do the amounts in orders.csv add up to, over every row?",
    route: "run_code",
  },
  {
    id: "rows-region",
    language: "en",
    question: "Across all of orders.csv, which region has the largest total amount?",
    route: "run_code",
  },
  {
    id: "log-hours",
    language: "en",
    question: "In access.log, how many requests came back with a 5xx status in each hour?",
    route: "run_code",
  },
  {
    id: "log-peak",
    language: "en",
    question: "Which hour had the most failed requests in the web server's access log?",
    route: "run_code",
  },
  {
    id: "log-grep",
    language: "en",
    question: "How many lines of app.log mention a timeout?",
    route: "run_code",
  },
  {
    id: "formulas",
    language: "en",
    question:
      "Which formulas in the DCF workbook have a number typed into them instead of pointing at a cell?",
    route: "run_code",
  },
  {
    id: "rows-total-zh",
    language: "zh-CN",
    question: "orders.csv 里所有行的金额加起来是多少？",
    route: "run_code",
  },
  {
    id: "log-hours-zh",
    language: "zh-CN",
    question: "access.log 里每个小时有多少个 5xx 错误？",
    route: "run_code",
  },
  {
    id: "small-total",
    language: "en",
    question: "What was North's total revenue in sales.csv?",
    route: "run_analysis",
  },
  {
    id: "small-average",
    language: "en",
    question: "Which region had the highest average revenue per quarter in the sales sheet?",
    route: "run_analysis",
  },
  {
    id: "small-trend",
    language: "en",
    question: "Fit a straight line to revenue by quarter in sales.csv: what is its slope?",
    route: "run_analysis",
  },
  {
    id: "small-median",
    language: "en",
    question: "What's the median quarterly revenue in sales.csv?",
    route: "run_analysis",
  },
  {
    id: "small-region-zh",
    language: "zh-CN",
    question: "sales.csv 中各地区的收入合计分别是多少？",
    route: "run_analysis",
  },
  {
    id: "text-only",
    language: "en",
    question: "How much notice does the supply contract ask for before ending it?",
    route: "none",
  },
  {
    id: "text-only-zh",
    language: "zh-CN",
    question: "供货合同对付款期限是怎么规定的？",
    route: "none",
  },
];

/**
 * Paraphrases written after the routing was changed on the cases above (#2351 review), and
 * committed before any run on them: the change can't have been fitted to these. The same
 * Documents, in other words, with other figures asked for.
 */
export const FRESH_CASES: readonly RoutingCase[] = [
  {
    id: "fresh-rows-count",
    language: "en",
    question: "How many orders in orders.csv were for more than 500, counting every line of it?",
    route: "run_code",
  },
  {
    id: "fresh-rows-mean",
    language: "en",
    question: "Over the whole of orders.csv, what is the average order amount per region?",
    route: "run_code",
  },
  {
    id: "fresh-log-status",
    language: "en",
    question: "Break down access.log by status code: how many responses of each?",
    route: "run_code",
  },
  {
    id: "fresh-log-slow",
    language: "en",
    question: "Which minute of app.log has the most timeout lines?",
    route: "run_code",
  },
  {
    id: "fresh-log-errors",
    language: "en",
    question: "Count the ERROR lines in app.log for each component.",
    route: "run_code",
  },
  {
    id: "fresh-formulas",
    language: "en",
    question: "List the cells of the DCF workbook whose formula refers to another sheet.",
    route: "run_code",
  },
  {
    id: "fresh-rows-zh",
    language: "zh-CN",
    question: "把 orders.csv 的每一行都算上，金额最大的一笔订单是多少？",
    route: "run_code",
  },
  {
    id: "fresh-log-zh",
    language: "zh-CN",
    question: "access.log 里一共有多少条 404 响应？",
    route: "run_code",
  },
  {
    id: "fresh-small-q2",
    language: "en",
    question: "What did South earn in Q2 according to sales.csv?",
    route: "run_analysis",
  },
  {
    id: "fresh-small-share",
    language: "en",
    question: "What share of total revenue in the sales sheet came from East?",
    route: "run_analysis",
  },
  {
    id: "fresh-small-growth",
    language: "en",
    question: "By how much did North's revenue grow from Q1 to Q3 in sales.csv?",
    route: "run_analysis",
  },
  {
    id: "fresh-small-min",
    language: "en",
    question: "Which quarter and region had the lowest revenue in sales.csv?",
    route: "run_analysis",
  },
  {
    id: "fresh-small-zh",
    language: "zh-CN",
    question: "sales.csv 里每个季度的收入总和是多少？",
    route: "run_analysis",
  },
  {
    id: "fresh-text",
    language: "en",
    question: "Who pays for delivery under the supply contract?",
    route: "none",
  },
  {
    id: "fresh-text-zh",
    language: "zh-CN",
    question: "供货合同里关于违约金是怎么写的？",
    route: "none",
  },
];

/**
 * Requests whose code prints the numbers the Answer gives (#2351): what reaches the Answer marked
 * as calculated by code, and what reaches it unmarked. Written and committed before any run of
 * the marking, and never shown to the model, so they can't have been fitted to it.
 */
export const PRINTED_CASES: readonly RoutingCase[] = [
  {
    id: "printed-log-bytes",
    language: "en",
    question: "How many bytes did access.log serve in total, and how many per request on average?",
    route: "run_code",
  },
  {
    id: "printed-log-paths",
    language: "en",
    question: "Which path is requested most often in access.log? Give the count for every path.",
    route: "run_code",
  },
  {
    id: "printed-log-warnings",
    language: "en",
    question: "How many slow-query warnings are in app.log, out of how many lines altogether?",
    route: "run_code",
  },
  {
    id: "printed-rows-months",
    language: "en",
    question: "Taking every row of orders.csv, what is the total amount for each month?",
    route: "run_code",
  },
  {
    id: "printed-rows-small",
    language: "en",
    question: "How many orders in orders.csv are below 100, and what do those orders come to?",
    route: "run_code",
  },
  {
    id: "printed-rows-regions",
    language: "en",
    question: "Count the orders for each region over the whole of orders.csv.",
    route: "run_code",
  },
  {
    id: "printed-formulas-sheets",
    language: "en",
    question: "How many cells hold a formula on each sheet of the DCF workbook?",
    route: "run_code",
  },
  {
    id: "printed-log-ip-zh",
    language: "zh-CN",
    question: "access.log 里请求次数最多的 IP 地址是哪个？一共请求了多少次？",
    route: "run_code",
  },
  {
    id: "printed-rows-average-zh",
    language: "zh-CN",
    question: "按 orders.csv 的全部行计算，各地区订单的平均金额分别是多少？",
    route: "run_code",
  },
  {
    id: "printed-log-share-zh",
    language: "zh-CN",
    question: "app.log 中 ERROR 行占所有行的百分之多少？",
    route: "run_code",
  },
];
