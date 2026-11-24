import { ADAPTIVE_SELECTION, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import {
  applyRoutingProfile,
  routingProfileLimits,
  type RoutingProfileConfig,
} from "./adaptiveProfiles.ts";

const instanceId = ProviderInstanceId.make("test");
const config = (overrides: Partial<RoutingProfileConfig>): RoutingProfileConfig => ({
  profile: "balanced",
  maxTier: "expert",
  tokenBudget: "unlimited",
  ...overrides,
});
const auto: ModelSelection = { instanceId, model: ADAPTIVE_SELECTION };
const optionValue = (selection: ModelSelection, id: string) =>
  selection.options?.find((option) => option.id === id)?.value;

describe("routing profiles", () => {
  it("maps presets to router limits", () => {
    expect(routingProfileLimits(config({ profile: "economy" }))).toEqual({
      maxTier: "economy",
      tokenBudget: "200000",
    });
    expect(routingProfileLimits(config({ profile: "balanced" })).maxTier).toBe("expert");
    expect(routingProfileLimits(config({ profile: "performance" })).maxTier).toBe("expert");
  });

  it("uses the custom tier and budget only for custom", () => {
    const custom = config({ profile: "custom", maxTier: "worker", tokenBudget: "50000" });
    expect(routingProfileLimits(custom)).toMatchObject({ maxTier: "worker", tokenBudget: "50000" });
    expect(routingProfileLimits({ ...custom, profile: "balanced" }).maxTier).toBe("expert");
  });

  it("applies the profile to Auto model selections", () => {
    const applied = applyRoutingProfile(auto, config({ profile: "economy" }));
    expect(optionValue(applied, "autoMaxTier")).toBe("economy");
    expect(optionValue(applied, "autoTokenBudget")).toBe("200000");
  });

  it("applies the profile to Auto effort selections and keeps other options", () => {
    const effortAuto: ModelSelection = {
      instanceId,
      model: "gpt-x",
      options: [{ id: "reasoningEffort", value: ADAPTIVE_SELECTION }],
    };
    const applied = applyRoutingProfile(effortAuto, config({ profile: "economy" }));
    expect(optionValue(applied, "reasoningEffort")).toBe(ADAPTIVE_SELECTION);
    expect(optionValue(applied, "autoMaxTier")).toBe("economy");
  });

  it("keeps limits already chosen on the selection", () => {
    const chosen: ModelSelection = {
      ...auto,
      options: [{ id: "autoMaxTier", value: "worker" }],
    };
    const applied = applyRoutingProfile(chosen, config({ profile: "economy" }));
    expect(optionValue(applied, "autoMaxTier")).toBe("worker");
    expect(optionValue(applied, "autoTokenBudget")).toBe("200000");
  });

  it("leaves manual selections untouched", () => {
    const manual: ModelSelection = {
      instanceId,
      model: "gpt-x",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(applyRoutingProfile(manual, config({ profile: "economy" }))).toBe(manual);
  });
});
