import { createHash } from "crypto";
import type { Memento } from "vscode";
import { UsageSnapshot } from "./models";

export type BudgetMetric = "onDemand" | "included";
export type PoolMilestoneId = "cursorModels" | "otherModels" | "included";
export interface BudgetProgress {
  budgetCents: number;
  usedCents: number | null;
  percent: number | null;
  metric: BudgetMetric;
}
export interface BudgetNotice extends BudgetProgress {
  milestone: number;
}
export interface PoolMilestone {
  pool: PoolMilestoneId;
  percent: number;
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
const MILESTONES = [100, 80, 50];

export function poolPercents(snapshot: UsageSnapshot): Array<{ pool: PoolMilestoneId; percent: number }> {
  if (snapshot.isUnlimited) return [];
  const rows: Array<{ pool: PoolMilestoneId; percent: number }> = [];
  for (const [pool, value] of [
    ["cursorModels", snapshot.cursorModelsPercent],
    ["otherModels", snapshot.otherModelsPercent],
  ] as const) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) rows.push({ pool, percent: value });
  }
  return rows;
}

/** Team / Enterprise included spend, used when the summary has dollars instead of the two pool percents. */
export function includedSpendPercent(snapshot: UsageSnapshot): number | null {
  if (snapshot.isUnlimited || snapshot.displayMode !== "overall") return null;
  if (snapshot.overallUsedCents === null || snapshot.overallLimitCents === null || snapshot.overallLimitCents <= 0) return null;
  if (!Number.isFinite(snapshot.overallUsedCents) || snapshot.overallUsedCents < 0) return null;
  return snapshot.overallUsedCents / snapshot.overallLimitCents * 100;
}

export function allowancePercents(snapshot: UsageSnapshot): Array<{ pool: PoolMilestoneId; percent: number }> {
  const pools = poolPercents(snapshot);
  if (pools.length) return pools;
  const included = includedSpendPercent(snapshot);
  return included === null ? [] : [{ pool: "included", percent: included }];
}

function milestoneFor(percent: number): number | undefined {
  return MILESTONES.find(value => percent >= value);
}

function scopeKey(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function cycleReady(snapshot: UsageSnapshot): boolean {
  return Boolean(snapshot.accountId)
    && Number.isFinite(Date.parse(snapshot.billingCycleStart))
    && Number.isFinite(Date.parse(snapshot.billingCycleEnd))
    && Date.parse(snapshot.billingCycleEnd) > Date.parse(snapshot.billingCycleStart);
}

function remember(saved: Record<string, number>, updates: Record<string, number>): Record<string, number> {
  const next = { ...saved, ...updates };
  return Object.fromEntries(Object.entries(next).slice(-100));
}

/** Persist the highest reached milestone before notifying, including across reloads. */
export class BudgetMonitor {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Pick<Memento, "get" | "update">) {}

  check(snapshot: UsageSnapshot, amount: number, metric: BudgetMetric): Promise<BudgetNotice | null> {
    const task = this.queue.then(() => this.evaluate(snapshot, amount, metric));
    this.queue = task.catch(() => undefined);
    return task;
  }

  checkPools(snapshot: UsageSnapshot): Promise<PoolMilestone[]> {
    const task = this.queue.then(() => this.evaluatePools(snapshot));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async evaluate(snapshot: UsageSnapshot, amount: number, metric: BudgetMetric): Promise<BudgetNotice | null> {
    const progress = budgetProgress(snapshot, amount, metric);
    if (!progress || progress.percent === null || !cycleReady(snapshot)) return null;
    const milestone = milestoneFor(progress.percent);
    if (!milestone) return null;
    const key = scopeKey([
      snapshot.accountId, snapshot.billingCycleStart, snapshot.billingCycleEnd, metric, progress.budgetCents,
    ]);
    const saved = this.storage.get<Record<string, number>>(STATE_KEY, {});
    if ((saved[key] || 0) >= milestone) return null;
    await this.storage.update(STATE_KEY, remember(saved, { [key]: milestone }));
    return { ...progress, milestone };
  }

  private async evaluatePools(snapshot: UsageSnapshot): Promise<PoolMilestone[]> {
    if (!cycleReady(snapshot)) return [];
    const saved = this.storage.get<Record<string, number>>(STATE_KEY, {});
    const updates: Record<string, number> = {};
    const notices: PoolMilestone[] = [];
    for (const row of allowancePercents(snapshot)) {
      const milestone = milestoneFor(row.percent);
      if (!milestone) continue;
      const key = scopeKey([
        snapshot.accountId, snapshot.billingCycleStart, snapshot.billingCycleEnd, "pool", row.pool,
      ]);
      if ((saved[key] || 0) >= milestone) continue;
      updates[key] = milestone;
      notices.push({ pool: row.pool, percent: row.percent, milestone });
    }
    if (!notices.length) return [];
    await this.storage.update(STATE_KEY, remember(saved, updates));
    return notices;
  }
}
