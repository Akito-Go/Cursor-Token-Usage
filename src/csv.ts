import { UsageEvent } from "./models";

const FORMULA_RE = /^[\t\r]|^\s*[=+\-@]/;

/** Prefix spreadsheet formulas and quote commas, quotes, and newlines. */
export function csvCell(value: unknown): string {
  const text = String(value);
  const safe = FORMULA_RE.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function eventIso(timestamp: number): string {
  const ms = timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

/** Positive API cents become USD. A missing or explicit zero stays blank. */
export function buildEventsCsv(events: readonly UsageEvent[]): string {
  const header = ["Date", "Kind", "Model", "Tokens", "CostUSD"];
  const lines = [header.join(",")];
  for (const event of events) {
    const cost = event.totalCents !== null && event.totalCents > 0 ? (event.totalCents / 100).toFixed(4) : "";
    lines.push([eventIso(event.timestamp), event.kind, event.model, event.totalTokens, cost].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
