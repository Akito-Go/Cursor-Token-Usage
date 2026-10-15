import { UsageSnapshot } from "./models";

export interface ModelBreakdownRow {
  model: string;
  requests: number;
  tokens: number;
  spendCents: number | null;
}

/**
 * Requests and spend come from fetched events. Positive API cents are summed;
 * a missing or explicit zero does not become $0.00. Tokens prefer model totals.
 */
export function summarizeModels(snapshot: UsageSnapshot): ModelBreakdownRow[] {
  const fromEvents = new Map<string, { requests: number; tokens: number; spend: number; hasSpend: boolean }>();
  for (const event of snapshot.events) {
    const row = fromEvents.get(event.model) ?? { requests: 0, tokens: 0, spend: 0, hasSpend: false };
    row.requests += 1;
    row.tokens += event.totalTokens;
    if (event.totalCents !== null && event.totalCents > 0) {
      row.spend += event.totalCents;
      row.hasSpend = true;
    }
    fromEvents.set(event.model, row);
  }
  const totals = new Map(snapshot.aggregations.map((row) => [row.model, row.totalTokens]));
  const models = new Set<string>([...fromEvents.keys(), ...totals.keys()]);
  return [...models]
    .map((model) => {
      const event = fromEvents.get(model);
      return {
        model,
        requests: event?.requests ?? 0,
        tokens: totals.get(model) ?? event?.tokens ?? 0,
        spendCents: event?.hasSpend ? event.spend : null,
      };
    })
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
}
