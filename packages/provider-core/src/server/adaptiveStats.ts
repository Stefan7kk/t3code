export interface AdaptiveStatSample {
  readonly category: string;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly tokens: number;
}

export interface AdaptiveStatSummary {
  readonly category: string;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly latencyMs: number;
  readonly tokens: number;
}

/** Local counters only. Missing samples are omitted; nothing here is a quota or a price. */
export function recordAdaptiveStats(
  existing: ReadonlyArray<AdaptiveStatSummary>,
  sample: AdaptiveStatSample,
): ReadonlyArray<AdaptiveStatSummary> {
  const current = existing.find((row) => row.category === sample.category);
  const next: AdaptiveStatSummary = {
    category: sample.category,
    attempts: (current?.attempts ?? 0) + 1,
    successes: (current?.successes ?? 0) + (sample.success ? 1 : 0),
    failures: (current?.failures ?? 0) + (sample.success ? 0 : 1),
    latencyMs: (current?.latencyMs ?? 0) + Math.max(0, sample.latencyMs),
    tokens: (current?.tokens ?? 0) + Math.max(0, sample.tokens),
  };
  return existing.filter((row) => row.category !== sample.category).concat(next);
}
