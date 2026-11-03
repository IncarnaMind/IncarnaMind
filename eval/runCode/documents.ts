/**
 * The routing requests' made-up Documents: a CSV past the 20,000 rows an Analysis in Pyodide
 * reads, a small sheet, a web server's access log and an application log (as .txt: a .log file
 * isn't a Document), a DCF workbook with its formulas, and a contract with no numbers to work
 * out. The same every run.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dcfWorkbook } from "../../tests/helpers/financeWorkbooks";
import type { EvalDocument } from "../lib/evaluationSet";

const REGIONS = ["North", "South", "East", "West"];

function orders(): string {
  const lines = ["region,month,amount"];
  for (let row = 0; row < 30_000; row++) {
    lines.push(`${REGIONS[(row * 7) % 4]},${1 + (row % 12)},${((row * 37) % 1000) + 0.5}`);
  }
  return `${lines.join("\n")}\n`;
}

const SALES = [
  "region,quarter,revenue",
  "North,1,120.5",
  "South,1,98",
  "East,1,143.25",
  "North,2,131",
  "South,2,101.5",
  "East,2,150",
  "North,3,128.75",
  "South,3,99",
  "East,3,162",
  "North,4,140",
  "South,4,104",
  "East,4,171.5",
  "",
].join("\n");

function accessLog(): string {
  const lines: string[] = [];
  const paths = ["/", "/login", "/api/orders", "/api/report", "/static/app.js"];
  for (let at = 0; at < 6_000; at++) {
    const second = at * 14;
    const hour = String(Math.floor(second / 3600) % 24).padStart(2, "0");
    const minute = String(Math.floor(second / 60) % 60).padStart(2, "0");
    const status = at % 97 === 0 ? 503 : at % 41 === 0 ? 500 : at % 13 === 0 ? 404 : 200;
    lines.push(
      `203.0.113.${at % 250} - - [01/Oct/2026:${hour}:${minute}:${String(second % 60).padStart(2, "0")} +0000] "GET ${paths[at % 5]} HTTP/1.1" ${status} ${200 + (at % 900)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function appLog(): string {
  const lines: string[] = [];
  for (let at = 0; at < 3_000; at++) {
    if (at % 53 === 0)
      lines.push(
        `2026-10-01 10:${String(at % 60).padStart(2, "0")} ERROR upstream timeout after 30s`,
      );
    else if (at % 71 === 0)
      lines.push(`2026-10-01 10:${String(at % 60).padStart(2, "0")} WARN slow query 2.1s`);
    else lines.push(`2026-10-01 10:${String(at % 60).padStart(2, "0")} INFO request done`);
  }
  return `${lines.join("\n")}\n`;
}

const CONTRACT = [
  "# Supply contract",
  "",
  "Between Northwind Trading and Contoso Foods, signed 3 March 2026.",
  "",
  "## Payment",
  "",
  "Contoso Foods pays each invoice within 45 days of receiving it.",
  "",
  "## Ending the contract",
  "",
  "Either party may end this contract by giving the other 90 days' notice in writing.",
  "",
].join("\n");

export async function writeRoutingDocuments(folder: string): Promise<EvalDocument[]> {
  const files: [string, string | Buffer][] = [
    ["orders.csv", orders()],
    ["sales.csv", SALES],
    ["access.log.txt", accessLog()],
    ["app.log.txt", appLog()],
    ["dcf.xlsx", dcfWorkbook().xlsx()],
    ["supply-contract.md", CONTRACT],
  ];
  const documents: EvalDocument[] = [];
  for (const [name, contents] of files) {
    const path = join(folder, name);
    await writeFile(path, contents);
    documents.push({ key: name, path });
  }
  return documents;
}
