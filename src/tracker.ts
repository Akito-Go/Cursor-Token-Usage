import * as vscode from "vscode";
import { fetchUsage } from "./api";
import { FetchResult, UsageAlert, UsageEvent, UsageSnapshot } from "./models";

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
  private _lastAttempt: Date | null = null;
  private _endpointStates = { summary: "notRequested", events: "notRequested", aggregations: "notRequested" };
  get diagnostics() {
    return { lastAttempt: this._lastAttempt, lastSuccess: this._lastSuccessTime,
      running: !!this._running, failures: this._consecutiveFailures, ...this._endpointStates };
  }

  private _running: Promise<boolean> | null = null;

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

  get dataWarning(): string | null {
    const warnings: string[] = [];
    if (this._lastError) {
      warnings.push(this._lastError);
      if (this._lastSuccessTime) {
        warnings.push(vscode.l10n.t("Showing cached usage from {0}", this._lastSuccessTime.toLocaleString()));
      }
    }
    if (this._eventsError) warnings.push(vscode.l10n.t("Failed to fetch some usage events. Details may be incomplete."));
    if (this._aggError) warnings.push(vscode.l10n.t("Failed to fetch model totals. Token totals may be outdated."));
    return warnings.length ? warnings.join(" ") : null;
  }

  get lastSuccessTime(): Date | null {
    return this._lastSuccessTime;
  }

  async poll(force = false, opts?: { fullEvents?: boolean }): Promise<boolean> {
    if (this._running) {
      if (!force && !opts?.fullEvents) return false;
      // A details refresh must finish its own fetch after the current poll.
      await this._running;
      return this.poll(force, opts);
    }
    const running = this.runPoll(!!opts?.fullEvents).finally(() => {
      if (this._running === running) this._running = null;
    });
    this._running = running;
    return running;
  }

  private async runPoll(fullEvents: boolean): Promise<boolean> {
    this._lastAttempt = new Date();
    this._endpointStates = { summary: "pending", events: "pending", aggregations: "pending" };
    const ts = this._lastAttempt.toISOString();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race<FetchResult>([
        fetchUsage(fullEvents),
        new Promise((resolve) => {
          timeout = setTimeout(
            () => resolve({ snapshot: null, error: vscode.l10n.t("Timed out fetching usage"), eventsError: false, aggError: false }),
            90000,
          );
        }),
      ]);
      if (!result.snapshot) {
        this._endpointStates = result.error === vscode.l10n.t("Timed out fetching usage")
          ? { summary: "unknown", events: "unknown", aggregations: "unknown" }
          : { summary: "failed", events: "notRequested", aggregations: "notRequested" };
        this._lastError = result.error;
        this._consecutiveFailures++;
        log.appendLine(`[${ts}] poll 失败: ${result.error}`);
        this._onUpdate?.();
        return false;
      }
      this._endpointStates = { summary: "ok", events: result.eventsError ? "failed" : result.snapshot.eventsComplete ? "ok" : "partial",
        aggregations: result.aggError ? "failed" : "ok" };
      const wasRecovering = this._consecutiveFailures > 0;
      this._lastError = null;
      this._consecutiveFailures = 0;
      this._lastSuccessTime = new Date();
      const previousEventsError = this._eventsError;
      const previousAggError = this._aggError;
      this._eventsError = result.eventsError;
      this._aggError = result.aggError;

      const prev = this._lastSnapshot;
      let snapshot = result.snapshot;
      const sameCycle = !!prev && !!snapshot.billingCycleStart &&
        prev.accountId === snapshot.accountId &&
        prev.billingCycleStart === snapshot.billingCycleStart &&
        prev.billingCycleEnd === snapshot.billingCycleEnd;
      if (prev && sameCycle) {
        if (!snapshot.eventsComplete) {
          const events = mergeEvents(snapshot.events, prev.events);
          const previousKeys = new Set(prev.events.map(eventKey));
          const overlaps = snapshot.events.some((event) => previousKeys.has(eventKey(event)));
          snapshot = {
            ...snapshot,
            events,
            // Without overlap a one-page poll may have missed requests in between.
            eventsComplete: !fullEvents && !result.eventsError && prev.eventsComplete && overlaps,
          };
        }
        if (result.aggError) {
          snapshot = { ...snapshot, aggregations: prev.aggregations, totalTokens: prev.totalTokens };
        }
      }
      log.appendLine(
        `[${ts}] poll 成功 full=${snapshot.eventsComplete} events=${snapshot.events.length} C=${snapshot.cursorModelsPercent} O=${snapshot.otherModelsPercent} totalPct=${snapshot.totalPercent} tokens=${snapshot.totalTokens}`,
      );
      this._lastSnapshot = snapshot;
      if (prev && sameCycle && !wasRecovering) {
        this.checkAlerts(prev, result.snapshot, !previousEventsError && !result.eventsError, !previousAggError && !result.aggError);
      }
      this._onUpdate?.();
      return true;
    } catch (err) {
      this._endpointStates = { summary: "unknown", events: "unknown", aggregations: "unknown" };
      this._lastError = vscode.l10n.t("Failed to fetch usage");
      this._consecutiveFailures++;
      log.appendLine(`[${ts}] poll 异常: ${err}`);
      this._onUpdate?.();
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private checkAlerts(prev: UsageSnapshot, curr: UsageSnapshot, eventsValid: boolean, totalsValid: boolean): void {
    const config = vscode.workspace.getConfiguration("cursorTokenUsage");
    if (!config.get("alertEnabled", true)) return;
    const items = config.get<string[]>("alertItems", ["newSession", "cursorModels", "otherModels", "totalTokens"]);
    const alerts: UsageAlert[] = [];

    if (items.includes("newSession") && eventsValid) {
      const latest = prev.events.reduce((max, event) => Math.max(max, eventTime(event)), 0);
      const counts = eventCounts(prev.events);
      const newCount = curr.events.filter((event) => {
        const key = eventKey(event);
        const count = counts.get(key) || 0;
        if (count > 0) {
          counts.set(key, count - 1);
          return false;
        }
        // Opening details also loads older history; it is not new consumption.
        return eventTime(event) >= latest;
      }).length;
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
    if (items.includes("totalTokens") && totalsValid) {
      const delta = curr.totalTokens - prev.totalTokens;
      const threshold = config.get("alertThreshold.totalTokens", 100000);
      if (delta > 0 && delta >= threshold) {
        alerts.push({ type: "totalTokens", delta, threshold });
      }
    }
    if (alerts.length > 0) this._onAlert?.(alerts);
  }
}

function eventTime(event: UsageEvent): number {
  return event.timestamp > 0 && event.timestamp < 1e12 ? event.timestamp * 1000 : event.timestamp;
}

function eventKey(event: UsageEvent): string {
  return JSON.stringify([eventTime(event), event.model, event.kind]);
}

function eventCounts(events: UsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = eventKey(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function mergeEvents(recent: UsageEvent[], previous: UsageEvent[]): UsageEvent[] {
  const counts = eventCounts(recent);
  const older = previous.filter((event) => {
    const key = eventKey(event);
    const count = counts.get(key) || 0;
    if (count === 0) return true;
    counts.set(key, count - 1);
    return false;
  });
  return [...recent, ...older].sort((a, b) => eventTime(b) - eventTime(a));
}
