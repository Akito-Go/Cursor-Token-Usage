import * as vscode from "vscode";
import { fetchUsage } from "./api";
import { FetchResult, UsageAlert, UsageSnapshot } from "./models";

const log = vscode.window.createOutputChannel("Cursor Token Usage - Tracker");

export class UsageTracker {
  private _lastSnapshot: UsageSnapshot | null = null;
  private _lastError: string | null = null;
  private _eventsError = false;
  private _aggError = false;
  private _consecutiveFailures = 0;
  private _lastSuccessTime: Date | null = null;
  private _onUpdate: (() => void) | null = null;
  private _onAlert: ((alerts: UsageAlert[]) => void) | null = null;
  private _polling = false;
  private _pollStartTime = 0;
  private _pollCount = 0;
  private _activePollId = 0;

  set onUpdate(callback: () => void) {
    this._onUpdate = callback;
  }

  set onAlert(callback: (alerts: UsageAlert[]) => void) {
    this._onAlert = callback;
  }

  get lastSnapshot(): UsageSnapshot | null {
    return this._lastSnapshot;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get eventsError(): boolean {
    return this._eventsError;
  }

  get aggError(): boolean {
    return this._aggError;
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  get lastSuccessTime(): Date | null {
    return this._lastSuccessTime;
  }

  async poll(force = false): Promise<boolean> {
    this._pollCount++;
    const pollId = this._pollCount;
    const ts = new Date().toISOString();
    if (this._polling) {
      const elapsed = Date.now() - this._pollStartTime;
      if (elapsed > 120000) {
        log.appendLine(`[${ts}] poll#${pollId} 上次轮询超时，强制重置`);
        this._polling = false;
      } else {
        log.appendLine(`[${ts}] poll#${pollId} SKIPPED`);
        return false;
      }
    }
    this._activePollId = pollId;
    this._polling = true;
    this._pollStartTime = Date.now();
    try {
      const result = await Promise.race<FetchResult>([
        fetchUsage(),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ snapshot: null, error: "数据获取超时", eventsError: false, aggError: false }),
            90000,
          ),
        ),
      ]);
      if (!result.snapshot) {
        this._lastError = result.error;
        this._consecutiveFailures++;
        log.appendLine(`[${ts}] poll#${pollId} 失败: ${result.error}`);
        this._onUpdate?.();
        return false;
      }
      if (pollId !== this._activePollId) return false;

      const wasRecovering = this._consecutiveFailures > 0;
      this._lastError = null;
      this._consecutiveFailures = 0;
      this._lastSuccessTime = new Date();
      this._eventsError = result.eventsError;
      this._aggError = result.aggError;

      const prev = this._lastSnapshot;
      const snapshot = result.snapshot;
      log.appendLine(
        `[${ts}] poll#${pollId} 成功 C=${snapshot.cursorModelsPercent}% O=${snapshot.otherModelsPercent}% tokens=${snapshot.totalTokens}`,
      );
      this._lastSnapshot = snapshot;
      if (prev && !wasRecovering) this.checkAlerts(prev, snapshot);
      this._onUpdate?.();
      return true;
    } catch (err) {
      log.appendLine(`[${ts}] poll#${pollId} 异常: ${err}`);
      if (force) this._onUpdate?.();
      return false;
    } finally {
      this._polling = false;
    }
  }

  private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot): void {
    const config = vscode.workspace.getConfiguration("cursorTokenUsage");
    if (!config.get("alertEnabled", true)) return;
    const items = config.get<string[]>("alertItems", ["newSession", "cursorModels", "otherModels", "totalTokens"]);
    const alerts: UsageAlert[] = [];

    if (items.includes("newSession")) {
      const prevTs = new Set(prev.events.map((e) => e.timestamp));
      const newCount = curr.events.filter((e) => !prevTs.has(e.timestamp)).length;
      const threshold = config.get("alertThreshold.newSession", 2);
      if (newCount >= threshold && newCount > 0) {
        alerts.push({ type: "newSession", delta: newCount, threshold });
      }
    }
    if (items.includes("cursorModels") && prev.cursorModelsPercent !== null && curr.cursorModelsPercent !== null) {
      const delta = curr.cursorModelsPercent - prev.cursorModelsPercent;
      const threshold = config.get("alertThreshold.cursorModels", 10);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "cursorModels", delta, threshold });
      }
    }
    if (items.includes("otherModels") && prev.otherModelsPercent !== null && curr.otherModelsPercent !== null) {
      const delta = curr.otherModelsPercent - prev.otherModelsPercent;
      const threshold = config.get("alertThreshold.otherModels", 10);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "otherModels", delta, threshold });
      }
    }
    if (items.includes("overallSpending") && prev.overallUsedCents !== null && curr.overallUsedCents !== null) {
      const delta = (curr.overallUsedCents - prev.overallUsedCents) / 100;
      const threshold = config.get("alertThreshold.overallSpending", 1);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "overallSpending", delta, threshold });
      }
    }
    if (items.includes("onDemandSpending") && prev.onDemandUsedCents !== null && curr.onDemandUsedCents !== null) {
      const delta = (curr.onDemandUsedCents - prev.onDemandUsedCents) / 100;
      const threshold = config.get("alertThreshold.onDemandSpending", 1);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "onDemandSpending", delta, threshold });
      }
    }
    if (items.includes("totalTokens")) {
      const delta = curr.totalTokens - prev.totalTokens;
      const threshold = config.get("alertThreshold.totalTokens", 100000);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "totalTokens", delta, threshold });
      }
    }
    if (alerts.length > 0) this._onAlert?.(alerts);
  }
}
