export interface TooltipMetric {
  label: string;
  value: string;
  ratio: number | null;
}

export interface TooltipModelRow {
  model: string;
  requests: string;
  tokens: string;
  cost: string;
}

export interface UsageTooltipInput {
  title: string;
  metrics: TooltipMetric[];
  models: TooltipModelRow[];
  modelHeading: string;
  modelHeaders: [string, string, string, string];
  reset: string;
  today: string;
  detailsLabel: string;
  refreshLabel: string;
  light: boolean;
}

const DETAILS_COMMAND = "cursor-token-usage.showDetails";
const REFRESH_COMMAND = "cursor-token-usage.refresh";

export function buildUsageTooltipMarkdown(input: UsageTooltipInput): string {
  const parts = [`### $(graph) ${escapeHtml(input.title)}`, "", metricTables(input.metrics, input.light)];
  if (input.models.length > 0) {
    parts.push("", "<hr>", "", `**${escapeHtml(input.modelHeading)}**`, "", modelTable(input));
  }
  const meta = [input.reset, input.today].filter(Boolean);
  if (meta.length > 0) parts.push("", "<hr>", "", meta.join("\n\n"));
  parts.push(
    "",
    "<hr>",
    "",
    `[${escapeHtml(input.detailsLabel)}](command:${DETAILS_COMMAND}) | [${escapeHtml(input.refreshLabel)}](command:${REFRESH_COMMAND})`,
  );
  return parts.join("\n");
}

function metricTables(metrics: TooltipMetric[], light: boolean): string {
  if (metrics.length === 0) return "";
  const rows: string[] = [];
  for (let i = 0; i < metrics.length; i += 2) rows.push(metricPair(metrics[i], metrics[i + 1], light));
  return rows.join("\n\n");
}

function metricPair(left: TooltipMetric, right: TooltipMetric | undefined, light: boolean): string {
  const cells = [metricCell(left, light)];
  if (right) cells.push(metricCell(right, light));
  if (cells.length === 1) {
    return [
      `<table width="100%" cellspacing="0" cellpadding="0">`,
      `<tr><td><sub>${cells[0].label}</sub></td></tr>`,
      `<tr><td><strong>${cells[0].value}</strong></td></tr>`,
      `<tr><td>${cells[0].bar}</td></tr>`,
      `</table>`,
    ].join("\n");
  }
  return [
    `<table width="100%" cellspacing="0" cellpadding="0">`,
    `<tr><td><sub>${cells[0].label}</sub></td><td width="4%"></td><td><sub>${cells[1].label}</sub></td></tr>`,
    `<tr><td><strong>${cells[0].value}</strong></td><td></td><td><strong>${cells[1].value}</strong></td></tr>`,
    `<tr><td>${cells[0].bar}</td><td></td><td>${cells[1].bar}</td></tr>`,
    `</table>`,
  ].join("\n");
}

function metricCell(metric: TooltipMetric, light: boolean): { label: string; value: string; bar: string } {
  return {
    label: escapeHtml(metric.label),
    value: escapeHtml(metric.value),
    bar: metric.ratio === null ? "" : progressBar(metric.ratio, light),
  };
}

function modelTable(input: UsageTooltipInput): string {
  const [model, requests, tokens, cost] = input.modelHeaders.map(escapeHtml);
  const lines = [
    `<table width="100%" cellspacing="0" cellpadding="0">`,
    `<tr><th align="left">${model}</th><th align="right">${requests}</th><th align="right">${tokens}</th><th align="right">${cost}</th></tr>`,
    `<tr><td colspan="4"><hr></td></tr>`,
  ];
  for (const row of input.models) {
    lines.push(
      `<tr><td>${escapeHtml(row.model)}</td><td align="right">${escapeHtml(row.requests)}</td><td align="right">${escapeHtml(row.tokens)}</td><td align="right">${escapeHtml(row.cost)}</td></tr>`,
    );
  }
  lines.push(`</table>`);
  return lines.join("\n");
}

function progressBar(ratio: number, light: boolean): string {
  const width = 200;
  const height = 8;
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  const track = light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.18)";
  const fill = light ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.82)";
  const rect = filled > 0 ? `<rect width="${filled}" height="${height}" rx="4" fill="${fill}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="4" fill="${track}"/>${rect}</svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return `<img src="${uri}" width="${width}" height="${height}" />`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
