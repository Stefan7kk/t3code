import {
  ADAPTIVE_SELECTION,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  cursorAdaptiveCapabilities,
  cursorAdaptiveTier,
  resolveCursorAdaptiveSelection,
  withCursorAdaptiveChoices,
} from "./cursorAdaptiveRouting.ts";

const instanceId = ProviderInstanceId.make("cursor");

const model = (
  slug: string,
  effort?: { id: string; levels: ReadonlyArray<string> },
  extra: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  ...extra,
  capabilities: {
    optionDescriptors: [
      ...(effort
        ? [
            {
              id: effort.id,
              type: "select" as const,
              label: "Effort",
              options: effort.levels.map((id, index) => ({
                id,
                label: id,
                ...(index === 1 ? { isDefault: true } : {}),
              })),
            },
          ]
        : []),
      { id: "fastMode", type: "boolean" as const, label: "Fast" },
    ],
  },
});

const runtimeModels = [
  model("default", undefined, { isDefault: true }),
  model("grok-4.7-flash", { id: "reasoning_effort", levels: ["low", "medium"] }),
  model("gemini-4-neon", { id: "reasoning_effort", levels: ["low", "medium", "high"] }),
  model("claude-opus-5", { id: "effort", levels: ["low", "medium", "high", "max"] }),
  model("composer-2.5"),
];

const auto: ModelSelection = {
  instanceId,
  model: ADAPTIVE_SELECTION,
  options: [{ id: "effort", value: ADAPTIVE_SELECTION }],
};
const resolve = (text: string, selection = auto, models = runtimeModels, failureCount = 0) =>
  resolveCursorAdaptiveSelection({
    selection,
    models,
    text,
    history: { failureCount, tokens: 0 },
    nowMs: 0,
  });

describe("Cursor Auto capabilities", () => {
  it("assigns tiers by version-agnostic keywords", () => {
    expect(cursorAdaptiveTier("claude-haiku-9")).toBe("economy");
    expect(cursorAdaptiveTier("gemini-9-flash")).toBe("economy");
    expect(cursorAdaptiveTier("claude-opus-9")).toBe("expert");
    expect(cursorAdaptiveTier("gpt-9-max")).toBe("expert");
    expect(cursorAdaptiveTier("grok-4.7")).toBe("worker");
    expect(cursorAdaptiveTier("composer-2.5")).toBe("worker");
  });

  it("keeps each model's own effort option id and excludes Cursor's Auto and custom models", () => {
    const capabilities = cursorAdaptiveCapabilities(instanceId, [
      ...runtimeModels,
      model("auto"),
      model(ADAPTIVE_SELECTION),
      model("mine", { id: "effort", levels: ["low"] }, { isCustom: true }),
    ]);
    expect(capabilities.models.map(({ id }) => id)).toEqual([
      "grok-4.7-flash",
      "gemini-4-neon",
      "claude-opus-5",
      "composer-2.5",
    ]);
    expect(capabilities.models.map(({ effortOptionId }) => effortOptionId)).toEqual([
      "reasoning_effort",
      "reasoning_effort",
      "effort",
      undefined,
    ]);
    expect(capabilities.models.at(-1)?.efforts).toEqual([]);
  });

  it("adds Auto effort only where an effort selector exists, leaving defaults alone", () => {
    const models = withCursorAdaptiveChoices(runtimeModels);
    expect(models[0]).toMatchObject({ slug: "default", isDefault: true });
    const grok = models[1]?.capabilities?.optionDescriptors?.[0];
    expect(grok?.type === "select" && grok.options[0]).toMatchObject({ id: ADAPTIVE_SELECTION });
    expect(grok?.type === "select" && grok.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "medium", isDefault: true })]),
    );
    expect(models[4]).toEqual(runtimeModels[4]);
    expect(models.at(-1)).toMatchObject({
      slug: ADAPTIVE_SELECTION,
      supportsTextGeneration: false,
    });
    expect(withCursorAdaptiveChoices([model("mine", undefined, { isCustom: true })])).toHaveLength(
      1,
    );
  });

  it("routes by tier and writes the resolved model's own effort option id", () => {
    expect(resolve("Find where the folder is defined")).toMatchObject({
      selection: {
        model: "grok-4.7-flash",
        options: [{ id: "reasoning_effort", value: "low" }],
      },
    });
    expect(resolve("try again", auto, runtimeModels, 2)).toMatchObject({
      selection: { model: "claude-opus-5", options: [{ id: "effort", value: "high" }] },
      route: { effortOptionId: "effort" },
    });
    expect(resolve("Implement a save button")).toMatchObject({
      selection: { model: "gemini-4-neon", options: [{ id: "reasoning_effort", value: "medium" }] },
    });
  });

  it("resolves Auto effort on a manually chosen model using that model's id", () => {
    expect(
      resolve("Debug the race condition", {
        instanceId,
        model: "gemini-4-neon",
        options: [{ id: "reasoning_effort", value: ADAPTIVE_SELECTION }],
      }),
    ).toMatchObject({
      selection: { model: "gemini-4-neon", options: [{ id: "reasoning_effort", value: "high" }] },
    });
    expect(
      resolve("Debug the race condition", {
        instanceId,
        model: "composer-2.5",
        options: [{ id: "effort", value: ADAPTIVE_SELECTION }],
      }),
    ).toMatchObject({ selection: { model: "composer-2.5", options: [] } });
  });

  it("honors the tier cap and de-escalates near a limit", () => {
    expect(
      resolve("Implement a save button", {
        ...auto,
        options: [...(auto.options ?? []), { id: "autoMaxTier", value: "economy" }],
      }),
    ).toMatchObject({
      route: { tier: "economy", reason: expect.stringContaining("capped at economy") },
    });
    const limited = (usedPercent: number) =>
      resolveCursorAdaptiveSelection({
        selection: auto,
        models: runtimeModels,
        text: "Implement a save button",
        nowMs: 0,
        usageLimits: {
          checkedAt: "2026-11-24T10:00:00.000Z",
          windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent }],
        },
      });
    expect(limited(92)).toMatchObject({ route: { requestedEffort: "low" } });
    expect(limited(100)).toHaveProperty("error");
  });
});
