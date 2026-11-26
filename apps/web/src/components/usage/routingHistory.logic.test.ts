import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRoutingRows,
  estimateSavings,
  estimateTurnCostUsd,
  lastVisitedThreadRef,
  sumMeasuredTokens,
  type RoutingPrice,
} from "./routingHistory.logic";

const turn = (
  ordinal: number,
  overrides: Record<string, unknown> = {},
): OrchestrationV2ProviderTurn =>
  ({
    id: `turn-${ordinal}`,
    providerThreadId: "pt-1",
    ordinal,
    adaptiveRoute: { reason: "Lookup", requestedModel: "small", tier: "economy" },
    ...overrides,
  }) as unknown as OrchestrationV2ProviderTurn;

const threads = [{ id: "pt-1", driver: "codex" }] as unknown as ReadonlyArray<
  Pick<OrchestrationV2ProviderThread, "id" | "driver">
>;
const usage = (inputTokens: number, outputTokens: number, extra: Record<string, unknown> = {}) => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: false,
  inputTokens,
  outputTokens,
  ...extra,
});
const prices: Record<string, RoutingPrice> = {
  small: { inputPerMillion: 1, outputPerMillion: 4, cachedInputPerMillion: 0.1 },
  big: { inputPerMillion: 10, outputPerMillion: 40 },
};

describe("buildRoutingRows", () => {
  it("skips turns without a route and labels requested vs reported values", () => {
    const rows = buildRoutingRows({
      providerTurns: [
        turn(1, { adaptiveRoute: undefined }),
        turn(2, {
          adaptiveRoute: { reason: "x", requestedModel: "small", requestedEffort: "low" },
        }),
        turn(3, {
          model: "small-2",
          adaptiveRoute: {
            reason: "x",
            requestedModel: "small",
            requestedEffort: "low",
            effectiveEffort: "medium",
          },
        }),
      ],
      providerThreads: threads,
    });
    expect(rows.map((row) => row.ordinal)).toEqual([2, 3]);
    expect(rows[0]).toMatchObject({
      provider: "codex",
      model: "small",
      modelSource: "requested",
      effort: "low",
      effortSource: "requested",
    });
    expect(rows[1]).toMatchObject({
      model: "small-2",
      modelSource: "reported",
      effort: "medium",
      effortSource: "effective",
    });
  });

  it("flags tier escalation, de-escalation and failure retries", () => {
    const route = (tier: string, failureCount: number) => ({
      adaptiveRoute: { reason: "r", requestedModel: "m", tier, failureCount },
    });
    const rows = buildRoutingRows({
      providerTurns: [
        turn(1, route("worker", 0)),
        turn(2, route("expert", 2)),
        turn(3, route("economy", 0)),
        turn(4, route("economy", 1)),
        turn(5, route("economy", 1)),
      ],
      providerThreads: threads,
    });
    expect(rows.map((row) => row.event)).toEqual([
      undefined,
      { kind: "escalated", from: "worker", to: "expert" },
      { kind: "de-escalated", from: "expert", to: "economy" },
      { kind: "retry-after-failure", failureCount: 1 },
      undefined,
    ]);
  });
});

describe("estimateTurnCostUsd", () => {
  it("prices measured tokens, splitting cached input", () => {
    // 900 uncached * $1 + 100 cached * $0.1 + 500 out * $4, per million
    expect(
      estimateTurnCostUsd(usage(1000, 500, { cachedInputTokens: 100 }) as never, prices.small),
    ).toBeCloseTo((900 + 10 + 2000) / 1_000_000, 10);
  });

  it("returns undefined instead of guessing", () => {
    expect(estimateTurnCostUsd(usage(1000, 500) as never, undefined)).toBeUndefined();
    expect(estimateTurnCostUsd(undefined, prices.small)).toBeUndefined();
    expect(
      estimateTurnCostUsd(
        { ...usage(1, 1), inputTokens: undefined, usageStatus: "partial" } as never,
        prices.small,
      ),
    ).toBeUndefined();
    // Cached tokens with no cached price, cache writes, and extra provider usage are unpriceable.
    expect(
      estimateTurnCostUsd(usage(1000, 5, { cachedInputTokens: 10 }) as never, prices.big),
    ).toBeUndefined();
    expect(
      estimateTurnCostUsd(usage(1000, 5, { cacheCreationTokens: 10 }) as never, prices.small),
    ).toBeUndefined();
    expect(
      estimateTurnCostUsd(
        usage(1000, 5, { otherUsage: { inputTokens: 1, outputTokens: 1 } }) as never,
        prices.small,
      ),
    ).toBeUndefined();
  });
});

describe("measured totals and savings", () => {
  const turns = [
    turn(1, { turnTokenUsage: usage(1_000_000, 100_000) }),
    turn(2, { turnTokenUsage: usage(2_000_000, 0) }),
    turn(3, {}),
    turn(4, { model: "unpriced", turnTokenUsage: usage(5, 5) }),
  ];

  it("sums only reported counters and counts turns without usage", () => {
    const totals = sumMeasuredTokens(
      buildRoutingRows({ providerTurns: turns, providerThreads: threads }),
    );
    expect(totals).toEqual({
      turns: 4,
      inputTokens: 3_000_005,
      outputTokens: 100_005,
      cachedInputTokens: 0,
      turnsWithoutUsage: 1,
    });
  });

  it("prices measured tokens on the thread's worker model, skipping unpriced turns", () => {
    const turn = (model: string, tier: "economy" | "worker", tokens: number) =>
      ({
        model,
        adaptiveRoute: { tier, reason: "x", requestedModel: model },
        turnTokenUsage: { inputTokens: tokens, outputTokens: 0 },
      }) as unknown as OrchestrationV2ProviderTurn;
    const rates: Record<string, number> = { small: 1, mid: 3 };
    const savings = estimateSavings({
      providerTurns: [
        turn("mid", "worker", 1_000_000),
        turn("small", "economy", 1_000_000),
        turn("mystery", "economy", 1_000_000),
      ],
      ratePerMillion: (model) => rates[model],
    });
    // actual $3 + $1; the same tokens on the worker model $3 + $3; the unpriced turn is excluded.
    expect(savings).toMatchObject({ baselineModel: "mid", pricedTurns: 2, totalTurns: 3 });
    expect(savings?.savedUsd).toBeCloseTo(2, 6);
  });

  it("omits the estimate without a priced worker model", () => {
    expect(estimateSavings({ providerTurns: [], ratePerMillion: () => 1 })).toBeUndefined();
  });
});

describe("lastVisitedThreadRef", () => {
  const ref = (threadId: string) => ({ environmentId: "desk", threadId }) as ScopedThreadRef;
  const at = (iso: string) => DateTime.makeUnsafe(iso);

  it("picks the newest visit and skips threads never opened", () => {
    expect(
      lastVisitedThreadRef([
        { ref: ref("old"), lastVisitedAt: at("2026-11-24T10:00:00Z") },
        { ref: ref("never"), lastVisitedAt: null },
        { ref: ref("new"), lastVisitedAt: at("2026-11-25T09:00:00Z") },
        { ref: ref("unset") },
      ]),
    ).toEqual(ref("new"));
    expect(lastVisitedThreadRef([{ ref: ref("never"), lastVisitedAt: null }])).toBeNull();
  });
});
