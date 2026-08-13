import * as vscode from "vscode";
import { UsageSnapshot } from "./models";
import { formatCents, formatEventTime, formatPct, formatTokens, shortenModel } from "./treeView";

export class UsagePanel {
  public static current: UsagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly getSnapshot: () => UsageSnapshot | null;
  private readonly getError: () => string | null;

  static show(
    context: vscode.ExtensionContext,
    getSnapshot: () => UsageSnapshot | null,
    getError: () => string | null,
    onMessage: (command: string) => void,
  ): UsagePanel {
    if (UsagePanel.current) {
      UsagePanel.current.refresh();
      UsagePanel.current.panel.reveal();
      return UsagePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "cursorTokenUsage",
      "Cursor Token Usage",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    UsagePanel.current = new UsagePanel(panel, getSnapshot, getError, onMessage);
    context.subscriptions.push(panel);
    return UsagePanel.current;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    getSnapshot: () => UsageSnapshot | null,
    getError: () => string | null,
    onMessage: (command: string) => void,
  ) {
    this.panel = panel;
    this.getSnapshot = getSnapshot;
    this.getError = getError;
    this.refresh();
    panel.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg.command) onMessage(msg.command);
    });
    panel.onDidDispose(() => {
      if (UsagePanel.current === this) UsagePanel.current = undefined;
    });
  }

  refresh(): void {
    this.panel.webview.html = renderHtml(this.panel.webview, this.getSnapshot(), this.getError());
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

function meter(label: string, valueText: string, pct: number, unlimited = false): string {
  const width = unlimited ? 100 : clampPct(pct);
  const color = unlimited ? "var(--ok)" : barColor(pct);
  const pctLabel = unlimited ? "∞" : `${Math.round(pct)}%`;
  return `<div class="meter">
    <div class="meter-head"><span>${escapeHtml(label)}</span><strong>${escapeHtml(valueText)}</strong></div>
    <div class="track"><div class="fill" style="width:${width}%;background:${color}"></div></div>
    <div class="meter-pct" style="color:${color}">${escapeHtml(pctLabel)}</div>
  </div>`;
}

function ring(pct: number, headline: string, sub: string, unlimited: boolean): string {
  const r = 54;
  const c = 2 * Math.PI * r;
  const p = unlimited ? 0 : clampPct(pct);
  const offset = unlimited ? 0 : c * (1 - p / 100);
  const color = unlimited ? "var(--ok)" : barColor(pct);
  const center = unlimited ? "∞" : `${Math.round(p)}%`;
  return `<div class="hero">
    <div class="ring-wrap">
      <svg viewBox="0 0 128 128" class="ring">
        <circle class="ring-bg" cx="64" cy="64" r="${r}"></circle>
        <circle class="ring-fg" cx="64" cy="64" r="${r}" stroke="${color}"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
      <div class="ring-center" style="color:${color}">${escapeHtml(center)}</div>
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

function heroPct(snapshot: UsageSnapshot): number {
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
    return (snapshot.overallUsedCents / snapshot.overallLimitCents) * 100;
  }
  return Math.max(snapshot.cursorModelsPercent ?? 0, snapshot.otherModelsPercent ?? 0);
}

function heroHeadline(snapshot: UsageSnapshot): string {
  if (snapshot.displayMode === "overall" && snapshot.overallUsedCents !== null && snapshot.overallLimitCents !== null) {
    return `${formatCents(snapshot.overallUsedCents)} / ${formatCents(snapshot.overallLimitCents)}`;
  }
  const c = formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited);
  const o = formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited);
  return `C ${c}  ·  O ${o}`;
}

function renderHtml(webview: vscode.Webview, snapshot: UsageSnapshot | null, error: string | null): string {
  const nonce = String(Date.now());
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const actions = `
    <div class="actions">
      <button data-cmd="refresh">${escapeHtml(vscode.l10n.t("Refresh Token Usage"))}</button>
      <button data-cmd="token">${escapeHtml(vscode.l10n.t("Set Session Token"))}</button>
      <button data-cmd="align">${escapeHtml(vscode.l10n.t("Status bar side"))}</button>
      <button data-cmd="alerts">${escapeHtml(vscode.l10n.t("Configure Usage Alerts"))}</button>
    </div>`;

  let body: string;
  if (!snapshot) {
    body = `<p class="empty">${escapeHtml(error || vscode.l10n.t("Loading..."))}</p>${actions}`;
  } else {
    const meters: string[] = [];
    if (snapshot.overallUsedCents !== null && snapshot.overallLimitCents && snapshot.overallLimitCents > 0) {
      const pct = (snapshot.overallUsedCents / snapshot.overallLimitCents) * 100;
      meters.push(meter(
        vscode.l10n.t("Included usage"),
        `${formatCents(snapshot.overallUsedCents)} / ${formatCents(snapshot.overallLimitCents)}`,
        pct,
        snapshot.isUnlimited,
      ));
    }
    if (snapshot.cursorModelsPercent !== null) {
      meters.push(meter("Cursor Models", formatPct(snapshot.cursorModelsPercent, snapshot.isUnlimited), snapshot.cursorModelsPercent, snapshot.isUnlimited));
    }
    if (snapshot.otherModelsPercent !== null) {
      meters.push(meter("Other Models", formatPct(snapshot.otherModelsPercent, snapshot.isUnlimited), snapshot.otherModelsPercent, snapshot.isUnlimited));
    }
    if (snapshot.onDemandEnabled && snapshot.onDemandUsedCents !== null) {
      const limit = snapshot.onDemandLimitCents && snapshot.onDemandLimitCents > 0 ? snapshot.onDemandLimitCents : null;
      const pct = limit ? (snapshot.onDemandUsedCents / limit) * 100 : 0;
      const text = limit
        ? `${formatCents(snapshot.onDemandUsedCents)} / ${formatCents(limit)}`
        : formatCents(snapshot.onDemandUsedCents);
      meters.push(meter("On-Demand", text, pct));
    }

    const maxTok = Math.max(1, ...snapshot.aggregations.map((a) => a.totalTokens));
    const models = snapshot.aggregations.slice(0, 12).map((a) => {
      const pct = (a.totalTokens / maxTok) * 100;
      return `<div class="row">
        <span class="name">${escapeHtml(shortenModel(a.model))}</span>
        <div class="mini-track"><div class="fill" style="width:${pct}%"></div></div>
        <span class="num">${escapeHtml(formatTokens(a.totalTokens))}</span>
      </div>`;
    }).join("");

    const displayCount = vscode.workspace.getConfiguration("cursorTokenUsage").get<number>("displayCount", 5);
    const visibleEvents = snapshot.events.slice(0, displayCount);
    const events = visibleEvents.map((e) => {
      const onDemand = e.kind.includes("USAGE_BASED");
      const badge = onDemand ? "On-Demand" : "Included";
      return `<tr>
        <td>${escapeHtml(formatEventTime(e.timestamp))}</td>
        <td>${escapeHtml(shortenModel(e.model))}</td>
        <td><span class="badge ${onDemand ? "od" : "inc"}">${badge}</span></td>
        <td class="num">${escapeHtml(formatTokens(e.totalTokens))}</td>
      </tr>`;
    }).join("");

    body = `
      <header>
        <div>
          <h1>Cursor Token Usage</h1>
          <p class="sub">
            <span class="chip">${escapeHtml(snapshot.membershipType || "—")}</span>
            ${escapeHtml(countdown(snapshot.billingCycleEnd))}
          </p>
        </div>
        <div class="stat-pill">${escapeHtml(vscode.l10n.t("Total Tokens"))}<strong>${escapeHtml(formatTokens(snapshot.totalTokens))}</strong></div>
      </header>
      ${ring(heroPct(snapshot), heroHeadline(snapshot), countdown(snapshot.billingCycleEnd), snapshot.isUnlimited)}
      ${actions}
      <section><h2>${escapeHtml(vscode.l10n.t("Billing Cycle"))}</h2>${meters.join("") || `<p class="empty">${escapeHtml(vscode.l10n.t("No data"))}</p>`}</section>
      <section><h2>${escapeHtml(vscode.l10n.t("By Model ({0})", snapshot.aggregations.length))}</h2>${models || `<p class="empty">${escapeHtml(vscode.l10n.t("No data"))}</p>`}</section>
      <section><h2>${escapeHtml(vscode.l10n.t("Recent Usage ({0} entries)", visibleEvents.length))}</h2>
        <table><thead><tr><th>Time</th><th>Model</th><th>Kind</th><th>Tokens</th></tr></thead><tbody>${events}</tbody></table>
      </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
:root {
  --bg:#0e1117; --card:#161b24; --line:#2a3140; --text:#e8eaed; --muted:#9aa3b2;
  --ok:#3ecf8e; --mid:#f5d742; --warn:#f5a524; --err:#f85149; --accent:#4da3ff;
}
html,body { margin:0; padding:0; background:
  radial-gradient(1200px 400px at 10% -10%, #1a2a44 0%, transparent 55%),
  var(--bg); color:var(--text); font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }
.wrap { max-width:760px; margin:0 auto; padding:20px 18px 36px; }
header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
header h1 { margin:0; font-size:20px; letter-spacing:.01em; }
.sub { margin:6px 0 0; color:var(--muted); display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.chip { display:inline-block; padding:1px 8px; border-radius:99px; border:1px solid var(--line); background:#1d2430; color:var(--accent); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
.stat-pill { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px 12px; color:var(--muted); min-width:110px; }
.stat-pill strong { display:block; color:var(--text); font-size:16px; }
.hero { display:flex; gap:20px; align-items:center; margin:18px 0 8px; background:linear-gradient(180deg,#1b2332,#161b24); border:1px solid var(--line); border-radius:16px; padding:16px 18px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
.ring-wrap { position:relative; width:128px; height:128px; flex:0 0 128px; }
.ring { width:128px; height:128px; transform:rotate(-90deg); }
.ring-bg { fill:none; stroke:#2a3140; stroke-width:10; }
.ring-fg { fill:none; stroke-width:10; stroke-linecap:round; filter:drop-shadow(0 0 8px currentColor); transition:stroke-dashoffset .6s ease; }
.ring-center { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:26px; font-weight:700; }
.hero-kicker { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; }
.hero-main { font-size:22px; font-weight:700; margin:4px 0; font-variant-numeric:tabular-nums; }
.hero-sub { color:var(--muted); }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
button { background:transparent; color:var(--accent); border:1px solid #2d6fbf; border-radius:8px; padding:6px 12px; cursor:pointer; }
button:hover { background:#1a2e4a; }
section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; margin:12px 0; }
h2 { margin:0 0 12px; font-size:12px; color:var(--muted); font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.meter { margin:0 0 16px; }
.meter-head { display:flex; justify-content:space-between; margin-bottom:6px; }
.meter-pct { text-align:right; font-size:11px; margin-top:4px; font-variant-numeric:tabular-nums; }
.track, .mini-track { height:10px; background:#242b38; border-radius:99px; overflow:hidden; }
.fill { height:100%; border-radius:99px; background:var(--ok); position:relative; box-shadow:0 0 12px color-mix(in srgb, var(--ok) 50%, transparent); transition:width .5s ease; }
.fill::after { content:""; position:absolute; inset:0; background:linear-gradient(90deg, transparent, rgba(255,255,255,.28), transparent); animation:shine 1.8s infinite; }
@keyframes shine { from { transform:translateX(-100%); } to { transform:translateX(200%); } }
.row { display:grid; grid-template-columns:150px 1fr 64px; gap:10px; align-items:center; margin:8px 0; }
.name { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.num { text-align:right; font-variant-numeric:tabular-nums; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:8px 4px; border-bottom:1px solid var(--line); }
th { color:var(--muted); font-weight:500; }
.badge { font-size:11px; border-radius:99px; padding:1px 8px; }
.badge.inc { background:#163226; color:var(--ok); }
.badge.od { background:#3a2410; color:var(--warn); }
.empty { color:var(--muted); }
</style>
</head>
<body>
<div class="wrap">${body}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const btn of document.querySelectorAll("[data-cmd]")) {
  btn.addEventListener("click", () => vscode.postMessage({ command: btn.dataset.cmd }));
}
</script>
</body>
</html>`;
}
