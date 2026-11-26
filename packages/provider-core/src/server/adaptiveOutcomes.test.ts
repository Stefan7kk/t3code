import { describe, expect, it } from "vite-plus/test";

import { classifyAdaptiveOutcomes, type AdaptiveOutcomeTurn } from "./adaptiveOutcomes.ts";

const turn = (
  tier: AdaptiveOutcomeTurn["tier"],
  failureCount: number,
  extra: Partial<AdaptiveOutcomeTurn> = {},
): AdaptiveOutcomeTurn => ({
  tier,
  effort: "medium",
  failureCount,
  completed: true,
  outputTokens: 2_000,
  ...extra,
});

describe("classifyAdaptiveOutcomes", () => {
  it("marks a lower tier too low only when a stronger tier then finished cleanly", () => {
    expect(
      classifyAdaptiveOutcomes([turn("worker", 1), turn("worker", 2), turn("expert", 0)]).tooLow,
    ).toEqual([0, 1]);
    // The stronger tier failed too: the task was just hard, so nothing is learned.
    expect(classifyAdaptiveOutcomes([turn("worker", 1), turn("expert", 2)]).tooLow).toEqual([]);
    // No stronger tier ran: a failure alone proves nothing about the route.
    expect(classifyAdaptiveOutcomes([turn("worker", 1), turn("worker", 0)]).tooLow).toEqual([]);
  });

  it("marks a high-effort turn too high only when it was short and nothing failed around it", () => {
    const short = { effort: "high", outputTokens: 120 } as const;
    expect(classifyAdaptiveOutcomes([turn("worker", 0, short)]).tooHigh).toEqual([0]);
    expect(classifyAdaptiveOutcomes([turn("worker", 1), turn("expert", 0, short)]).tooHigh).toEqual(
      [],
    );
    expect(
      classifyAdaptiveOutcomes([turn("worker", 0, { effort: "high", outputTokens: 5_000 })])
        .tooHigh,
    ).toEqual([]);
    expect(
      classifyAdaptiveOutcomes([turn("worker", 0, { ...short, completed: false })]).tooHigh,
    ).toEqual([]);
  });
});
