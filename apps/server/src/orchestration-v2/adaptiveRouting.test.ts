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
    ["Reply with just OK", "quick", "low"],
    ["thanks, what does this error mean?", "work", "medium"],
    ["why is it so slow", "work", "medium"],
    ["Is the build broken?", "work", "medium"],
    ["It works, but why does it crash on exit?", "work", "medium"],
    [`Implement the importer. ${"Handle every listed case. ".repeat(70)}`, "deep", "high"],
    ["Update a.ts, b.ts, c.tsx, d.py and e.json to the new name", "deep", "high"],
    ["Build a new dashboard app with login", "deep", "high"],
    ["How do I build an app like this?", "work", "medium"],
    ["Design an LRU cache with O(1) get and put", "work", "high"],
    ["Add a dark mode toggle to settings", "work", "medium"],
    ["Fix src/app.ts", "work", "medium"],
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

  it("keeps follow-ups and harness notices on the running task's route", () => {
    const hard = { tier: "worker", effort: "high" } as const;
    for (const text of [
      "any update?",
      "?",
      "ten minutes over",
      "why is this so slow",
      'Background command "Run the full test suite" completed (exit code 0)',
      "Continue where you left off.",
      "where is the config file?",
      "Before the next step, tell me in plain words where the whole thing stands right now, please",
    ]) {
      expect(classifyAdaptiveTask(text, 0, hard), text).toMatchObject(hard);
    }
    // Only a fresh standalone question may drop to economy.
    expect(classifyAdaptiveTask("is it done?", 0)).toMatchObject({ tier: "economy" });
    expect(
      classifyAdaptiveTask("is it done?", 0, { tier: "economy", effort: "low" }),
    ).toMatchObject({ tier: "economy" });
    // A fresh architecture or build request starts on the expert model; short follow-ups do not.
    expect(classifyAdaptiveTask("Design the authentication architecture", 0, hard)).toMatchObject({
      tier: "expert",
    });
    expect(
      resolveAdaptiveTurn({
        selection: auto,
        capabilities,
        text: "continue",
        history: {
          failureCount: 0,
          tokens: 0,
          previousRoute: {
            tier: "expert",
            reason: "Architecture or security-critical decision",
            requestedModel: "deep",
            requestedEffort: "high",
          },
        },
        nowMs: 0,
      }),
    ).toMatchObject({ selection: { model: "work", options: [{ id: "effort", value: "high" }] } });
  });

  it("uses the nearest tier with a model when the provider has no cheap one, never past the cap", () => {
    const noCheap: AdaptiveProviderCapabilities = {
      ...capabilities,
      models: capabilities.models.filter((model) => model.tier !== "economy"),
    };
    const resolve = (maxTier?: "economy" | "worker" | "expert") =>
      resolveAdaptiveTurn({
        selection: auto,
        capabilities: noCheap,
        text: "Reply with exactly one word: OK",
        nowMs: 0,
        ...(maxTier === undefined ? {} : { maxTier }),
      });
    expect(resolve()).toMatchObject({
      selection: { model: "work" },
      route: { tier: "worker", reason: expect.stringContaining("no economy model available") },
    });
    expect(resolve("economy")).toHaveProperty("error");
  });

  it("uses the lowest supported effort when a model only offers levels above the wanted one", () => {
    const highOnly: AdaptiveProviderCapabilities = {
      ...capabilities,
      models: capabilities.models.map((model) =>
        model.tier === "economy" ? { ...model, efforts: ["high", "max"] } : model,
      ),
    };
    const result = resolveAdaptiveTurn({
      selection: auto,
      capabilities: highOnly,
      text: "Reply with exactly one word: OK",
      nowMs: 0,
    });
    expect(result).not.toHaveProperty("error");
    expect(result).toMatchObject({ selection: { options: [{ id: "effort", value: "high" }] } });
  });

  it("caps follow-ups at worker/high unless failures hold the escalation", () => {
    const expert = {
      tier: "expert",
      effort: "high",
      reason: "Architecture or security-critical decision",
    } as const;
    expect(classifyAdaptiveTask("continue", 0, expert)).toMatchObject({
      tier: "worker",
      effort: "high",
    });
    expect(classifyAdaptiveTask("continue", 2, expert)).toMatchObject({ tier: "expert" });
  });

  it("uses the top model only after the expert model failed twice, else stays on expert", () => {
    const withTop = {
      ...capabilities,
      models: [...capabilities.models, { id: "top", tier: "expert", top: true, efforts: ["high"] }],
    } as const;
    const pick = (failureCount: number, caps: AdaptiveProviderCapabilities) =>
      resolveAdaptiveTurn({
        selection: auto,
        capabilities: caps,
        text: "continue",
        history: { failureCount, tokens: 0 },
        nowMs: 0,
      });
    expect(pick(3, withTop)).toMatchObject({ selection: { model: "deep" } });
    expect(pick(4, withTop)).toMatchObject({ selection: { model: "top" } });
    expect(pick(4, capabilities)).toMatchObject({ selection: { model: "deep" } });
  });

  it("escalates on a failure streak carried by runtime signals and steps back down", () => {
    const worker = { tier: "worker", effort: "medium" } as const;
    // Two turns ended with failing tests: the next ping goes to the expert model.
    const escalated = classifyAdaptiveTask("try again", 2, worker);
    expect(escalated).toMatchObject({ tier: "expert", effort: "high", failureCount: 2 });
    expect(classifyAdaptiveTask("is it done?", 2, escalated)).toMatchObject({ tier: "expert" });
    expect(classifyAdaptiveTask("that is wrong", 1, worker)).toMatchObject({ tier: "expert" });
    // The expert turn's tests passed (streak 0): follow-ups return to the worker model.
    expect(classifyAdaptiveTask("what next?", 0, escalated)).toMatchObject({
      tier: "worker",
      effort: "high",
      failureCount: 0,
    });
    expect(classifyAdaptiveTask("Implement the next feature", 2, escalated)).toMatchObject({
      tier: "worker",
      failureCount: 0,
    });
  });

  it("lets the economy-model pre-check place only requests the rules cannot", () => {
    const economy = { tier: "economy", effort: "low" } as const;
    const unclear =
      "Health check for the sub-agent. Do not run any tools or read files. Reply with exactly: OK";
    expect(classifyAdaptiveTask(unclear, 0)).toMatchObject({ tier: "worker", unclear: true });
    expect(classifyAdaptiveTask(unclear, 0, undefined, economy)).toMatchObject(economy);
    expect(
      classifyAdaptiveTask(unclear, 0, undefined, { tier: "expert", effort: "high" }),
    ).toMatchObject({ tier: "worker", effort: "high" });
    expect(classifyAdaptiveTask(`${unclear} ${"x ".repeat(800)}`, 0)).toMatchObject({
      unclear: false,
      effort: "high",
    });
    // Clear cases, follow-ups on hard work and the safety floor ignore the pre-check.
    expect(
      classifyAdaptiveTask("Debug an intermittent deadlock", 0, undefined, economy),
    ).toMatchObject({ tier: "worker", effort: "high", unclear: false });
    expect(
      classifyAdaptiveTask(unclear, 0, { tier: "worker", effort: "high" }, economy),
    ).toMatchObject({ tier: "worker", effort: "high", unclear: false });
    expect(
      classifyAdaptiveTask(
        "Please update the page so the crash on save is gone for good",
        0,
        undefined,
        economy,
      ),
    ).toMatchObject({ tier: "worker" });
    expect(
      resolveAdaptiveTurn({
        selection: auto,
        capabilities,
        text: unclear,
        precheck: economy,
        nowMs: 0,
      }),
    ).toMatchObject({ selection: { model: "quick" } });
  });

  it("uses subscription headroom and enforces budget, exhausted windows, and effort overrides", () => {
    const base = { selection: auto, capabilities, text: "Implement a save button", nowMs: 0 };
    expect(
      resolveAdaptiveTurn({ ...base, tokenBudget: 100, history: { tokens: 100, failureCount: 0 } }),
    ).toHaveProperty("error");
    expect(resolveAdaptiveTurn({ ...base, maxTier: "economy" })).toMatchObject({
      selection: { model: "quick" },
      route: { tier: "economy", reason: expect.stringContaining("capped at economy") },
    });
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
