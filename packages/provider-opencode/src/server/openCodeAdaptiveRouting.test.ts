import {
  ADAPTIVE_SELECTION,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { resolveAdaptiveTurn } from "@t3tools/provider-core/server/adaptiveRouting";
import { describe, expect, it } from "vite-plus/test";
import {
  openCodeAdaptiveCapabilities,
  openCodeAdaptiveTier,
  openCodeModelsFromVariants,
  withOpenCodeAdaptiveChoices,
} from "./openCodeAdaptiveRouting.ts";

const instanceId = ProviderInstanceId.make("opencode");

const model = (slug: string, variants: ReadonlyArray<string>): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors:
      variants.length === 0
        ? []
        : [
            {
              id: "variant",
              type: "select",
              label: "Reasoning",
              options: variants.map((id, index) => ({
                id,
                label: id,
                ...(index === 1 ? { isDefault: true } : {}),
              })),
            },
          ],
  },
});

const runtimeModels = [
  model("opencode-go/beam-free", ["low", "medium"]),
  model("opencode-go/claude-haiku-5-5", ["low", "medium", "high"]),
  model("opencode-go/gpt-6-luna", ["low", "medium", "high"]),
  model("opencode-go/glm-5.3", []),
  model("opencode-go/deepseek-v4-pro", ["low", "medium", "high", "max"]),
  model("openrouter/some-pro", ["high"]),
];

const auto: ModelSelection = {
  instanceId,
  model: ADAPTIVE_SELECTION,
  options: [{ id: "variant", value: ADAPTIVE_SELECTION }],
};

describe("OpenCode Auto capabilities", () => {
  it("assigns tiers by version-agnostic keywords, not versions or provider", () => {
    expect(openCodeAdaptiveTier("opencode-go/beam-free")).toBe("economy");
    expect(openCodeAdaptiveTier("opencode-go/claude-haiku-9-1")).toBe("economy");
    expect(openCodeAdaptiveTier("anthropic/gemini-9-flash")).toBe("economy");
    expect(openCodeAdaptiveTier("opencode-go/deepseek-v9-pro")).toBe("expert");
    expect(openCodeAdaptiveTier("opencode-go/claude-opus-9")).toBe("expert");
    expect(openCodeAdaptiveTier("opencode-go/gpt-6-luna")).toBe("worker");
    expect(openCodeAdaptiveTier("opencode-go/glm-5.3")).toBe("worker");
    // A provider named like a tier keyword must not change the model's tier.
    expect(openCodeAdaptiveTier("pro-host/gpt-6-luna")).toBe("worker");
  });

  it("discovers variants per model and keeps routing inside the Go pool when present", () => {
    const capabilities = openCodeAdaptiveCapabilities(instanceId, runtimeModels);
    expect(capabilities.effortOptionId).toBe("variant");
    expect(capabilities.models.map((entry) => entry.id)).not.toContain("openrouter/some-pro");
    expect(capabilities.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "opencode-go/beam-free",
          tier: "economy",
          efforts: ["low", "medium"],
        }),
        expect.objectContaining({ id: "opencode-go/glm-5.3", tier: "worker", efforts: [] }),
        expect.objectContaining({ id: "opencode-go/deepseek-v4-pro", tier: "expert" }),
      ]),
    );
    expect(
      openCodeAdaptiveCapabilities(instanceId, [model("openrouter/x-pro", ["high"])]).models,
    ).toHaveLength(1);
  });

  it("rebuilds listed models from the adapter's discovered variant map", () => {
    const rebuilt = openCodeModelsFromVariants(
      new Map([
        ["opencode-go/gpt-6-luna", new Set(["low", "high"])],
        ["opencode-go/glm-5.3", new Set<string>()],
      ]),
    );
    expect(openCodeAdaptiveCapabilities(instanceId, rebuilt).models).toEqual([
      expect.objectContaining({ id: "opencode-go/gpt-6-luna", efforts: ["low", "high"] }),
      expect.objectContaining({ id: "opencode-go/glm-5.3", efforts: [] }),
    ]);
  });

  it("offers Auto variant and an Auto model without changing defaults or variant-less models", () => {
    const models = withOpenCodeAdaptiveChoices(runtimeModels);
    const luna = models.find((entry) => entry.slug === "opencode-go/gpt-6-luna");
    const lunaVariant = luna?.capabilities?.optionDescriptors?.[0];
    expect(lunaVariant?.type === "select" && lunaVariant.options[0]).toMatchObject({
      id: ADAPTIVE_SELECTION,
    });
    expect(lunaVariant?.type === "select" && lunaVariant.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "medium", isDefault: true })]),
    );
    expect(models.find((entry) => entry.slug === "opencode-go/glm-5.3")).toBe(runtimeModels[3]);
    expect(models.at(-1)).toMatchObject({
      slug: ADAPTIVE_SELECTION,
      supportsTextGeneration: false,
    });
    expect(models.at(-1)?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "variant",
      options: expect.arrayContaining([expect.objectContaining({ id: ADAPTIVE_SELECTION })]),
    });
    expect(withOpenCodeAdaptiveChoices([model("opencode-go/glm-5.3", [])])).toHaveLength(1);
  });

  it("routes tasks to a concrete listed model and variant through the shared resolver", () => {
    const capabilities = openCodeAdaptiveCapabilities(instanceId, runtimeModels);
    const resolve = (text: string, maxTier?: "economy" | "worker" | "expert") =>
      resolveAdaptiveTurn({
        selection: auto,
        capabilities,
        text,
        nowMs: 0,
        ...(maxTier === undefined ? {} : { maxTier }),
      });
    expect(resolve("Find where the folder is defined")).toMatchObject({
      selection: {
        model: "opencode-go/beam-free",
        options: [{ id: "variant", value: "low" }],
      },
    });
    expect(resolve("Implement a save button")).toMatchObject({
      selection: { model: "opencode-go/gpt-6-luna", options: [{ id: "variant", value: "medium" }] },
    });
    expect(resolve("Design the authentication architecture")).toMatchObject({
      selection: {
        model: "opencode-go/deepseek-v4-pro",
        options: [{ id: "variant", value: "high" }],
      },
    });
    expect(resolve("Design the authentication architecture", "worker")).toHaveProperty("error");
  });

  it("de-escalates near a Go limit and blocks an exhausted one", () => {
    const capabilities = openCodeAdaptiveCapabilities(instanceId, runtimeModels);
    const withLimits = (usedPercent: number) => ({
      ...capabilities,
      usageLimits: {
        checkedAt: "2026-11-24T10:00:00.000Z",
        windows: [{ id: "go_weekly", kind: "weekly" as const, label: "Go", usedPercent }],
      },
    });
    const base = { selection: auto, text: "Implement a save button", nowMs: 0 };
    expect(resolveAdaptiveTurn({ ...base, capabilities: withLimits(92) })).toMatchObject({
      route: { requestedEffort: "low" },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: withLimits(100) })).toHaveProperty("error");
  });
});
