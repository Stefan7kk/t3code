import {
  ADAPTIVE_SELECTION,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveAdaptiveTurn } from "../orchestration-v2/adaptiveRouting.ts";
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  codexAdaptiveCapabilities,
  codexAdaptiveTier,
  withCodexAdaptiveChoices,
} from "./codexAdaptiveRouting.ts";

const instanceId = ProviderInstanceId.make("codex");

const model = (
  slug: string,
  efforts: ReadonlyArray<string>,
  isDefault = false,
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        type: "select",
        label: "Reasoning",
        options: efforts.map((id, index) => ({
          id,
          label: id,
          ...(index === 1 ? { isDefault: true } : {}),
        })),
      },
    ],
  },
});

const runtimeModels = [
  model("gpt-5.6-codex-mini", ["low", "medium"]),
  model("gpt-6-astra", ["low", "medium", "high"], true),
  model("gpt-5.6-codex-max", ["low", "medium", "high", "max"]),
];

describe("Codex Auto capabilities", () => {
  it("assigns tiers by version-agnostic family keywords, not version numbers", () => {
    expect(codexAdaptiveTier("gpt-5.6-codex-mini")).toBe("economy");
    expect(codexAdaptiveTier("openai.gpt-9-codex-spark")).toBe("economy");
    expect(codexAdaptiveTier("gpt-5.6-codex-max")).toBe("expert");
    expect(codexAdaptiveTier("gpt-9-codex-ultra")).toBe("expert");
    expect(codexAdaptiveTier("gpt-6-astra")).toBe("worker");
    expect(codexAdaptiveTier("gpt-5.6-sol")).toBe("worker");
  });

  it("discovers runtime models and reasoning levels, default model first within the list", () => {
    const capabilities = codexAdaptiveCapabilities(instanceId, runtimeModels);
    expect(capabilities.effortOptionId).toBe("reasoningEffort");
    expect(capabilities.models[0]).toMatchObject({ id: "gpt-6-astra", tier: "worker" });
    expect(capabilities.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.6-codex-mini",
          tier: "economy",
          efforts: ["low", "medium"],
        }),
        expect.objectContaining({ id: "gpt-5.6-codex-max", tier: "expert" }),
      ]),
    );
  });

  it("skips custom models; keeps models without reasoning levels for manual effort", () => {
    const capabilities = codexAdaptiveCapabilities(instanceId, [
      { slug: "my-custom", name: "Custom", isCustom: true, capabilities: null },
      { slug: "gpt-no-effort", name: "No effort", isCustom: false, capabilities: null },
      model("gpt-6-astra", ["low", "medium", "high"], true),
    ]);
    expect(capabilities.models.map((entry) => entry.id)).toEqual(["gpt-6-astra", "gpt-no-effort"]);
    expect(capabilities.models.find((entry) => entry.id === "gpt-no-effort")?.efforts).toEqual([]);
  });

  it("offers Auto effort and an Auto model without changing existing defaults", () => {
    const models = withCodexAdaptiveChoices(runtimeModels);
    expect(models[1]).toMatchObject({ slug: "gpt-6-astra", isDefault: true });
    const astraOptions = models[1]?.capabilities?.optionDescriptors?.[0];
    expect(astraOptions?.type === "select" && astraOptions.options[0]).toMatchObject({
      id: ADAPTIVE_SELECTION,
    });
    expect(astraOptions?.type === "select" && astraOptions.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "medium", isDefault: true })]),
    );
    const auto = models.at(-1);
    expect(auto).toMatchObject({ slug: ADAPTIVE_SELECTION, supportsTextGeneration: false });
    expect(auto?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      id: "reasoningEffort",
      options: expect.arrayContaining([
        expect.objectContaining({ id: "default", isDefault: true }),
        expect.objectContaining({ id: ADAPTIVE_SELECTION }),
        expect.objectContaining({ id: "high" }),
      ]),
    });
    expect(
      withCodexAdaptiveChoices([{ slug: "x", name: "X", isCustom: false, capabilities: null }]),
    ).toHaveLength(1);
  });

  it("routes tasks through the shared provider-agnostic resolver", () => {
    const capabilities = codexAdaptiveCapabilities(instanceId, runtimeModels);
    const auto: ModelSelection = {
      instanceId,
      model: ADAPTIVE_SELECTION,
      options: [{ id: "reasoningEffort", value: ADAPTIVE_SELECTION }],
    };
    const resolve = (text: string, failureCount = 0) =>
      resolveAdaptiveTurn({
        selection: auto,
        capabilities,
        text,
        history: { failureCount, tokens: 0 },
        nowMs: 0,
      });
    expect(resolve("Find where the folder is defined")).toMatchObject({
      selection: {
        model: "gpt-5.6-codex-mini",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });
    expect(resolve("Implement a save button")).toMatchObject({
      selection: { model: "gpt-6-astra", options: [{ id: "reasoningEffort", value: "medium" }] },
    });
    expect(resolve("try again", 2)).toMatchObject({
      selection: {
        model: "gpt-5.6-codex-max",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    expect(
      resolveAdaptiveTurn({
        selection: auto,
        capabilities,
        text: "Implement a save button",
        nowMs: 0,
        maxTier: "economy",
      }),
    ).toMatchObject({
      route: { tier: "economy", reason: expect.stringContaining("capped at economy") },
    });
  });

  it.effect("sends the resolved Auto model and effort on the wire, not the Auto placeholder", () =>
    Effect.gen(function* () {
      const capabilities = codexAdaptiveCapabilities(instanceId, runtimeModels);
      const auto: ModelSelection = {
        instanceId,
        model: ADAPTIVE_SELECTION,
        options: [{ id: "reasoningEffort", value: ADAPTIVE_SELECTION }],
      };
      const decision = resolveAdaptiveTurn({
        selection: auto,
        capabilities,
        text: "Implement a save button",
        nowMs: 0,
      });
      if ("error" in decision) throw new Error(decision.error);
      const params = yield* buildCodexTurnStartParams({
        nativeThreadId: "native-auto",
        codexInput: [{ type: "text", text: "Implement a save button" }],
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        modelSelection: decision.selection,
      });
      expect(params.model).toBe("gpt-6-astra");
      expect(params.effort).toBe("medium");
      expect(params.collaborationMode).toMatchObject({
        settings: { model: "gpt-6-astra", reasoning_effort: "medium" },
      });
    }),
  );

  it("de-escalates effort near a Codex subscription limit and blocks an exhausted one", () => {
    const capabilities = codexAdaptiveCapabilities(instanceId, runtimeModels);
    const auto: ModelSelection = {
      instanceId,
      model: ADAPTIVE_SELECTION,
      options: [{ id: "reasoningEffort", value: ADAPTIVE_SELECTION }],
    };
    const withLimits = (usedPercent: number) => ({
      ...capabilities,
      usageLimits: {
        checkedAt: "2026-11-24T10:00:00.000Z",
        windows: [{ id: "secondary", kind: "weekly" as const, label: "Weekly", usedPercent }],
      },
    });
    const base = { selection: auto, text: "Implement a save button", nowMs: 0 };
    expect(resolveAdaptiveTurn({ ...base, capabilities: withLimits(92) })).toMatchObject({
      route: { requestedEffort: "low" },
    });
    expect(resolveAdaptiveTurn({ ...base, capabilities: withLimits(100) })).toHaveProperty("error");
  });
});
