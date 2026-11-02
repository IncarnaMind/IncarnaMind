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
