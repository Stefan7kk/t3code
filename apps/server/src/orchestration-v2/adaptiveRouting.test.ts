import { ADAPTIVE_SELECTION, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  classifyAdaptiveTask,
  resolveAdaptiveTurn,
  type AdaptiveProviderCapabilities,
} from "./adaptiveRouting.ts";

const instanceId = ProviderInstanceId.make("test");
const capabilities: AdaptiveProviderCapabilities = {
  instanceId,
  effortOptionId: "effort",
  models: [
    { id: "quick", tier: "economy", efforts: ["low", "medium"] },
    { id: "work", tier: "worker", efforts: ["low", "medium", "high"] },
    { id: "deep", tier: "expert", efforts: ["low", "medium", "high", "max"] },
  ],
};
const auto: ModelSelection = {
  instanceId,
  model: ADAPTIVE_SELECTION,
  options: [{ id: "effort", value: ADAPTIVE_SELECTION }],
};

describe("adaptive routing", () => {
  it.each([
    ["Find where the folder is defined", "quick", "low"],
    ["Fix the typo in the heading", "work", "low"],
    ["Implement a save button", "work", "medium"],
    ["Debug an intermittent deadlock", "work", "high"],
    ["Design the authentication architecture", "deep", "high"],
    ["Review the pending diff", "work", "medium"],
  ])("routes %s", (text, model, effort) => {
    expect(resolveAdaptiveTurn({ selection: auto, capabilities, text, nowMs: 0 })).toMatchObject({
      selection: { model, options: [{ id: "effort", value: effort }] },
    });
  });

  it("preserves either manual selection and rejects incompatible or more expensive fallback", () => {
    const resolve = (selection: ModelSelection, text: string) =>
      resolveAdaptiveTurn({ selection, capabilities, text, nowMs: 0 });
    expect(resolve({ ...auto, model: "deep" }, "Find the spin lock")).toMatchObject({
      selection: { model: "deep", options: [{ id: "effort", value: "low" }] },
    });
    expect(
      resolve({ ...auto, options: [{ id: "effort", value: "low" }] }, "Implement this feature"),
    ).toMatchObject({ selection: { model: "work", options: [{ id: "effort", value: "low" }] } });
    expect(
      resolve({ ...auto, options: [{ id: "effort", value: "max" }] }, "Find the spin lock"),
    ).toHaveProperty("error");
    expect(
      resolve({ ...auto, instanceId: ProviderInstanceId.make("other") }, "Find the spin lock"),
    ).toHaveProperty("error");
  });

  it("escalates repeated failure and resets on resolution or a new task", () => {
    const first = classifyAdaptiveTask("It still fails", 0);
    expect(first).toMatchObject({ tier: "worker", effort: "high", failureCount: 1 });
    const second = classifyAdaptiveTask("Same error again", first.failureCount);
    expect(second).toMatchObject({ tier: "expert", effort: "high", failureCount: 2 });
    expect(classifyAdaptiveTask("Continue", second.failureCount)).toMatchObject({ tier: "expert" });
    expect(classifyAdaptiveTask("It works now", second.failureCount)).toMatchObject({
      tier: "economy",
      failureCount: 0,
    });
    expect(classifyAdaptiveTask("Implement the next feature", second.failureCount)).toMatchObject({
      tier: "worker",
      failureCount: 0,
    });
  });

  it("uses subscription headroom and enforces budget, exhausted windows, and effort overrides", () => {
    const base = { selection: auto, capabilities, text: "Implement a save button", nowMs: 0 };
    expect(
      resolveAdaptiveTurn({ ...base, tokenBudget: 100, history: { tokens: 100, failureCount: 0 } }),
    ).toHaveProperty("error");
    expect(resolveAdaptiveTurn({ ...base, maxTier: "economy" })).toHaveProperty("error");
    expect(
      resolveAdaptiveTurn({ ...base, capabilities: { ...capabilities, fixedEffort: "high" } }),
    ).toHaveProperty("error");
    const limited = (usedPercent: number): AdaptiveProviderCapabilities => ({
      ...capabilities,
      usageLimits: {
        checkedAt: "2026-01-01T00:00:00.000Z",
        windows: [{ id: "week", kind: "weekly", label: "Week", usedPercent }],
      },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: limited(92) })).toMatchObject({
      route: { requestedEffort: "low", reason: expect.stringContaining("subscription limit") },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: limited(100) })).toHaveProperty("error");
    const included = limited(20);
    expect(
      resolveAdaptiveTurn({
        ...base,
        capabilities: {
          ...included,
          usageLimits: { ...included.usageLimits!, zeroSpendCap: true },
        },
      }),
    ).toMatchObject({ route: { requestedEffort: "medium" } });
  });

  it("honors Bailian Token Plan quota windows like any subscription limit", () => {
    const base = { selection: auto, capabilities, text: "Implement a save button", nowMs: 0 };
    const tokenPlan = (usedPercent: number): AdaptiveProviderCapabilities => ({
      ...capabilities,
      usageLimits: {
        checkedAt: "2026-11-24T10:00:00.000Z",
        windows: [
          {
            id: "token_plan_per1Month",
            kind: "monthly",
            label: "Monthly quota",
            usedPercent,
            resetsAt: "2026-12-01T00:00:00.000Z",
            windowDurationMins: 30 * 24 * 60,
          },
        ],
      },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: tokenPlan(42) })).toMatchObject({
      route: { requestedEffort: "medium" },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: tokenPlan(92) })).toMatchObject({
      route: { requestedEffort: "low", reason: expect.stringContaining("subscription limit") },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: tokenPlan(100) })).toHaveProperty("error");
    // Unreadable quota keeps routing possible but must not advertise an unlimited allowance.
    const unreadable: AdaptiveProviderCapabilities = {
      ...capabilities,
      usageLimits: {
        checkedAt: "2026-11-24T10:00:00.000Z",
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Bailian reported no Token Plan quota data.",
        },
      },
    };
    expect(resolveAdaptiveTurn({ ...base, capabilities: unreadable })).toMatchObject({
      selection: { model: "work" },
    });
  });

  it("maps normalized effort to provider-specific option values", () => {
    const selection = { ...auto, options: [{ id: "variant", value: ADAPTIVE_SELECTION }] };
    expect(
      resolveAdaptiveTurn({
        selection,
        capabilities: {
          instanceId,
          effortOptionId: "variant",
          models: [
            {
              id: "quick",
              tier: "economy",
              efforts: ["minimal"],
              effortByLevel: { low: "minimal" },
            },
          ],
        },
        text: "Locate the entry point",
        nowMs: 0,
      }),
    ).toMatchObject({
      selection: { model: "quick", options: [{ id: "variant", value: "minimal" }] },
    });
  });
});
