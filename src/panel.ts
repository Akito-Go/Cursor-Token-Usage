import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { budgetProgress, BudgetMetric } from "./budget";
import { buildEventsCsv } from "./csv";
import { summarizeModels } from "./modelBreakdown";
import { summarizeToday } from "./today";
import { UsageCategory, modelPool, usageCategory } from "./usageCategory";
import { UsageSnapshot } from "./models";
import { formatCents, formatEventCost, formatEventTime, formatPct, formatTokens, isZh, membershipLabel, shortenModel } from "./treeView";

type SectionId = "today" | "budget" | "trend" | "models" | "recent";
type SectionState = Partial<Record<SectionId, boolean>>;
const SECTION_IDS: readonly SectionId[] = ["today", "budget", "trend", "models", "recent"];
const SECTION_STATE_KEY = "cursorTokenUsage.panelSections";

export class UsagePanel {
  public static current: UsagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly getSnapshot: () => UsageSnapshot | null;
  private readonly getError: () => string | null;
  private sectionState: SectionState;

  static show(
    context: vscode.ExtensionContext,
    getSnapshot: () => UsageSnapshot | null,
    getError: () => string | null,
    onMessage: (command: string) => void,
    onClose?: () => void,
  ): UsagePanel {
    if (UsagePanel.current) {
      UsagePanel.current.refresh();
      UsagePanel.current.panel.reveal();
      return UsagePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "cursorTokenUsage",
      vscode.l10n.t("Cursor Token Usage"),
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    UsagePanel.current = new UsagePanel(panel, getSnapshot, getError, onMessage, onClose, context.globalState);
    context.subscriptions.push(panel);
    return UsagePanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    getSnapshot: () => UsageSnapshot | null,
    getError: () => string | null,
    onMessage: (command: string) => void,
    onClose?: () => void,
    private readonly sectionStorage?: Pick<vscode.Memento, "get" | "update">,
  ) {
    this.panel = panel;
    this.getSnapshot = getSnapshot;
    this.getError = getError;
    this.sectionState = sectionStorage?.get<SectionState>(SECTION_STATE_KEY, {}) || {};
    this.refresh();
    panel.webview.onDidReceiveMessage((msg: { command?: string; section?: string; open?: boolean } | null) => {
      if (!msg) return;
      if (msg.command === "section") {
        const section = msg.section;
        if (section && SECTION_IDS.includes(section as SectionId) && typeof msg.open === "boolean") {
          this.sectionState = { ...this.sectionState, [section]: msg.open };
          void this.sectionStorage?.update(SECTION_STATE_KEY, this.sectionState).then(undefined, () => undefined);
        }
        return;
      }
      if (msg.command === "exportCsv") {
        void this.exportEvents();
        return;
      }
      if (msg.command) onMessage(msg.command);
    });
    panel.onDidDispose(() => {
      if (UsagePanel.current === this) UsagePanel.current = undefined;
      onClose?.();
    });
  }

  refresh(): void {
    this.panel.title = vscode.l10n.t("Cursor Token Usage");
    this.panel.webview.html = renderHtml(this.panel.webview, this.getSnapshot(), this.getError(), this.sectionState);
  }

  updateStatus(stale: boolean): void {
    void this.panel.webview.postMessage({ command: "status", stale, error: this.getError() });
  }

  private async exportEvents(): Promise<void> {
    const snapshot = this.getSnapshot();
    if (!snapshot || snapshot.events.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No usage events to export"));
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `cursor-token-usage-${day}.csv`)),
      filters: { CSV: ["csv"] },
      saveLabel: vscode.l10n.t("Export CSV"),
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`\uFEFF${buildEventsCsv(snapshot.events)}`, "utf8"));
    void vscode.window.showInformationMessage(vscode.l10n.t("Exported {0} usage events", snapshot.events.length));
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function barColor(pct: number): string {
  if (pct >= 100) return "var(--err)";
  if (pct >= 80) return "var(--warn)";
  if (pct >= 40) return "var(--mid)";
  return "var(--ok)";
}

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

function cycleStats(snapshot: UsageSnapshot): { requests: number; costText: string } {
  const rows = summarizeModels(snapshot);
  const requests = rows.reduce((sum, row) => sum + row.requests, 0);
  const hasSpend = rows.some((row) => row.spendCents !== null);
  const spendCents = rows.reduce((sum, row) => sum + (row.spendCents ?? 0), 0);
  return {
    requests,
    costText: hasSpend ? formatCents(spendCents) : vscode.l10n.t("API did not return a cost"),
  };
}

function meter(label: string, valueText: string, pct: number, unlimited = false): string {
  const width = unlimited ? 100 : clampPct(pct);
  const color = unlimited ? "var(--ok)" : barColor(pct);
  const pctLabel = formatPct(pct, unlimited);
  return `<div class="meter">
    <div class="meter-head"><span>${escapeHtml(label)}</span><strong>${escapeHtml(valueText)}</strong></div>
    <div class="track"><div class="fill" style="width:${width}%;background:${color}"></div></div>
    <div class="meter-pct" style="color:${color}">${escapeHtml(pctLabel)}</div>
  </div>`;
}

function usageFace(pct: number, unlimited: boolean): string {
  if (unlimited || pct < 40) return "(^_^)";
  if (pct < 80) return "(・_・)";
  if (pct < 100) return "(>_<)";
  return "(×_×)";
}

function usageFaceLabel(pct: number, unlimited: boolean): string {
  if (unlimited || pct < 40) return vscode.l10n.t("Included usage is comfortable");
  if (pct < 80) return vscode.l10n.t("Included usage is building up");
  if (pct < 100) return vscode.l10n.t("Included usage is running low");
  return vscode.l10n.t("An included pool is over 100%");
}

function ringArc(radius: number, pct: number, color: string, unlimited: boolean): string {
  const length = 2 * Math.PI * radius;
  const shown = unlimited ? 100 : clampPct(pct);
  const offset = length * (1 - shown / 100);
  return `<circle class="ring-fg" cx="64" cy="64" r="${radius}" stroke="${color}"
    stroke-dasharray="${length.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>`;
}

function ring(snapshot: UsageSnapshot, headline: string, sub: string): string {
  const unlimited = snapshot.isUnlimited;
  const overall = snapshot.displayMode === "overall"
    && snapshot.overallUsedCents !== null
    && snapshot.overallLimitCents !== null
    && snapshot.overallLimitCents > 0;
  let graphic: string;
  if (overall) {
    const pct = (snapshot.overallUsedCents! / snapshot.overallLimitCents!) * 100;
    const color = unlimited ? "var(--ok)" : barColor(pct);
    graphic = `<svg viewBox="0 0 128 128" class="ring">
        <circle class="ring-bg" cx="64" cy="64" r="54"></circle>
        ${ringArc(54, pct, color, unlimited)}
      </svg>
      <div class="ring-center" style="color:${color}">${escapeHtml(formatPct(pct, unlimited))}</div>`;
  } else {
    const cursorPct = snapshot.cursorModelsPercent ?? 0;
    const otherPct = snapshot.otherModelsPercent ?? 0;
    const cursorColor = unlimited ? "var(--ok)" : barColor(cursorPct);
    const otherColor = unlimited ? "var(--ok)" : barColor(otherPct);
    graphic = `<svg viewBox="0 0 128 128" class="ring">
        <circle class="ring-bg" cx="64" cy="64" r="54"></circle>
        <circle class="ring-bg ring-bg-inner" cx="64" cy="64" r="40"></circle>
        ${ringArc(54, otherPct, otherColor, unlimited)}
        ${ringArc(40, cursorPct, cursorColor, unlimited)}
      </svg>
      <div class="ring-center"><span class="ring-face" style="color:${unlimited ? "var(--ok)" : barColor(Math.max(cursorPct, otherPct))}" tabindex="0">${usageFace(Math.max(cursorPct, otherPct), unlimited)}<span class="face-tip" role="tooltip">${escapeHtml(usageFaceLabel(Math.max(cursorPct, otherPct), unlimited))}</span></span></div>`;
  }
  return `<div class="hero">
    <div class="ring-wrap">
      ${graphic}
    </div>
    <div class="hero-copy">
      <div class="hero-kicker">${escapeHtml(vscode.l10n.t("Included usage"))}</div>
      <div class="hero-main">${escapeHtml(headline)}</div>
      <div class="hero-sub">${escapeHtml(sub)}</div>
    </div>
  </div>`;
}

function countdown(endIso: string): string {
  if (!endIso) return "";
  const msLeft = Math.max(0, Date.parse(endIso) - Date.now());
  const totalSeconds = Math.ceil(msLeft / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  let text: string;
  if (days > 0) text = vscode.l10n.t("{0}d {1}h", days, hours);
  else if (hours > 0) text = vscode.l10n.t("{0}h {1}m", hours, minutes);
  else text = vscode.l10n.t("{0}m {1}s", minutes, totalSeconds % 60);
  return vscode.l10n.t("Reset in: {0}", text);
}

function eventMs(ts: number): number {
  return ts > 0 && ts < 1e12 ? ts * 1000 : ts;
}

function dayKey(ts: number): string {
  const d = new Date(eventMs(ts));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoDay(value: string): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  return dayKey(ms);
}

function trendRange(snapshot: UsageSnapshot, eventDays: string[]): { minDay: string; maxDay: string } {
  const today = dayKey(Date.now());
  const cycleStart = isoDay(snapshot.billingCycleStart);
  const cycleEnd = isoDay(snapshot.billingCycleEnd);
  const firstEvent = eventDays[0] || today;
  const lastEvent = eventDays[eventDays.length - 1] || today;
  const minDay = cycleStart || firstEvent;
  const maxDay = cycleEnd && cycleEnd < today ? cycleEnd : today;
  if (minDay <= maxDay) return { minDay, maxDay };
  return { minDay: firstEvent, maxDay: lastEvent };
}

function renderTrend(snapshot: UsageSnapshot): string {
  const points = snapshot.events
    .filter((e) => e.timestamp)
    .map((e) => ({
      day: dayKey(e.timestamp),
      model: e.model,
      onDemand: e.kind.includes("USAGE_BASED"),
      pool: modelPool(e.model),
      input: e.inputTokens,
      output: e.outputTokens,
      cache: e.cacheWriteTokens + e.cacheReadTokens,
      tokens: e.totalTokens,
      cents: e.totalCents ?? 0,
    }));
  const models = [...new Set(points.map((p) => p.model))].sort();
  const eventDays = [...new Set(points.map((p) => p.day))].sort();
  const { minDay, maxDay } = trendRange(snapshot, eventDays);
  const payload = JSON.stringify({ points, models, minDay, maxDay }).replace(/</g, "\\u003c");
  const modelOpts = [`<option value="">${escapeHtml(vscode.l10n.t("All models"))}</option>`]
    .concat(models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(shortenModel(m))}</option>`))
    .join("");
  const chartBody = points.length === 0
    ? `<p class="empty">${escapeHtml(vscode.l10n.t("Not enough event data for a trend"))}</p>`
    : `<p class="trend-range" id="trend-range">${escapeHtml(vscode.l10n.t("Detail range: {0} ~ {1} | Metric: {2}", minDay, maxDay, vscode.l10n.t("Tokens")))}</p>
    <div id="trend-chart" class="chart-wrap"><div id="chart-tip" class="chart-tip" hidden></div></div>
    <div class="model-legend" id="trend-legend"></div>
    <script type="application/json" id="trend-data">${payload}</script>`;
  const tools = `
        <label>${escapeHtml(vscode.l10n.t("Usage"))}
          <select id="trend-usage" class="pretty">
            <option value="all">${escapeHtml(vscode.l10n.t("All"))}</option>
            <option value="cursor">${escapeHtml(vscode.l10n.t("Cursor Models"))}</option>
            <option value="other">${escapeHtml(vscode.l10n.t("Other Models"))}</option>
          </select>
        </label>
        <label>${escapeHtml(vscode.l10n.t("Metric"))}
          <select id="trend-metric" class="pretty">
            <option value="token">${escapeHtml(vscode.l10n.t("Tokens"))}</option>
            <option value="requests">${escapeHtml(vscode.l10n.t("Requests"))}</option>
            <option value="cost">${escapeHtml(vscode.l10n.t("Cost"))}</option>
          </select>
        </label>`;
  const body = `
    <div class="trend-filters">
      <label>${escapeHtml(vscode.l10n.t("From"))} <input type="date" id="trend-from" min="${minDay}" max="${maxDay}" value="${minDay}"></label>
      <label>${escapeHtml(vscode.l10n.t("To"))} <input type="date" id="trend-to" min="${minDay}" max="${maxDay}" value="${maxDay}"></label>
      <label>${escapeHtml(vscode.l10n.t("Model"))} <select id="trend-model" class="pretty">${modelOpts}</select></label>
    </div>
    ${chartBody}
    <span hidden id="trend-i18n"
      data-token="${escapeHtml(vscode.l10n.t("Tokens"))}"
      data-requests="${escapeHtml(vscode.l10n.t("Requests"))}"
      data-wan="${isZh() ? "1" : "0"}"
      data-cost="${escapeHtml(vscode.l10n.t("Cost"))}"
      data-range="${escapeHtml(vscode.l10n.t("Detail range: {0} ~ {1} | Metric: {2}", "{0}", "{1}", "{2}"))}"
      data-nocost="${escapeHtml(vscode.l10n.t("API did not return cost"))}"
      data-empty="${escapeHtml(vscode.l10n.t("Not enough event data for a trend"))}"
      data-empty-cursor="${escapeHtml(vscode.l10n.t("No Cursor Models usage in this range"))}"
      data-empty-other="${escapeHtml(vscode.l10n.t("No Other Models usage in this range"))}"
      data-input="${escapeHtml(vscode.l10n.t("Input"))}"
      data-output="${escapeHtml(vscode.l10n.t("Output"))}"
      data-cache="${escapeHtml(vscode.l10n.t("Cache"))}"
      data-line="${escapeHtml(vscode.l10n.t("Trend line"))}"
      data-total="${escapeHtml(vscode.l10n.t("Total"))}"></span>`;
  return staticSection(
    vscode.l10n.t("Usage Trend"),
    vscode.l10n.t("Per-day usage over the selected range"),
    tools,
    body,
  );
}

function heroHeadline(snapshot: UsageSnapshot): string {
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null) {
    return `${formatCents(snapshot.overallUsedCents)} / ${formatCents(snapshot.overallLimitCents)}`;
  }
  const c = formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited);
  const o = formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited);
  return `C ${c}  ·  O ${o}`;
}

function staticSection(title: string, sub: string, tools: string, body: string, titleId = ""): string {
  return `<section class="panel-block">
    <div class="block-head">
      <div>
        <h2${titleId ? ` id="${titleId}"` : ""}>${escapeHtml(title)}</h2>
        ${sub ? `<p class="hint">${escapeHtml(sub)}</p>` : ""}
      </div>
      ${tools ? `<div class="block-tools">${tools}</div>` : ""}
    </div>
    ${body}
  </section>`;
}

function collapsibleSection(
  id: SectionId,
  title: string,
  summary: string,
  body: string,
  open: boolean,
  color = "var(--muted)",
  tools = "",
  sub = "",
  titleId = "",
): string {
  return `<details class="collapsible" data-section="${id}"${open ? " open" : ""}>
    <summary>
      <span class="fold-copy">
        <span class="section-title"${titleId ? ` id="${titleId}"` : ""}>${escapeHtml(title)}</span>
        ${sub ? `<span class="fold-sub">${escapeHtml(sub)}</span>` : ""}
      </span>
      ${summary ? `<span class="section-summary" style="color:${color}">${escapeHtml(summary)}</span>` : ""}
      ${tools ? `<span class="fold-tools" data-no-toggle>${tools}</span>` : ""}
    </summary>
    <div class="collapsible-body">${body}</div>
  </details>`;
}

function renderToday(snapshot: UsageSnapshot, open: boolean): string {
  const today = summarizeToday(snapshot);
  const amount = today.reportedCents === null
    ? vscode.l10n.t("Cost unavailable")
    : today.reportedCents === 0
      ? vscode.l10n.t("API did not return a cost")
      : formatCents(today.reportedCents);
  const scope = today.historyComplete ? vscode.l10n.t("Loaded history for today") : vscode.l10n.t("Partial history: totals include available events only");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = today.models.slice(0, 3).map(row => `<div class="meter-head"><span>${escapeHtml(shortenModel(row.model))}</span><strong>${escapeHtml(formatTokens(row.tokens))}</strong></div>`).join("");
  const partial = !today.historyComplete || today.missingCosts > 0;
  const summary = `${amount} · ${vscode.l10n.t("{0} tokens", formatTokens(today.tokens))}${partial ? ` · ${vscode.l10n.t("Partial data")}` : ""}`;
  return collapsibleSection("today", vscode.l10n.t("Today"), summary, `
    <div class="daily-stats">
      <div class="stat-pill">${escapeHtml(vscode.l10n.t("Reported cost"))}<strong>${escapeHtml(amount)}</strong></div>
      <div class="stat-pill">${escapeHtml(vscode.l10n.t("Tokens"))}<strong>${escapeHtml(formatTokens(today.tokens))}</strong></div>
      <div class="stat-pill">${escapeHtml(vscode.l10n.t("Requests"))}<strong>${today.requests}</strong></div>
    </div>
    <p class="hint">${escapeHtml(scope)} · ${escapeHtml(zone)}</p>
    <p class="hint">${escapeHtml(vscode.l10n.t("Current billing cycle; data as of {0}", snapshot.timestamp.toLocaleString()))}</p>
    ${today.missingCosts ? `<p class="hint">${escapeHtml(vscode.l10n.t("Cost is missing for {0} request(s); only known amounts are shown.", today.missingCosts))}</p>` : ""}
    <p class="hint">${escapeHtml(vscode.l10n.t("Event costs are reported by the API and may differ from the invoice."))}</p>
    ${rows ? `<h2>${escapeHtml(vscode.l10n.t("Top models today"))}</h2>${rows}` : ""}
  `, open, partial ? "var(--warn)" : "var(--muted)");
}

function finitePoolPct(value: number | null, unlimited: boolean): number | null {
  if (unlimited || typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function renderBudget(snapshot: UsageSnapshot, open: boolean): string {
  const config = vscode.workspace.getConfiguration("cursorTokenUsage");
  const progress = budgetProgress(snapshot, config.get("budgetAmount", 0), config.get<BudgetMetric>("budgetMetric", "onDemand"));
  const title = vscode.l10n.t("Allowance alerts");
  const cursorPct = finitePoolPct(snapshot.cursorModelsPercent, snapshot.isUnlimited);
  const otherPct = finitePoolPct(snapshot.otherModelsPercent, snapshot.isUnlimited);
  const pools = [
    cursorPct === null ? "" : meter(vscode.l10n.t("Cursor Models"), formatPct(cursorPct, false), cursorPct),
    otherPct === null ? "" : meter(vscode.l10n.t("Other Models"), formatPct(otherPct, false), otherPct),
  ].filter(Boolean);
  const enabled = config.get("alertEnabled", true);
  const paused = enabled ? "" : ` · ${vscode.l10n.t("Alerts paused")}`;
  const hint = enabled
    ? vscode.l10n.t(pools.length
      ? "Cursor Models and Other Models alert at 50%, 80% and 100%. Reached levels are remembered across reloads."
      : "Alerts at 50%, 80% and 100%; reached levels are remembered across reloads.")
    : vscode.l10n.t("Usage alerts are disabled; amount alerts are paused.");
  if (!pools.length && !progress) return collapsibleSection("budget", title, vscode.l10n.t("Not configured"),
    `<p class="hint">${escapeHtml(vscode.l10n.t("No dollar alert configured. Use Configure Amount Alert to set an amount."))}</p>`, open);
  const label = progress?.metric === "included" ? vscode.l10n.t("Included usage") : vscode.l10n.t("On-Demand");
  if (!pools.length && progress && progress.percent === null) {
    const summary = `${label} · ${vscode.l10n.t("Usage unavailable")}${paused}`;
    const content = `<p>${escapeHtml(label)} · ${escapeHtml(vscode.l10n.t("Amount alert: {0}. Selected usage amount is unavailable.", formatCents(progress.budgetCents)))}</p>`;
    return collapsibleSection("budget", title, summary, `${content}<p class="hint">${escapeHtml(hint)}</p>`, open);
  }
  const dollar = progress && progress.percent !== null
    ? meter(label, `${formatCents(progress.usedCents!)} / ${formatCents(progress.budgetCents)}`, progress.percent)
    : "";
  const summary = [
    cursorPct === null ? "" : `${vscode.l10n.t("Cursor Models")} ${formatPct(cursorPct, false)}`,
    otherPct === null ? "" : `${vscode.l10n.t("Other Models")} ${formatPct(otherPct, false)}`,
    progress && progress.percent !== null
      ? `${label} ${formatCents(progress.usedCents!)} / ${formatCents(progress.budgetCents)} · ${formatPct(progress.percent, false)}`
      : "",
  ].filter(Boolean).join(" · ") + paused;
  const hot = Math.max(cursorPct ?? 0, otherPct ?? 0, progress?.percent ?? 0);
  return collapsibleSection("budget", title, summary, `${pools.join("")}${dollar}<p class="hint">${escapeHtml(hint)}</p>`, open,
    hot >= 80 ? barColor(hot) : "var(--muted)");
}

function categoryLabel(category: UsageCategory): string {
  if (category === "automation") return vscode.l10n.t("Automation");
  if (category === "other") return vscode.l10n.t("Other");
  return vscode.l10n.t("Models");
}

function recentCategoryOptions(snapshot: UsageSnapshot): string {
  const present = new Set(snapshot.events.map((event) => usageCategory(event.model)));
  return (["model", "automation", "other"] as const)
    .filter((category) => present.has(category))
    .map((category) => `<option value="${category}">${escapeHtml(categoryLabel(category))}</option>`)
    .join("");
}

interface ModelViewRow {
  model: string;
  short: string;
  tokens: number;
  tokenText: string;
  inputText: string;
  outputText: string;
  cacheText: string;
  requests: number;
  included: number;
  onDemand: number;
  spendCents: number | null;
  costText: string;
  costMissing: boolean;
  missingCosts: number;
  partial: boolean;
}

function modelViewRows(snapshot: UsageSnapshot): ModelViewRow[] {
  const aggs = new Map(snapshot.aggregations.map((row) => [row.model, row]));
  const breakdown = new Map(summarizeModels(snapshot).map((row) => [row.model, row]));
  const counts = new Map<string, { included: number; onDemand: number; missingCosts: number }>();
  for (const event of snapshot.events) {
    const row = counts.get(event.model) ?? { included: 0, onDemand: 0, missingCosts: 0 };
    if (event.kind.includes("USAGE_BASED")) row.onDemand += 1;
    else row.included += 1;
    if (event.totalCents === null || event.totalCents === 0) row.missingCosts += 1;
    counts.set(event.model, row);
  }
  const names = new Set<string>([...aggs.keys(), ...breakdown.keys()]);
  return [...names].map((model) => {
    const agg = aggs.get(model);
    const info = breakdown.get(model);
    const extra = counts.get(model);
    const tokens = agg?.totalTokens ?? info?.tokens ?? 0;
    const spend = info?.spendCents ?? null;
    return {
      model,
      short: shortenModel(model),
      tokens,
      tokenText: formatTokens(tokens),
      inputText: formatTokens(agg?.inputTokens ?? 0),
      outputText: formatTokens(agg?.outputTokens ?? 0),
      cacheText: formatTokens((agg?.cacheWriteTokens ?? 0) + (agg?.cacheReadTokens ?? 0)),
      requests: info?.requests ?? 0,
      included: extra?.included ?? 0,
      onDemand: extra?.onDemand ?? 0,
      spendCents: spend,
      costText: formatEventCost(spend),
      costMissing: spend == null,
      missingCosts: extra?.missingCosts ?? 0,
      partial: !snapshot.eventsComplete,
    };
  });
}

function modelTip(row: ModelViewRow, metric: "token" | "requests" | "cost"): string {
  const head = `<strong>${escapeHtml(row.model)}</strong>`;
  const partial = row.partial ? `<span class="missing">${escapeHtml(vscode.l10n.t("Partial data"))}</span>` : "";
  if (metric === "requests") {
    return `${head}<span>${escapeHtml(vscode.l10n.t("Requests"))} ${row.requests}</span><span>${escapeHtml(vscode.l10n.t("Included"))} ${row.included}</span><span>${escapeHtml(vscode.l10n.t("On-Demand"))} ${row.onDemand}</span>${partial}`;
  }
  if (metric === "cost") {
    const gap = !row.costMissing && row.missingCosts > 0
      ? `<span class="missing">${escapeHtml(vscode.l10n.t("Cost missing for {0}", row.missingCosts))}</span>`
      : "";
    return `${head}<span${row.costMissing ? ` class="missing"` : ""}>${escapeHtml(vscode.l10n.t("Cost"))} ${escapeHtml(row.costText)}</span>${gap}${partial}`;
  }
  return `${head}<span>${escapeHtml(vscode.l10n.t("Input"))} ${escapeHtml(row.inputText)}</span><span>${escapeHtml(vscode.l10n.t("Output"))} ${escapeHtml(row.outputText)}</span><span>${escapeHtml(vscode.l10n.t("Cache"))} ${escapeHtml(row.cacheText)}</span>${partial}`;
}

function renderModelBars(rows: ModelViewRow[], metric: "token" | "requests" | "cost"): string {
  const valueOf = (row: ModelViewRow) => metric === "requests" ? row.requests : metric === "cost" ? (row.spendCents ?? 0) : row.tokens;
  const total = rows.reduce((sum, row) => sum + valueOf(row), 0) || 1;
  const ranked = rows.slice().sort((a, b) => {
    if (metric === "cost" && a.costMissing !== b.costMissing) return a.costMissing ? 1 : -1;
    return valueOf(b) - valueOf(a) || a.model.localeCompare(b.model);
  }).slice(0, 12);
  const shareLabel = metric === "requests" ? "{0} of requests" : metric === "cost" ? "{0} of cost" : "{0} of total";
  return ranked.map((row) => {
    const value = metric === "requests" ? row.requests : metric === "cost" ? (row.spendCents ?? 0) : row.tokens;
    const share = (value / total) * 100;
    const main = metric === "requests" ? String(row.requests) : metric === "cost" ? row.costText : row.tokenText;
    return `<div class="row clickable" data-filter-model="${escapeHtml(row.model)}">
        <span class="name">${escapeHtml(row.short)}</span>
        <div class="mini-track"><div class="fill" style="width:${clampPct(share)}%"></div></div>
        <span class="num${metric === "cost" && row.costMissing ? " missing" : ""}">${escapeHtml(main)}<small>${escapeHtml(vscode.l10n.t(shareLabel, `${Math.round(share)}%`))}</small></span>
        <span class="row-tip" role="tooltip">${modelTip(row, metric)}</span>
      </div>`;
  }).join("");
}

function recentPayload(snapshot: UsageSnapshot, limit: number): string {
  const rows = snapshot.events.map((event) => ({
    time: formatEventTime(event.timestamp),
    model: event.model,
    short: shortenModel(event.model),
    onDemand: event.kind.includes("USAGE_BASED"),
    tokens: formatTokens(event.totalTokens),
    cost: formatEventCost(event.totalCents),
    costMissing: event.totalCents === null || event.totalCents === 0,
    category: usageCategory(event.model),
  }));
  return JSON.stringify({
    limit,
    title: vscode.l10n.t("Recent Usage ({0} entries)", "{0}"),
    included: vscode.l10n.t("Included"),
    onDemand: vscode.l10n.t("On-Demand"),
    empty: vscode.l10n.t("No data"),
    rows,
  }).replace(/</g, "\\u003c");
}

function renderHtml(webview: vscode.Webview, snapshot: UsageSnapshot | null, error: string | null, sections: SectionState): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const actions = `
    <div class="actions">
      <button data-cmd="refresh">${escapeHtml(vscode.l10n.t("Refresh Token Usage"))}</button>
      <button data-cmd="token">${escapeHtml(vscode.l10n.t("Set Session Token"))}</button>
      <button data-cmd="align">${escapeHtml(vscode.l10n.t("Status bar side"))}</button>
      <button data-cmd="alerts">${escapeHtml(vscode.l10n.t("Configure Usage Alerts"))}</button>
      <button data-cmd="budget">${escapeHtml(vscode.l10n.t("Configure Amount Alert"))}</button>
      <button data-cmd="diagnostics">${escapeHtml(vscode.l10n.t("Connection diagnostics"))}</button>
    </div>`;

  let body: string;
  if (!snapshot) {
    const needToken = !!error && /session token/i.test(error);
    body = `<div class="empty-box">
      <p class="empty">${escapeHtml(error || vscode.l10n.t("Loading..."))}</p>
      ${needToken ? `<p class="empty">${escapeHtml(vscode.l10n.t("Need a Session Token to load usage"))}</p>` : ""}
    </div>${actions}`;
  } else {
    const modelRows = modelViewRows(snapshot);
    const modelBars = renderModelBars(modelRows, "token");
    const modelPayload = JSON.stringify({
      ofTotal: vscode.l10n.t("{0} of total", "{0}"),
      ofRequests: vscode.l10n.t("{0} of requests", "{0}"),
      ofCost: vscode.l10n.t("{0} of cost", "{0}"),
      input: vscode.l10n.t("Input"),
      output: vscode.l10n.t("Output"),
      cache: vscode.l10n.t("Cache"),
      requests: vscode.l10n.t("Requests"),
      included: vscode.l10n.t("Included"),
      onDemand: vscode.l10n.t("On-Demand"),
      cost: vscode.l10n.t("Cost"),
      missingCosts: vscode.l10n.t("Cost missing for {0}", "{0}"),
      partial: vscode.l10n.t("Partial data"),
      totals: {
        tokens: Math.max(1, modelRows.reduce((sum, row) => sum + row.tokens, 0)),
        requests: Math.max(1, modelRows.reduce((sum, row) => sum + row.requests, 0)),
        spend: Math.max(1, modelRows.reduce((sum, row) => sum + (row.spendCents ?? 0), 0)),
      },
      rows: modelRows,
    }).replace(/</g, "\\u003c");

    const displayCount = vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("displayCount", 5);
    const visibleEvents = snapshot.events.slice(0, displayCount);
    const events = visibleEvents.map((e) => {
      const onDemand = e.kind.includes("USAGE_BASED");
      const badge = onDemand ? vscode.l10n.t("On-Demand") : vscode.l10n.t("Included");
      const costMissing = e.totalCents === null || e.totalCents === 0;
      const cost = formatEventCost(e.totalCents);
      return `<tr class="clickable" data-filter-model="${escapeHtml(e.model)}" data-category="${usageCategory(e.model)}">
        <td>${escapeHtml(formatEventTime(e.timestamp))}</td>
        <td>${escapeHtml(shortenModel(e.model))}</td>
        <td><span class="badge ${onDemand ? "od" : "inc"}">${badge}</span></td>
        <td class="num">${escapeHtml(formatTokens(e.totalTokens))}</td>
        <td class="num${costMissing ? " missing" : ""}">${escapeHtml(cost)}</td>
      </tr>`;
    }).join("");

    const cycle = cycleStats(snapshot);
    body = `
      <header>
        <div>
          <h1>${escapeHtml(vscode.l10n.t("Cursor Token Usage"))}</h1>
          <p class="sub">
            <span class="chip">${escapeHtml(membershipLabel(snapshot.membershipType))}</span>
            ${escapeHtml(countdown(snapshot.billingCycleEnd))}
          </p>
        </div>
        <div class="header-stats">
          <div class="stat-pill">${escapeHtml(vscode.l10n.t("Requests"))}<strong>${cycle.requests}</strong></div>
          <div class="stat-pill">${escapeHtml(vscode.l10n.t("Cost"))}<strong>${escapeHtml(cycle.costText)}</strong></div>
          <div class="stat-pill">${escapeHtml(vscode.l10n.t("Total Tokens"))}<strong>${escapeHtml(formatTokens(snapshot.totalTokens))}</strong></div>
        </div>
      </header>
      ${ring(snapshot, heroHeadline(snapshot), countdown(snapshot.billingCycleEnd))}
      ${actions}
      ${renderToday(snapshot, sections.today === true)}
      ${renderBudget(snapshot, sections.budget === true)}
      ${!snapshot.eventsComplete ? `<p class="stale-banner">${escapeHtml(vscode.l10n.t("Usage history is incomplete. Refresh to retry; charts show fetched events only."))}</p>` : ""}
      ${renderTrend(snapshot)}
      ${staticSection(
        vscode.l10n.t("Model usage"),
        vscode.l10n.t("Click a model row to filter the trend"),
        modelBars ? `<label>${escapeHtml(vscode.l10n.t("Metric"))}
          <select id="model-metric" class="pretty">
            <option value="token">${escapeHtml(vscode.l10n.t("Tokens"))}</option>
            <option value="requests">${escapeHtml(vscode.l10n.t("Requests"))}</option>
            <option value="cost">${escapeHtml(vscode.l10n.t("Cost"))}</option>
          </select>
        </label>` : "",
        modelBars
          ? `<div id="model-list">${modelBars}</div><script type="application/json" id="model-data">${modelPayload}</script>`
          : `<p class="empty">${escapeHtml(vscode.l10n.t("No data"))}</p>`,
      )}
      ${staticSection(
        vscode.l10n.t("Recent Usage ({0} entries)", visibleEvents.length),
        "",
        `<label class="recent-filter">${escapeHtml(vscode.l10n.t("Category"))}
              <select id="recent-category">
                <option value="all" selected>${escapeHtml(vscode.l10n.t("All"))}</option>
                ${recentCategoryOptions(snapshot)}
              </select>
            </label>
            <button type="button" data-cmd="exportCsv">${escapeHtml(vscode.l10n.t("Export CSV"))}</button>`,
        `<table id="events-table"><thead><tr><th>${escapeHtml(vscode.l10n.t("Time"))}</th><th>${escapeHtml(vscode.l10n.t("Model"))}</th><th>${escapeHtml(vscode.l10n.t("Kind"))}</th><th>${escapeHtml(vscode.l10n.t("Tokens"))}</th><th>${escapeHtml(vscode.l10n.t("Cost"))}</th></tr></thead><tbody>${events}</tbody></table>
        <script type="application/json" id="recent-data">${recentPayload(snapshot, displayCount)}</script>`,
        "recent-title",
      )}`;
  }

  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language || "en")}">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
:root {
  --bg: var(--vscode-editor-background);
  --card: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  --line: var(--vscode-panel-border, var(--vscode-widget-border, transparent));
  --text: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --ok: var(--vscode-charts-green, #89d185);
  --mid: var(--vscode-charts-yellow, #e2c08d);
  --warn: var(--vscode-charts-orange, #d18616);
  --err: var(--vscode-errorForeground, #f85149);
  --accent: var(--vscode-textLink-foreground);
  --hover: var(--vscode-list-hoverBackground);
  --in: var(--vscode-charts-blue, #4da3ff);
  --out: var(--vscode-charts-green, #89d185);
  --cache: var(--vscode-charts-orange, #d18616);
  --linec: var(--vscode-charts-purple, #b180d7);
  --costc: var(--vscode-charts-blue, #4da3ff);
  --reqc: var(--vscode-charts-yellow, #e2c08d);
  --track: color-mix(in srgb, var(--text) 12%, transparent);
}
html, body {
  margin: 0; padding: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  color-scheme: light dark;
}
.wrap { max-width: 1000px; margin: 0 auto; padding: 20px 18px 36px; }
header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.header-stats { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
header h1 { margin: 0; font-size: 20px; letter-spacing: .01em; }
.sub { margin: 6px 0 0; color: var(--muted); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.chip {
  display: inline-block; padding: 1px 8px; border-radius: 99px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
}
.daily-stats { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.stat-pill { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 8px 12px; color: var(--muted); min-width: 110px; }
.stat-pill strong { display: block; color: var(--text); font-size: 16px; }
.hero {
  display: flex; flex-wrap: wrap; gap: 20px; align-items: center; margin: 18px 0 8px;
  background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px;
}
.ring-wrap { position: relative; width: 128px; height: 128px; flex: 0 0 128px; }
.ring { width: 128px; height: 128px; transform: rotate(-90deg); pointer-events: none; }
.ring-bg { fill: none; stroke: var(--line); stroke-width: 10; }
.ring-bg-inner { stroke-width: 8; }
.ring-fg { fill: none; stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.ring-fg[r="40"] { stroke-width: 8; }
.ring-center { position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 700; pointer-events: none; }
.ring-face { position: relative; pointer-events: auto; font-size: 16px; font-weight: 500; letter-spacing: 0; white-space: nowrap; cursor: default; }
.face-tip {
  display: none; position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%);
  z-index: 20; pointer-events: none; white-space: nowrap;
  background: var(--vscode-editorHoverWidget-background, var(--card));
  color: var(--vscode-editorHoverWidget-foreground, var(--text));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--line));
  border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 500; letter-spacing: 0;
  box-shadow: 0 6px 18px color-mix(in srgb, #000 18%, transparent);
}
.ring-face:hover .face-tip, .ring-face:focus-visible .face-tip { display: block; }
.hero-copy { flex: 1; min-width: 180px; }
.block-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.block-head h2 { margin: 0; }
.block-head .hint { margin: 2px 0 0; }
.block-tools { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
.hero-kicker { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.hero-main { font-size: 22px; font-weight: 700; margin: 4px 0; font-variant-numeric: tabular-nums; }
.hero-sub { color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
button {
  background: transparent;
  color: var(--text);
  border: 1px solid color-mix(in srgb, var(--text) 14%, transparent);
  border-radius: 6px; padding: 4px 10px; cursor: pointer;
  font: inherit; font-size: 12px; font-weight: 500;
}
button:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
.section-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.section-head h2 { margin-bottom: 0; }
.section-actions { display: flex; align-items: center; gap: 8px; }
.recent-filter { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
td.name { text-align: left; }
section, .collapsible { background: var(--card); border: 1px solid color-mix(in srgb, var(--text) 12%, transparent); border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
.collapsible { padding: 0; }
.collapsible > summary { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; list-style: none; border-radius: 8px; }
.collapsible > summary::-webkit-details-marker { display: none; }
.collapsible > summary::marker { content: ""; }
.collapsible > summary::before { content: "›"; flex: 0 0 auto; font-size: 16px; line-height: 1; color: var(--muted); transition: transform .15s; }
.collapsible[open] > summary::before { transform: rotate(90deg); }
.collapsible > summary:hover { background: var(--hover); }
.collapsible > summary:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--accent)); outline-offset: -2px; }
.fold-copy { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.section-title { font-weight: 600; font-size: 13px; }
.fold-sub { color: var(--muted); font-size: 11px; font-weight: 400; }
.section-summary { margin-left: auto; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.fold-tools { margin-left: auto; display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
.section-summary + .fold-tools { margin-left: 12px; }
.collapsible-body { padding: 4px 16px 14px; }
@media (max-width: 540px) {
  .wrap { padding: 14px 10px 24px; }
  .collapsible > summary { flex-wrap: wrap; gap: 6px 10px; }
  .section-summary, .fold-tools { flex-basis: 100%; margin-left: 18px; text-align: left; justify-content: flex-start; }
  .block-tools { flex-basis: 100%; margin-left: 0; justify-content: flex-start; }
  .trend-filters { width: 100%; }
  #trend-model { max-width: 100%; }
}
h2 { margin: 0 0 8px; font-size: 13px; color: var(--text); font-weight: 600; letter-spacing: -0.005em; }
.hint { margin: 0 0 10px; color: var(--muted); font-size: 11px; }
.meter { margin: 0 -8px 8px; padding: 8px; border-radius: 8px; transition: background .15s; }
.meter:hover { background: var(--hover); }
.meter-head { display: flex; justify-content: space-between; margin-bottom: 6px; }
.meter-pct { text-align: right; font-size: 11px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.track, .mini-track { height: 10px; background: var(--track); border-radius: 99px; overflow: hidden; }
.fill { height: 100%; border-radius: 99px; background: var(--ok); position: relative; transition: width .5s ease; }
.row { position: relative; display: grid; grid-template-columns: 150px 1fr minmax(110px, max-content); gap: 10px; align-items: center; margin: 4px -8px; padding: 6px 8px; border-radius: 8px; }
.num.missing { color: var(--muted); }
.row-tip {
  display: none; position: fixed; z-index: 20; left: 0; top: 0;
  flex-direction: column; gap: 2px; min-width: 140px; pointer-events: none; white-space: nowrap;
  background: var(--vscode-editorHoverWidget-background, var(--card));
  color: var(--vscode-editorHoverWidget-foreground, var(--text));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--line));
  border-radius: 6px; padding: 8px 10px; font-size: 12px;
  box-shadow: 0 6px 18px color-mix(in srgb, #000 18%, transparent);
}
.row-tip.show { display: flex; }
.row-tip strong { font-size: 12px; }
.row-tip .missing { color: var(--muted); }
.name { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.num small { display: block; color: var(--muted); font-size: 11px; }
.clickable { cursor: pointer; }
.clickable:hover, tr.clickable:hover td { background: var(--hover); }
.chart-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.chart-header h2 { margin: 0; }
.chart-header .hint { margin: 2px 0 0; }
.chart-filters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.chart-filters label, .trend-filters label, .recent-filter { color: var(--muted); font-size: 11px; font-weight: 500; display: inline-flex; gap: 6px; align-items: center; }
select.pretty, #recent-category, .trend-filters input[type="date"] {
  background-color: color-mix(in srgb, var(--text) 16%, var(--card));
  color: var(--text);
  border: 1px solid color-mix(in srgb, var(--text) 10%, transparent);
  border-radius: 6px;
  font: inherit; font-size: 12px; color-scheme: inherit;
}
select.pretty, #recent-category {
  appearance: none; -webkit-appearance: none; cursor: pointer; font-weight: 500;
  padding: 4px 26px 4px 10px;
  background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 14px) calc(50% - 1px), calc(100% - 9px) calc(50% - 1px);
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.trend-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.trend-filters input[type="date"] {
  padding: 4px 8px;
}
.trend-range { color: var(--muted); margin: 0 0 8px; font-size: 11px; }
.chart-wrap { position: relative; background: transparent; border: 0; padding: 0; min-height: 240px; }
.chart-wrap svg { width: 100%; height: 260px; display: block; }
.model-legend { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 16px; margin-top: 8px; color: var(--muted); font-size: 12px; }
.model-legend span { display: inline-flex; align-items: center; gap: 6px; }
.model-legend i, .chart-tip .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
.chart-tip {
  position: absolute; pointer-events: none; z-index: 5;
  background: var(--vscode-editorHoverWidget-background, var(--card));
  color: var(--vscode-editorHoverWidget-foreground, var(--text));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--line));
  border-radius: 6px; padding: 8px 10px; font-size: 12px; white-space: nowrap;
  box-shadow: 0 6px 18px color-mix(in srgb, #000 18%, transparent);
}
.chart-tip strong { display: block; margin-bottom: 4px; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: center; color: var(--muted); font-size: 12px; margin: 10px 0 0; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 99px; margin-right: 4px; }
.dot.in { background: var(--in); }
.dot.out { background: var(--out); }
.dot.cache { background: var(--cache); }
.dot.line { background: var(--linec); }
.dot.cost { background: var(--costc); }
.chart-empty { color: var(--muted); padding: 40px 12px; text-align: center; }
.stale-banner {
  margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; font-size: 12px;
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--text); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: center; padding: 8px 4px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; }
table td.num { text-align: center; }
td.missing { color: var(--muted); }
.badge { font-size: 11px; border-radius: 99px; padding: 1px 8px; }
.badge.inc { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.badge.od { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.empty { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
<p class="stale-banner" id="error-banner" role="status" ${error && snapshot ? "" : "hidden"}>${escapeHtml(error || "")}</p>
<p class="stale-banner" id="stale-banner" hidden>${escapeHtml(vscode.l10n.t("Status bar updated. Click Refresh for details."))}</p>
${body}
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function readViewState() {
  return (typeof vscode.getState === "function" && vscode.getState()) || {};
}
function saveViewState(patch) {
  if (typeof vscode.setState === "function") vscode.setState({ ...readViewState(), ...patch });
}
for (const section of document.querySelectorAll("details[data-section]")) {
  const id = section.dataset.section;
  const savedOpen = readViewState().sections?.[id];
  if (typeof savedOpen === "boolean") section.open = savedOpen;
  section.addEventListener("toggle", () => {
    saveViewState({ sections: { ...readViewState().sections, [id]: section.open } });
    vscode.postMessage({ command: "section", section: id, open: section.open });
  });
}
for (const tools of document.querySelectorAll("[data-no-toggle]")) {
  tools.addEventListener("click", (event) => event.preventDefault());
}
(function () {
  const dataEl = document.getElementById("model-data");
  const list = document.getElementById("model-list");
  const select = document.getElementById("model-metric");
  if (!dataEl || !list || !select) return;
  const payload = JSON.parse(dataEl.textContent || "{}");
  const rows = payload.rows || [];
  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function placeTip(tip, event) {
    tip.classList.add("show");
    const width = tip.offsetWidth || 160;
    const height = tip.offsetHeight || 72;
    const boundsW = window.innerWidth || 0;
    const boundsH = window.innerHeight || 0;
    let x = event.clientX + 14;
    let y = event.clientY + 16;
    if (boundsW && x + width > boundsW - 8) x = event.clientX - width - 14;
    if (boundsH && y + height > boundsH - 8) y = event.clientY - height - 16;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function tipFor(row, metric) {
    const head = "<strong>" + esc(row.model) + "</strong>";
    const partial = row.partial ? '<span class="missing">' + esc(payload.partial || "") + "</span>" : "";
    if (metric === "requests") {
      return head
        + "<span>" + esc(payload.requests) + " " + row.requests + "</span>"
        + "<span>" + esc(payload.included) + " " + row.included + "</span>"
        + "<span>" + esc(payload.onDemand) + " " + row.onDemand + "</span>"
        + partial;
    }
    if (metric === "cost") {
      const gap = !row.costMissing && row.missingCosts > 0
        ? '<span class="missing">' + esc(String(payload.missingCosts || "").replace("{0}", String(row.missingCosts))) + "</span>"
        : "";
      return head + "<span" + (row.costMissing ? ' class="missing"' : "") + ">" + esc(payload.cost) + " " + esc(row.costText) + "</span>" + gap + partial;
    }
    return head
      + "<span>" + esc(payload.input) + " " + esc(row.inputText) + "</span>"
      + "<span>" + esc(payload.output) + " " + esc(row.outputText) + "</span>"
      + "<span>" + esc(payload.cache) + " " + esc(row.cacheText) + "</span>"
      + partial;
  }
  function render(metric) {
    const valueOf = (row) => metric === "requests" ? row.requests : metric === "cost" ? (row.spendCents || 0) : row.tokens;
    const totals = payload.totals || {};
    const total = metric === "requests" ? (totals.requests || 1) : metric === "cost" ? (totals.spend || 1) : (totals.tokens || 1);
    const shareTpl = metric === "requests" ? payload.ofRequests : metric === "cost" ? payload.ofCost : payload.ofTotal;
    const ranked = rows.slice().sort((a, b) => {
      if (metric === "cost" && a.costMissing !== b.costMissing) return a.costMissing ? 1 : -1;
      return valueOf(b) - valueOf(a) || String(a.model).localeCompare(String(b.model));
    }).slice(0, 12);
    list.innerHTML = ranked.map((row) => {
      const value = valueOf(row);
      const pct = Math.max(0, Math.min(100, (value / total) * 100));
      const main = metric === "requests" ? String(row.requests) : metric === "cost" ? row.costText : row.tokenText;
      const share = String(shareTpl || "{0}").replace("{0}", Math.round(pct) + "%");
      const missing = metric === "cost" && row.costMissing ? " missing" : "";
      return '<div class="row clickable" data-filter-model="' + esc(row.model) + '">'
        + '<span class="name">' + esc(row.short) + "</span>"
        + '<div class="mini-track"><div class="fill" style="width:' + pct + '%"></div></div>'
        + '<span class="num' + missing + '">' + esc(main) + "<small>" + esc(share) + "</small></span>"
        + '<span class="row-tip" role="tooltip">' + tipFor(row, metric) + "</span></div>";
    }).join("");
  }
  list.addEventListener("mousemove", (event) => {
    const row = event.target.closest && event.target.closest(".row");
    list.querySelectorAll(".row-tip.show").forEach((tip) => { if (!row || tip.parentElement !== row) tip.classList.remove("show"); });
    if (!row) return;
    const tip = row.querySelector(".row-tip");
    if (tip) placeTip(tip, event);
  });
  list.addEventListener("mouseleave", () => {
    list.querySelectorAll(".row-tip.show").forEach((tip) => tip.classList.remove("show"));
  });
  const saved = readViewState().modelMetric;
  const metric = saved === "requests" || saved === "cost" ? saved : "token";
  select.value = metric;
  if (metric !== "token") render(metric);
  select.addEventListener("change", () => {
    const next = select.value === "requests" || select.value === "cost" ? select.value : "token";
    saveViewState({ modelMetric: next });
    render(next);
  });
})();
window.addEventListener("message", (event) => {
  const banner = document.getElementById("stale-banner");
  if (event.data && event.data.command === "status") {
    if (banner && event.data.stale) banner.hidden = false;
    const errorBanner = document.getElementById("error-banner");
    if (errorBanner) {
      errorBanner.textContent = event.data.error || "";
      errorBanner.hidden = !event.data.error;
    }
  }
});
for (const btn of document.querySelectorAll("[data-cmd]")) {
  btn.addEventListener("click", () => vscode.postMessage({ command: btn.dataset.cmd }));
}
(function () {
  const dataEl = document.getElementById("recent-data");
  const table = document.getElementById("events-table");
  const select = document.getElementById("recent-category");
  const title = document.getElementById("recent-title");
  if (!dataEl || !table || !select) return;
  const payload = JSON.parse(dataEl.textContent || "{}");
  const body = table.querySelector("tbody");
  if (!body) return;
  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function render(category) {
    const matched = (payload.rows || []).filter((row) => category === "all" || row.category === category);
    const visible = matched.slice(0, payload.limit || matched.length);
    if (title && payload.title) title.textContent = String(payload.title).replace("{0}", String(visible.length));
    if (visible.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="empty">' + esc(payload.empty || "") + "</td></tr>";
      return;
    }
    body.innerHTML = visible.map((row) => {
      const badge = row.onDemand ? payload.onDemand : payload.included;
      const missing = row.costMissing ? " missing" : "";
      return '<tr class="clickable" data-filter-model="' + esc(row.model) + '" data-category="' + esc(row.category) + '">' +
        "<td>" + esc(row.time) + "</td><td>" + esc(row.short) + "</td>" +
        '<td><span class="badge ' + (row.onDemand ? "od" : "inc") + '">' + esc(badge) + "</span></td>" +
        '<td class="num">' + esc(row.tokens) + '</td><td class="num' + missing + '">' + esc(row.cost) + "</td></tr>";
    }).join("");
  }
  const saved = readViewState().recentCategory;
  if (typeof saved === "string" && Array.from(select.options).some((option) => option.value === saved)) select.value = saved;
  if (select.value !== "all") render(select.value);
  select.addEventListener("change", () => {
    saveViewState({ recentCategory: select.value });
    render(select.value || "all");
  });
})();
(function () {
  const dataEl = document.getElementById("trend-data");
  const chartEl = document.getElementById("trend-chart");
  if (!dataEl || !chartEl) return;
  const i18n = document.getElementById("trend-i18n");
  const tpl = (i18n && i18n.dataset.range) || "{0} ~ {1} | {2}";
  const fmt = (s, a, b, c) => s.replace("{0}", a).replace("{1}", b).replace("{2}", c);
  const payload = JSON.parse(dataEl.textContent || "{}");
  const points = payload.points || [];
  const minDay = payload.minDay || "";
  const maxDay = payload.maxDay || "";
  const saved = readViewState();
  let metric = saved.metric === "cost" || saved.metric === "requests" ? saved.metric : "token";
  let usage = saved.usage === "cursor" || saved.usage === "other" ? saved.usage : "all";
  let model = typeof saved.model === "string" ? saved.model : "";
  function isoAdd(iso, n) {
    const parts = iso.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2] + n);
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  }
  let from = saved.from && saved.from >= minDay && saved.from <= maxDay ? saved.from : minDay;
  let to = saved.to && saved.to >= minDay && saved.to <= maxDay ? saved.to : maxDay;
  if (from > to) { from = minDay; to = maxDay; }

  function persist() {
    saveViewState({ metric, usage, model, from, to });
  }
  function eachDay(a, b) {
    const out = [];
    if (!a || !b || a > b) return out;
    for (let d = a, i = 0; d <= b && i < 400; d = isoAdd(d, 1), i++) out.push(d);
    return out;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / p) * p;
  }
  function fmtNum(v, cost) {
    if (cost) return "$" + (v / 100).toFixed(2);
    const wan = i18n && i18n.dataset.wan === "1";
    function compact(n, suffix) {
      const text = n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\\.0$/, "");
      return text + suffix;
    }
    if (wan && v >= 10000) return compact(v / 10000, "万");
    if (v >= 1e6) return compact(v / 1e6, "M");
    if (v >= 1e3) return compact(v / 1e3, "K");
    return String(Math.round(v));
  }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function spline(pts) {
    if (pts.length < 2) return "";
    let d = "M " + pts[0][0] + " " + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      d += " C " + (p1[0] + (p2[0] - p0[0]) / 6) + " " + (p1[1] + (p2[1] - p0[1]) / 6) + ", "
        + (p2[0] - (p3[0] - p1[0]) / 6) + " " + (p2[1] - (p3[1] - p1[1]) / 6) + ", "
        + p2[0] + " " + p2[1];
    }
    return d;
  }
  function axisDay(iso) {
    const parts = iso.split("-");
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (i18n && i18n.dataset.wan === "1") return month + "/" + day;
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return (names[month - 1] || "") + " " + day;
  }
  function aggregate() {
    let filtered = points;
    if (model) filtered = filtered.filter((p) => p.model === model);
    if (usage === "cursor") filtered = filtered.filter((p) => p.pool === "cursor");
    if (usage === "other") filtered = filtered.filter((p) => p.pool === "other");
    const map = {};
    for (const p of filtered) {
      if ((from && p.day < from) || (to && p.day > to)) continue;
      if (!map[p.day]) map[p.day] = { day: p.day, input: 0, output: 0, cache: 0, tokens: 0, cents: 0, requests: 0 };
      map[p.day].input += p.input || 0;
      map[p.day].output += p.output || 0;
      map[p.day].cache += p.cache || 0;
      map[p.day].tokens += p.tokens || 0;
      map[p.day].cents += p.cents > 0 ? p.cents : 0;
      map[p.day].requests += 1;
    }
    return eachDay(from, to).map((day) => map[day] || { day, input: 0, output: 0, cache: 0, tokens: 0, cents: 0, requests: 0 });
  }
  function stackTotal(d) {
    if (metric === "cost") return d.cents;
    if (metric === "requests") return d.requests;
    return d.input + d.output + d.cache;
  }
  function hideTip() {
    const tip = document.getElementById("chart-tip");
    if (tip) tip.hidden = true;
  }
  function showTip(ev, html) {
    let tip = document.getElementById("chart-tip");
    if (!tip) {
      tip = document.createElement("div");
      tip.id = "chart-tip";
      tip.className = "chart-tip";
      chartEl.appendChild(tip);
    }
    tip.hidden = false;
    tip.innerHTML = html;
    const r = chartEl.getBoundingClientRect();
    const tw = tip.offsetWidth || 160;
    const th = tip.offsetHeight || 80;
    let x = ev.clientX - r.left + 12;
    let y = ev.clientY - r.top + 12;
    if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 8;
    if (y + th > r.height - 8) y = ev.clientY - r.top - th - 8;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function legendItem(color, label) {
    return '<span><i style="background:' + color + '"></i>' + esc(label) + "</span>";
  }
  function tipHtml(d) {
    const inputL = (i18n && i18n.dataset.input) || "Input";
    const outputL = (i18n && i18n.dataset.output) || "Output";
    const cacheL = (i18n && i18n.dataset.cache) || "Cache";
    const totalL = (i18n && i18n.dataset.total) || "Total";
    const costL = (i18n && i18n.dataset.cost) || "Cost";
    const reqL = (i18n && i18n.dataset.requests) || "Requests";
    const head = "<strong>" + esc(axisDay(d.day)) + "</strong>";
    if (metric === "cost") return head + "<div>" + esc(costL) + ": " + fmtNum(d.cents, true) + "</div>";
    if (metric === "requests") return head + "<div>" + esc(reqL) + ": " + fmtNum(d.requests, false) + "</div>";
    return head
      + "<div>" + esc(totalL) + ": " + fmtNum(d.tokens, false) + "</div>"
      + "<div>" + esc(inputL) + ": " + fmtNum(d.input, false) + "</div>"
      + "<div>" + esc(outputL) + ": " + fmtNum(d.output, false) + "</div>"
      + "<div>" + esc(cacheL) + ": " + fmtNum(d.cache, false) + "</div>";
  }
  function updateLegend() {
    const el = document.getElementById("trend-legend");
    if (!el) return;
    const inputL = (i18n && i18n.dataset.input) || "Input";
    const outputL = (i18n && i18n.dataset.output) || "Output";
    const cacheL = (i18n && i18n.dataset.cache) || "Cache";
    const lineL = (i18n && i18n.dataset.line) || "Trend";
    const costL = (i18n && i18n.dataset.cost) || "Cost";
    const reqL = (i18n && i18n.dataset.requests) || "Requests";
    if (metric === "cost") el.innerHTML = legendItem("var(--costc)", costL) + legendItem("var(--linec)", lineL);
    else if (metric === "requests") el.innerHTML = legendItem("var(--reqc)", reqL) + legendItem("var(--linec)", lineL);
    else el.innerHTML = legendItem("var(--in)", inputL) + legendItem("var(--out)", outputL) + legendItem("var(--cache)", cacheL) + legendItem("var(--linec)", lineL);
  }
  function render() {
    persist();
    const days = aggregate();
    updateLegend();
    const rangeEl = document.getElementById("trend-range");
    const metricLabel = metric === "cost" ? ((i18n && i18n.dataset.cost) || "Cost") : metric === "requests" ? ((i18n && i18n.dataset.requests) || "Requests") : ((i18n && i18n.dataset.token) || "Tokens");
    if (rangeEl) rangeEl.textContent = fmt(tpl, from || "—", to || "—", metricLabel);
    hideTip();
    if (!days.length) {
      chartEl.innerHTML = '<p class="chart-empty">' + ((i18n && i18n.dataset.empty) || "") + "</p>";
      return;
    }
    if (metric === "cost" && !days.some((d) => d.cents > 0)) {
      chartEl.innerHTML = '<p class="chart-empty">' + ((i18n && i18n.dataset.nocost) || "") + "</p>";
      return;
    }
    const W = Math.max(280, chartEl.clientWidth - 16 || 640), H = 300, L = 52, R = 8, T = 12, B = 36;
    const plotW = W - L - R, plotH = H - T - B;
    const maxRaw = Math.max(0, ...days.map(stackTotal));
    if (maxRaw <= 0) {
      const msg = usage === "cursor"
        ? (i18n && i18n.dataset.emptyCursor)
        : usage === "other"
          ? (i18n && i18n.dataset.emptyOther)
          : (i18n && i18n.dataset.empty);
      chartEl.innerHTML = '<p class="chart-empty">' + (msg || "") + "</p>";
      return;
    }
    const maxY = niceMax(maxRaw);
    const n = days.length;
    const slot = plotW / Math.max(1, n);
    const barW = Math.min(28, Math.max(4, slot * 0.62));
    const labelStep = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 64))));
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => maxY * t);
    let grid = "";
    for (const t of yTicks) {
      const y = T + plotH - (maxY ? (t / maxY) * plotH : 0);
      grid += '<line x1="' + L + '" y1="' + y + '" x2="' + (W - R) + '" y2="' + y + '" stroke="var(--line)" stroke-dasharray="3 3"/>';
      grid += '<text x="' + (L - 8) + '" y="' + (y + 3) + '" text-anchor="end" font-size="11" fill="var(--muted)">' + fmtNum(t, metric === "cost") + "</text>";
    }
    let bars = "";
    let hits = "";
    const linePts = [];
    days.forEach((d, i) => {
      const x = L + slot * i + (slot - barW) / 2;
      const parts = metric === "cost"
        ? [{ h: maxY ? (d.cents / maxY) * plotH : 0, fill: "var(--costc)" }]
        : metric === "requests"
          ? [{ h: maxY ? (d.requests / maxY) * plotH : 0, fill: "var(--reqc)" }]
          : [
              { h: maxY ? (d.input / maxY) * plotH : 0, fill: "var(--in)" },
              { h: maxY ? (d.output / maxY) * plotH : 0, fill: "var(--out)" },
              { h: maxY ? (d.cache / maxY) * plotH : 0, fill: "var(--cache)" },
            ];
      let y = T + plotH;
      parts.forEach((part, idx) => {
        if (part.h <= 0) return;
        y -= part.h;
        const top = parts.slice(idx + 1).every((next) => next.h <= 0);
        bars += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + part.h + '" fill="' + part.fill + '"' + (top ? ' rx="2"' : "") + "/>";
      });
      linePts.push([x + barW / 2, y]);
      hits += '<rect class="hit" data-i="' + i + '" x="' + (L + slot * i) + '" y="' + T + '" width="' + slot + '" height="' + plotH + '" fill="transparent"/>';
      if (i % labelStep === 0 || i === n - 1) {
        bars += '<text x="' + (x + barW / 2) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + axisDay(d.day) + "</text>";
      }
    });
    const line = '<path d="' + spline(linePts) + '" fill="none" stroke="var(--linec)" stroke-width="2" pointer-events="none"/>';
    chartEl.innerHTML = '<div id="chart-tip" class="chart-tip" hidden></div><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + bars + line + hits + "</svg>";
    chartEl.querySelectorAll(".hit").forEach((el) => {
      const i = Number(el.getAttribute("data-i"));
      el.addEventListener("mousemove", (ev) => showTip(ev, tipHtml(days[i])));
      el.addEventListener("mouseleave", hideTip);
    });
  }
  const usageEl = document.getElementById("trend-usage");
  const metricEl = document.getElementById("trend-metric");
  if (usageEl) {
    usageEl.value = usage;
    usageEl.addEventListener("change", () => { usage = usageEl.value || "all"; render(); });
  }
  if (metricEl) {
    metricEl.value = metric;
    metricEl.addEventListener("change", () => { metric = metricEl.value || "token"; render(); });
  }
  const sel = document.getElementById("trend-model");
  if (sel) {
    if (model && [...sel.options].some((o) => o.value === model)) sel.value = model;
    else model = "";
    sel.addEventListener("change", () => { model = sel.value; render(); });
  }
  const fromEl = document.getElementById("trend-from");
  const toEl = document.getElementById("trend-to");
  if (fromEl) { fromEl.value = from; fromEl.addEventListener("change", () => { from = fromEl.value || minDay; if (to && from > to) from = to; fromEl.value = from; render(); }); }
  if (toEl) { toEl.value = to; toEl.addEventListener("change", () => { to = toEl.value || maxDay; if (from && to < from) to = from; toEl.value = to; render(); }); }
  function filterByModel(value) {
    if (!sel) return;
    if ([...sel.options].some((o) => o.value === value)) {
      sel.value = value;
      model = value;
      render();
      chartEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("click", (event) => {
      const el = event.target && event.target.closest && event.target.closest("[data-filter-model]");
      if (el) filterByModel(el.getAttribute("data-filter-model") || "");
    });
  } else {
    document.querySelectorAll("[data-filter-model]").forEach((el) => {
      el.addEventListener("click", () => filterByModel(el.getAttribute("data-filter-model") || ""));
    });
  }
  render();
  if (typeof ResizeObserver !== "undefined") {
    let previousWidth = chartEl.clientWidth;
    new ResizeObserver(() => {
      if (chartEl.clientWidth !== previousWidth) {
        previousWidth = chartEl.clientWidth;
        render();
      }
    }).observe(chartEl);
  }
})();
</script>
</body>
</html>`;
}
