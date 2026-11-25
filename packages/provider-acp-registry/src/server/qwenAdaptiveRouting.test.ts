import { describe, expect, it } from "@effect/vitest";
import {
  ADAPTIVE_SELECTION,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import {
  isQwenAdaptiveAgent,
  makeQwenAdaptiveResolver,
  qwenAdaptiveCapabilities,
  qwenAdaptiveTier,
  withQwenAdaptiveChoices,
} from "./qwenAdaptiveRouting.ts";

const instanceId = ProviderInstanceId.make("acpRegistry_qwen");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

const model = (
  slug: string,
  efforts: ReadonlyArray<string>,
  extra: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors:
      efforts.length === 0
        ? []
        : [
            {
              id: "reasoning_effort",
              type: "select",
              role: "reasoning",
              label: "Reasoning effort",
              options: efforts.map((id) => ({ id, label: id })),
            },
          ],
  },
  ...extra,
});

const catalog = [
  model("qwen3.8-flash(openai)", ["none", "low", "high"]),
  model("qwen3.7-plus(openai)", ["none", "low", "high"], { isDefault: true }),
  model("qwen3.8-max(openai)", ["low", "high"]),
  model("qwen4-max(openai)", ["none", "low", "high", "xhigh"]),
  model("deepseek-v4.1-flash(openai)", ["low", "high"]),
  model("deepseek-v4-pro(openai)", ["low", "high"]),
  model("glm-5.3(openai)", []),
  model("auto(openai)", ["low", "high"]),
];

const turn = (
  text: string,
  selection: Partial<ModelSelection> & { options?: ModelSelection["options"] } = {},
) =>
  ({
    message: { text },
    modelSelection: {
      instanceId,
      model: ADAPTIVE_SELECTION,
      options: [{ id: "reasoning_effort", value: ADAPTIVE_SELECTION }],
      ...selection,
    },
  }) as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;

const resolve = (
  input: ProviderAdapter.ProviderAdapterV2TurnInput,
  usageLimits?: ServerProviderUsageLimits,
  models: ReadonlyArray<ServerProviderModel> = catalog,
) =>
  makeQwenAdaptiveResolver({
    instanceId,
    snapshot: Effect.succeed({ models, usageLimits }),
  })(input);

const limits = (usedPercent: number): ServerProviderUsageLimits => ({
  checkedAt: "2026-01-01T00:00:00.000Z",
  windows: [{ id: "token_plan_weekly", kind: "weekly", label: "Weekly", usedPercent }],
});

describe("qwenAdaptiveTier", () => {
  it("classifies by variant keyword regardless of version", () => {
    expect(qwenAdaptiveTier("qwen3.8-flash(openai)")).toBe("economy");
    expect(qwenAdaptiveTier("qwen9.1-flash")).toBe("economy");
    expect(qwenAdaptiveTier("deepseek-v4.1-flash(openai)")).toBe("economy");
    expect(qwenAdaptiveTier("qwen4-max(openai)")).toBe("expert");
    expect(qwenAdaptiveTier("deepseek-v5-pro(openai)")).toBe("expert");
    expect(qwenAdaptiveTier("qwen3.7-plus(openai)")).toBe("worker");
    expect(qwenAdaptiveTier("glm-5.3(openai)")).toBe("worker");
  });
});

describe("isQwenAdaptiveAgent", () => {
  it("enables only the Qwen Code agent", () => {
    expect(isQwenAdaptiveAgent(decodeSettings({ agentId: "qwen-code" }))).toBe(true);
    expect(isQwenAdaptiveAgent(decodeSettings({ agentId: "github-copilot-cli" }))).toBe(false);
  });
});

describe("qwenAdaptiveCapabilities", () => {
  it("excludes Auto entries and keeps the discovered reasoning levels per model", () => {
    const capabilities = qwenAdaptiveCapabilities(instanceId, withQwenAdaptiveChoices(catalog));
    expect(capabilities.effortOptionId).toBe("reasoning_effort");
    expect(capabilities.models.map(({ id }) => id)).not.toContain("auto(openai)");
    expect(capabilities.models.map(({ id }) => id)).not.toContain(ADAPTIVE_SELECTION);
    expect(capabilities.models.find(({ id }) => id === "qwen4-max(openai)")?.efforts).toEqual([
      "none",
      "low",
      "high",
      "xhigh",
    ]);
    // Default model sorts first.
    expect(capabilities.models[0]?.id).toBe("qwen3.7-plus(openai)");
  });
});

describe("withQwenAdaptiveChoices", () => {
  it("adds Auto choices without changing defaults and is idempotent", () => {
    const once = withQwenAdaptiveChoices(catalog);
    const twice = withQwenAdaptiveChoices(once);
    expect(twice).toEqual(once);
    expect(once.filter((entry) => entry.isDefault).map(({ slug }) => slug)).toEqual([
      "qwen3.7-plus(openai)",
    ]);
    const flash = once.find(({ slug }) => slug === "qwen3.8-flash(openai)");
    expect(flash?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: [{ id: ADAPTIVE_SELECTION }, { id: "none" }, { id: "low" }, { id: "high" }],
    });
    const glm = once.find(({ slug }) => slug === "glm-5.3(openai)");
    expect(glm?.capabilities?.optionDescriptors).toEqual([]);
    const auto = once.find(({ slug }) => slug === ADAPTIVE_SELECTION);
    expect(auto?.capabilities?.optionDescriptors?.map(({ id }) => id)).toEqual([
      "reasoning_effort",
      "autoMaxTier",
      "autoTokenBudget",
    ]);
  });

  it("leaves a catalog without reasoning levels untouched", () => {
    const plain = [model("glm-5.3(openai)", [])];
    expect(withQwenAdaptiveChoices(plain)).toEqual(plain);
  });
});

describe("makeQwenAdaptiveResolver", () => {
  it.effect("routes a lookup to an economy model and the highest fitting effort", () =>
    Effect.gen(function* () {
      const decision = yield* resolve(turn("find where the router is defined"));
      expect(decision).toEqual({
        selection: {
          instanceId,
          model: "qwen3.8-flash(openai)",
          options: [{ id: "reasoning_effort", value: "low" }],
        },
        // The route is what the adapter records on the provider turn.
        route: {
          tier: "economy",
          reason: "Lookup",
          requestedModel: "qwen3.8-flash(openai)",
          requestedEffort: "low",
          effortOptionId: "reasoning_effort",
          failureCount: 0,
        },
      });
    }),
  );

  it.effect("routes architecture work to an expert model with its own effort ceiling", () =>
    Effect.gen(function* () {
      const decision = yield* resolve(turn("design the architecture for the new sync layer"));
      expect(decision).toMatchObject({
        selection: {
          model: "qwen3.8-max(openai)",
          options: [{ id: "reasoning_effort", value: "high" }],
        },
      });
    }),
  );

  it.effect("keeps a manual model and only resolves Auto effort", () =>
    Effect.gen(function* () {
      const decision = yield* resolve(turn("fix the failing test", { model: "qwen4-max(openai)" }));
      expect(decision).toMatchObject({
        selection: {
          model: "qwen4-max(openai)",
          options: [{ id: "reasoning_effort", value: "low" }],
        },
      });
    }),
  );

  it.effect("honors the maximum Auto tier", () =>
    Effect.gen(function* () {
      const decision = yield* resolve(
        turn("design the architecture for the new sync layer", {
          options: [
            { id: "reasoning_effort", value: ADAPTIVE_SELECTION },
            { id: "autoMaxTier", value: "worker" },
          ],
        }),
      );
      expect(decision).toMatchObject({
        route: { tier: "worker", reason: expect.stringContaining("capped at worker") },
      });
    }),
  );

  it.effect("refuses to route when the Bailian quota is exhausted", () =>
    Effect.gen(function* () {
      expect(yield* resolve(turn("find the router"), limits(100))).toEqual({
        error: "The provider reports an exhausted usage or spend limit.",
      });
      expect(yield* resolve(turn("find the router"), limits(40))).toMatchObject({ selection: {} });
    }),
  );

  it.effect("reports when no model can serve the requested tier", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve(turn("find the router"), undefined, [model("glm-5.3(openai)", [])]),
      ).toMatchObject({ error: expect.stringContaining("No available economy model") });
    }),
  );
});
