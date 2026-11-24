import type { AdaptiveModelTier, ModelSelection } from "@t3tools/contracts";
import { usesAdaptiveSelection } from "./adaptiveRouting.ts";

export type RoutingProfileName = "economy" | "balanced" | "performance" | "custom";
/** Same values as the `autoTokenBudget` provider option. */
export type RoutingTokenBudgetValue = "unlimited" | "50000" | "200000" | "1000000";

export interface RoutingProfileConfig {
  readonly profile: RoutingProfileName;
  /** Used only by `custom`. */
  readonly maxTier: AdaptiveModelTier;
  /** Used only by `custom`. */
  readonly tokenBudget: RoutingTokenBudgetValue;
}

const PRESETS: Record<
  Exclude<RoutingProfileName, "custom">,
  { readonly maxTier: AdaptiveModelTier; readonly tokenBudget: RoutingTokenBudgetValue }
> = {
  economy: { maxTier: "economy", tokenBudget: "200000" },
  balanced: { maxTier: "expert", tokenBudget: "unlimited" },
  performance: { maxTier: "expert", tokenBudget: "unlimited" },
};

/** The `autoMaxTier` / `autoTokenBudget` values the router reads for this profile. */
export function routingProfileLimits(config: RoutingProfileConfig) {
  return config.profile === "custom" ? config : PRESETS[config.profile];
}

/**
 * Fills `autoMaxTier` / `autoTokenBudget` from the profile on Auto selections. Values already on
 * the selection win, and manual selections are returned untouched.
 */
export function applyRoutingProfile(
  selection: ModelSelection,
  config: RoutingProfileConfig,
): ModelSelection {
  if (!usesAdaptiveSelection(selection)) return selection;
  const limits = routingProfileLimits(config);
  const options = selection.options ?? [];
  const missing = [
    { id: "autoMaxTier", value: limits.maxTier },
    { id: "autoTokenBudget", value: limits.tokenBudget },
  ].filter(({ id }) => !options.some((option) => option.id === id));
  return missing.length === 0 ? selection : { ...selection, options: [...options, ...missing] };
}
