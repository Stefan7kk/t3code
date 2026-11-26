import type {
  AdaptiveModelTier,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The thread opened most recently, or null when none carries a visit mark. */
export function lastVisitedThreadRef(
  threads: Iterable<{
    readonly ref: ScopedThreadRef;
    readonly lastVisitedAt?: DateTime.Utc | null | undefined;
  }>,
): ScopedThreadRef | null {
  let latest: ScopedThreadRef | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const thread of threads) {
    if (thread.lastVisitedAt == null) continue;
    const at = DateTime.toEpochMillis(thread.lastVisitedAt);
    if (at > latestAt) {
      latest = thread.ref;
      latestAt = at;
    }
  }
  return latest;
}

/** USD per million tokens, from a price table the caller trusts. */
export interface RoutingPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cachedInputPerMillion?: number;
}

export type RoutingEvent =
  | {
      readonly kind: "escalated" | "de-escalated";
      readonly from: AdaptiveModelTier;
      readonly to: AdaptiveModelTier;
    }
  | { readonly kind: "retry-after-failure"; readonly failureCount: number };

export interface RoutingRow {
  readonly turnId: string;
  readonly ordinal: number;
  readonly provider: string;
  /** The model the provider reported running, else the model Auto requested. */
  readonly model: string;
  readonly modelSource: "reported" | "requested";
  readonly tier: AdaptiveModelTier | undefined;
  readonly effort: string | undefined;
  /** "effective" only when the provider reported it; otherwise what Auto asked for. */
  readonly effortSource: "effective" | "requested" | undefined;
  readonly reason: string;
  readonly failureCount: number;
  readonly event: RoutingEvent | undefined;
  /** MEASURED: provider-reported counters. Undefined means the provider did not report them. */
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  /** ESTIMATED: API-equivalent cost of the measured tokens; undefined without a reliable price. */
  readonly estimatedCostUsd: number | undefined;
}

const TIER_RANK: Record<AdaptiveModelTier, number> = { economy: 0, worker: 1, expert: 2 };

/** Input tokens include cache reads; cache writes and extra provider usage block an estimate. */
export function estimateTurnCostUsd(
  usage: OrchestrationV2ProviderTurn["turnTokenUsage"],
  price: RoutingPrice | undefined,
): number | undefined {
  if (price === undefined || usage === undefined) return undefined;
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  if (usage.otherUsage !== undefined || (usage.cacheCreationTokens ?? 0) > 0) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  if (cached > 0 && price.cachedInputPerMillion === undefined) return undefined;
  return (
    ((inputTokens - cached) * price.inputPerMillion +
      cached * (price.cachedInputPerMillion ?? 0) +
      outputTokens * price.outputPerMillion) /
    1_000_000
  );
}

export function buildRoutingRows(input: {
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
  readonly priceFor?: (model: string) => RoutingPrice | undefined;
}): ReadonlyArray<RoutingRow> {
  const drivers = new Map(input.providerThreads.map((thread) => [thread.id, thread.driver]));
  let previous: RoutingRow | undefined;
  const rows: RoutingRow[] = [];
  for (const turn of input.providerTurns) {
    const route = turn.adaptiveRoute;
    if (route === undefined) continue;
    const usage = turn.turnTokenUsage;
    const model = turn.model ?? route.requestedModel;
    const failureCount = route.failureCount ?? 0;
    let event: RoutingEvent | undefined;
    if (previous?.tier !== undefined && route.tier !== undefined && previous.tier !== route.tier) {
      event = {
        kind: TIER_RANK[route.tier] > TIER_RANK[previous.tier] ? "escalated" : "de-escalated",
        from: previous.tier,
        to: route.tier,
      };
    } else if (previous !== undefined && failureCount > previous.failureCount) {
      event = { kind: "retry-after-failure", failureCount };
    }
    const row: RoutingRow = {
      turnId: turn.id,
      ordinal: turn.ordinal,
      provider: drivers.get(turn.providerThreadId) ?? "unknown",
      model,
      modelSource: turn.model === undefined ? "requested" : "reported",
      tier: route.tier,
      effort: route.effectiveEffort ?? route.requestedEffort,
      effortSource:
        route.effectiveEffort !== undefined
          ? "effective"
          : route.requestedEffort !== undefined
            ? "requested"
            : undefined,
      reason: route.reason,
      failureCount,
      event,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens,
      estimatedCostUsd: estimateTurnCostUsd(usage, input.priceFor?.(model)),
    };
    rows.push(row);
    previous = row;
  }
  return rows;
}

export interface RoutingTotals {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly turnsWithoutUsage: number;
}

/** MEASURED sums over turns where the provider reported the counter. */
export function sumMeasuredTokens(rows: ReadonlyArray<RoutingRow>): RoutingTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let turnsWithoutUsage = 0;
  for (const row of rows) {
    if (row.inputTokens === undefined && row.outputTokens === undefined) turnsWithoutUsage += 1;
    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    cachedInputTokens += row.cachedInputTokens ?? 0;
  }
  return { turns: rows.length, inputTokens, outputTokens, cachedInputTokens, turnsWithoutUsage };
}

export interface RoutingSavings {
  readonly actualUsd: number;
  readonly baselineUsd: number;
  readonly savedUsd: number;
  /** The worker model the same tokens are priced on. */
  readonly baselineModel: string;
  /** Turns that could be priced; the rest are excluded, never guessed. */
  readonly pricedTurns: number;
  readonly totalTurns: number;
}

/**
 * ESTIMATE: the measured tokens of each routed turn at the model's effective USD per million
 * tokens (`ratePerMillion`, from the user's own priced usage) versus the same tokens on the
 * thread's most-used worker model. Assumes the worker model would use the same tokens.
 */
export function estimateSavings(input: {
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly ratePerMillion: (model: string) => number | undefined;
}): RoutingSavings | undefined {
  const routed = input.providerTurns.filter((turn) => turn.adaptiveRoute !== undefined);
  const counts = new Map<string, number>();
  for (const turn of routed) {
    const model = turn.model ?? turn.adaptiveRoute?.requestedModel;
    if (turn.adaptiveRoute?.tier === "worker" && model !== undefined) {
      counts.set(model, (counts.get(model) ?? 0) + 1);
    }
  }
  const baselineModel = [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0];
  const baselineRate =
    baselineModel === undefined ? undefined : input.ratePerMillion(baselineModel);
  if (baselineModel === undefined || baselineRate === undefined) return undefined;
  let actualUsd = 0;
  let baselineUsd = 0;
  let pricedTurns = 0;
  for (const turn of routed) {
    const model = turn.model ?? turn.adaptiveRoute?.requestedModel;
    const rate = model === undefined ? undefined : input.ratePerMillion(model);
    const usage = turn.turnTokenUsage;
    if (rate === undefined || usage?.inputTokens === undefined || usage.outputTokens === undefined)
      continue;
    const tokens = usage.inputTokens + usage.outputTokens;
    actualUsd += (tokens * rate) / 1_000_000;
    baselineUsd += (tokens * baselineRate) / 1_000_000;
    pricedTurns += 1;
  }
  if (pricedTurns === 0) return undefined;
  return {
    actualUsd,
    baselineUsd,
    savedUsd: baselineUsd - actualUsd,
    baselineModel,
    pricedTurns,
    totalTurns: routed.length,
  };
}
