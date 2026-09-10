import { createHash } from "crypto";
import type { Memento } from "vscode";
import { UsageSnapshot } from "./models";

export type BudgetMetric = "onDemand" | "included";
export interface BudgetProgress {
  budgetCents: number;
  usedCents: number | null;
  percent: number | null;
  metric: BudgetMetric;
}
export interface BudgetNotice extends BudgetProgress {
  milestone: number;
}

export function budgetProgress(snapshot: UsageSnapshot, amount: number, metric: BudgetMetric): BudgetProgress | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const budgetCents = Math.round(amount * 100);
  if (budgetCents < 1) return null;
  const raw = metric === "included" ? snapshot.overallUsedCents : snapshot.onDemandUsedCents;
  const usedCents = raw !== null && Number.isFinite(raw) && raw >= 0 ? raw : null;
  return { budgetCents, usedCents, percent: usedCents === null ? null : usedCents / budgetCents * 100, metric };
}

const STATE_KEY = "cursorTokenUsage.budgetMilestones.v1";

/** Persist the highest reached milestone before notifying, including across reloads. */
export class BudgetMonitor {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Pick<Memento, "get" | "update">) {}

  check(snapshot: UsageSnapshot, amount: number, metric: BudgetMetric): Promise<BudgetNotice | null> {
    const task = this.queue.then(() => this.evaluate(snapshot, amount, metric));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async evaluate(snapshot: UsageSnapshot, amount: number, metric: BudgetMetric): Promise<BudgetNotice | null> {
    const progress = budgetProgress(snapshot, amount, metric);
    if (!progress || progress.percent === null || !snapshot.accountId ||
      !Number.isFinite(Date.parse(snapshot.billingCycleStart)) ||
      !Number.isFinite(Date.parse(snapshot.billingCycleEnd)) ||
      Date.parse(snapshot.billingCycleEnd) <= Date.parse(snapshot.billingCycleStart)) return null;
    const milestone = [100, 80, 50].find(value => progress.percent! >= value);
    if (!milestone) return null;
    const key = createHash("sha256").update(JSON.stringify([
      snapshot.accountId, snapshot.billingCycleStart, snapshot.billingCycleEnd, metric, progress.budgetCents,
    ])).digest("hex");
    const saved = this.storage.get<Record<string, number>>(STATE_KEY, {});
    if ((saved[key] || 0) >= milestone) return null;
    // Bound storage to recent budget/cycle combinations. No tokens or raw account IDs are saved.
    const entries = Object.entries(saved).filter(([id]) => id !== key).slice(-99);
    await this.storage.update(STATE_KEY, Object.fromEntries([...entries, [key, milestone]]));
    return { ...progress, milestone };
  }
}
