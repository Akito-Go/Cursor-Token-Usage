import { UsageSnapshot } from "./models";

export interface TodayUsage {
  start: Date;
  end: Date;
  requests: number;
  tokens: number;
  reportedCents: number | null;
  missingCosts: number;
  historyComplete: boolean;
  models: Array<{ model: string; tokens: number; requests: number }>;
}

/** Local calendar day intersected with the current billing cycle; never estimate money. */
export function summarizeToday(snapshot: UsageSnapshot, now = new Date()): TodayUsage {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const cycleStart = Date.parse(snapshot.billingCycleStart);
  if (Number.isFinite(cycleStart) && cycleStart > start.getTime()) start.setTime(cycleStart);
  const end = new Date(Math.min(now.getTime(), snapshot.timestamp.getTime()));
  const cycleEnd = Date.parse(snapshot.billingCycleEnd);
  if (Number.isFinite(cycleEnd) && cycleEnd < end.getTime()) end.setTime(cycleEnd);
  const events = snapshot.events.filter(event => {
    const timestamp = event.timestamp > 0 && event.timestamp < 1e12 ? event.timestamp * 1000 : event.timestamp;
    return timestamp >= start.getTime() && timestamp <= end.getTime() &&
      (!Number.isFinite(cycleEnd) || timestamp < cycleEnd);
  });
  const models = new Map<string, { model: string; tokens: number; requests: number }>();
  let reportedCents = 0;
  let knownCosts = 0;
  for (const event of events) {
    const row = models.get(event.model) || { model: event.model, tokens: 0, requests: 0 };
    row.tokens += event.totalTokens;
    row.requests++;
    models.set(event.model, row);
    if (event.totalCents !== null && Number.isFinite(event.totalCents)) {
      reportedCents += event.totalCents;
      knownCosts++;
    }
  }
  return {
    start, end, requests: events.length,
    tokens: events.reduce((sum, event) => sum + event.totalTokens, 0),
    reportedCents: knownCosts ? reportedCents : null,
    missingCosts: events.length - knownCosts,
    historyComplete: snapshot.eventsComplete && end.getTime() >= start.getTime(),
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
  };
}
