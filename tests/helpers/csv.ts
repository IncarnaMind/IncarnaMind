/** RFC 4180: quoted cells, doubled quotes inside them, line breaks inside quotes. */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const body = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);
  return rows;
}

/** A check record's item rows, by the header's names: the table after its summary. */
export function recordRows(csv: string): Record<string, string>[] {
  const table = parseCsv(csv);
  const at = table.findIndex((each) => each.length === 0 || (each.length === 1 && each[0] === ""));
  const [header = [], ...rows] = table.slice(at + 1);
  const end = rows.findIndex((each) => each.length === 0 || (each.length === 1 && each[0] === ""));
  return rows
    .slice(0, end === -1 ? rows.length : end)
    .map((each) => Object.fromEntries(header.map((name, i) => [name, each[i] ?? ""])));
}
