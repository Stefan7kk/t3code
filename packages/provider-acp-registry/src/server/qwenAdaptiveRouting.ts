import {
  ADAPTIVE_SELECTION,
  type AdaptiveModelTier,
  type ModelSelection,
  type SelectProviderOptionDescriptor,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import {
  resolveAdaptiveTurn,
  type AdaptiveProviderCapabilities,
} from "@t3tools/provider-core/server/adaptiveRouting";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { AcpRegistrySettings } from "../settings.ts";

const REASONING_OPTION_ID = "reasoning_effort";

/** Qwen Code (Alibaba Bailian) is the only ACP flavor with Auto routing; it runs as `qwen-code`. */
export function isQwenAdaptiveAgent(settings: AcpRegistrySettings): boolean {
  return settings.source === "local"
    ? /^qwen(?:-code)?(?:\.exe|\.cmd)?$/i.test(settings.commandPath.split(/[\\/]/).pop() ?? "")
    : settings.agentId === "qwen-code";
}

const economyVariant = /(?:^|[-._\s])(?:flash|lite|mini|nano|turbo|air)(?:$|[-._\s])/i;
const expertVariant = /(?:^|[-._\s])(?:max|pro|ultra|thinking)(?:$|[-._\s])/i;

/** Slugs name no version-stable tier, so classify by variant keyword: flash small, max/pro large. */
export function qwenAdaptiveTier(slug: string): AdaptiveModelTier {
  const family = slug.replace(/\([^)]*\)/g, "").trim();
  if (economyVariant.test(family)) return "economy";
  if (expertVariant.test(family)) return "expert";
  return "worker";
}

// Alibaba already lists its own `auto(openai)` router, which is not a concrete model to route to.
const isAutoSlug = (slug: string) => slug === ADAPTIVE_SELECTION || /^auto(?:$|[\s(-])/i.test(slug);

const reasoningDescriptor = (model: ServerProviderModel) =>
  model.capabilities?.optionDescriptors?.find(
    (option): option is SelectProviderOptionDescriptor =>
      option.type === "select" &&
      (option.id === REASONING_OPTION_ID || option.role === "reasoning"),
  );

export function qwenAdaptiveCapabilities(
  instanceId: ModelSelection["instanceId"],
  models: ReadonlyArray<ServerProviderModel>,
  usageLimits?: ServerProviderUsageLimits,
): AdaptiveProviderCapabilities {
  const adaptiveModels = models.flatMap((model) => {
    if (model.isCustom || isAutoSlug(model.slug)) return [];
    const descriptor = reasoningDescriptor(model);
    return [
      {
        id: model.slug,
        reportedId: model.slug,
        tier: qwenAdaptiveTier(model.slug),
        efforts: (descriptor?.options ?? [])
          .map(({ id }) => id)
          .filter((id) => id !== ADAPTIVE_SELECTION),
        ...(descriptor === undefined ? {} : { effortOptionId: descriptor.id }),
      },
    ];
  });
  // Within a tier the provider's default model comes first, then discovery order.
  const defaultSlug = models.find((model) => model.isDefault)?.slug;
  adaptiveModels.sort((a, b) => Number(b.id === defaultSlug) - Number(a.id === defaultSlug));
  return {
    instanceId,
    effortOptionId: REASONING_OPTION_ID,
    models: adaptiveModels,
    ...(usageLimits === undefined ? {} : { usageLimits }),
  };
}

const effortChoice = {
  id: ADAPTIVE_SELECTION,
  label: "Auto",
  description: "Choose effort per turn",
};

const budgetOptions = [
  {
    id: "autoMaxTier",
    type: "select",
    label: "Maximum Auto tier",
    options: [
      { id: "expert", label: "Expert", isDefault: true },
      { id: "worker", label: "Worker" },
      { id: "economy", label: "Economy" },
    ],
  },
  {
    id: "autoTokenBudget",
    type: "select",
    label: "Auto token budget per thread",
    options: [
      { id: "unlimited", label: "Unlimited", isDefault: true },
      { id: "50000", label: "50,000" },
      { id: "200000", label: "200,000" },
      { id: "1000000", label: "1,000,000" },
    ],
  },
] as const;

/**
 * Adds an Auto effort choice to each model that reports reasoning levels, plus an Auto model entry,
 * leaving every default untouched. Safe to apply to a list that already carries the choices.
 */
export function withQwenAdaptiveChoices(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const concrete = models.filter((model) => model.slug !== ADAPTIVE_SELECTION);
  const withoutAuto = concrete.map((model) =>
    reasoningDescriptor(model)?.options.some(({ id }) => id === ADAPTIVE_SELECTION)
      ? {
          ...model,
          capabilities: {
            ...model.capabilities,
            optionDescriptors: (model.capabilities?.optionDescriptors ?? []).map((option) =>
              option.type === "select"
                ? {
                    ...option,
                    options: option.options.filter(({ id }) => id !== ADAPTIVE_SELECTION),
                  }
                : option,
            ),
          },
        }
      : model,
  );
  const reasoning = withoutAuto.flatMap((model) => {
    const descriptor = model.isCustom ? undefined : reasoningDescriptor(model);
    return descriptor === undefined || descriptor.options.length === 0 ? [] : [descriptor];
  });
  if (reasoning.length === 0) return withoutAuto;
  const levels = new Map(
    reasoning.flatMap(({ options }) => options.map((option) => [option.id, option] as const)),
  );
  return [
    ...withoutAuto.map((model) =>
      model.isCustom || reasoningDescriptor(model) === undefined
        ? model
        : {
            ...model,
            capabilities: {
              ...model.capabilities,
              optionDescriptors: (model.capabilities?.optionDescriptors ?? []).map((option) =>
                option.type === "select" && option === reasoningDescriptor(model)
                  ? { ...option, options: [effortChoice, ...option.options] }
                  : option,
              ),
            },
          },
    ),
    {
      slug: ADAPTIVE_SELECTION,
      name: "Auto",
      isCustom: false,
      supportsTextGeneration: false,
      capabilities: {
        optionDescriptors: [
          {
            id: reasoning[0]!.id,
            type: "select",
            role: "reasoning",
            label: reasoning[0]!.label,
            options: [
              { id: "default", label: "Default", isDefault: true },
              effortChoice,
              ...[...levels.values()].map(({ id, label }) => ({ id, label })),
            ],
          },
          ...budgetOptions,
        ],
      },
    },
  ];
}

export interface QwenRoutingSnapshot {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

/** Flavor hook: resolves an Auto selection from the provider snapshot's models and quota. */
export const makeQwenAdaptiveResolver = (input: {
  readonly instanceId: ModelSelection["instanceId"];
  readonly snapshot: Effect.Effect<QwenRoutingSnapshot>;
}) =>
  Effect.fn("QwenAdaptiveRouting.resolve")(function* (
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) {
    const { models, usageLimits } = yield* input.snapshot;
    const tierOption = getModelSelectionStringOptionValue(turnInput.modelSelection, "autoMaxTier");
    const maxTier: AdaptiveModelTier =
      tierOption === "economy" || tierOption === "worker" ? tierOption : "expert";
    const budget = Number(
      getModelSelectionStringOptionValue(turnInput.modelSelection, "autoTokenBudget"),
    );
    const decision = resolveAdaptiveTurn({
      selection: turnInput.modelSelection,
      capabilities: qwenAdaptiveCapabilities(input.instanceId, models, usageLimits),
      text:
        turnInput.adaptiveHistory?.taskText ??
        turnInput.message.text.slice(turnInput.inlineContextLength ?? 0),
      ...(turnInput.adaptiveHistory === undefined ? {} : { history: turnInput.adaptiveHistory }),
      maxTier,
      ...(Number.isSafeInteger(budget) && budget > 0 ? { tokenBudget: budget } : {}),
      nowMs: yield* Clock.currentTimeMillis,
    });
    return "error" in decision
      ? { error: decision.error }
      : { selection: decision.selection, route: decision.route };
  });
