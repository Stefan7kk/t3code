import {
  ADAPTIVE_SELECTION,
  type AdaptiveModelTier,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { AdaptiveProviderCapabilities } from "@t3tools/provider-core/server/adaptiveRouting";

/**
 * OpenCode slugs are `provider/model`. The tier comes from version-agnostic keywords in the model id:
 * small/fast/free models are Economy, large reasoning models Expert, everything else Worker.
 * Auto effort always uses the variant levels the runtime reports for each model.
 */
const effortOptionId = "variant";
// Go is the metered subscription pool Auto is built around; other providers are left to manual choice.
const goProviderId = "opencode-go";

const economyModel = /(?:^|[-.])(?:haiku|flash|mini|nano|lite|small|air|free)(?:$|[-.])/i;
const expertModel = /(?:^|[-.])(?:pro|max|ultra|opus|thinking)(?:$|[-.])/i;

export function openCodeAdaptiveTier(slug: string): AdaptiveModelTier {
  const id = slug.slice(slug.indexOf("/") + 1);
  if (economyModel.test(id)) return "economy";
  if (expertModel.test(id)) return "expert";
  return "worker";
}

function variantLevels(model: ServerProviderModel): ReadonlyArray<string> {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (option) => option.id === effortOptionId && option.type === "select",
  );
  return descriptor?.type === "select" ? descriptor.options.map(({ id }) => id) : [];
}

/** Rebuilds the listed-model shape from the adapter's discovered `provider/model` -> variants map. */
export function openCodeModelsFromVariants(
  variants: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<ServerProviderModel> {
  return [...variants].map(([slug, levels]) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities:
      levels.size === 0
        ? null
        : {
            optionDescriptors: [
              {
                id: effortOptionId,
                type: "select",
                label: "Reasoning",
                options: [...levels].map((id) => ({ id, label: id })),
              },
            ],
          },
  }));
}

export function openCodeAdaptiveCapabilities(
  instanceId: ModelSelection["instanceId"],
  models: ReadonlyArray<ServerProviderModel>,
): AdaptiveProviderCapabilities {
  const candidates = models.filter((model) => !model.isCustom && model.slug !== ADAPTIVE_SELECTION);
  const pool = candidates.some((model) => model.slug.startsWith(`${goProviderId}/`))
    ? candidates.filter((model) => model.slug.startsWith(`${goProviderId}/`))
    : candidates;
  return {
    instanceId,
    effortOptionId,
    models: pool.map((model) => ({
      id: model.slug,
      reportedId: model.slug,
      tier: openCodeAdaptiveTier(model.slug),
      efforts: variantLevels(model),
    })),
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
 * Adds an Auto choice to each OpenCode model's variant selector plus an Auto model entry, without
 * changing any default. Models that expose no variants stay manual.
 */
export function withOpenCodeAdaptiveChoices(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  if (!models.some((model) => !model.isCustom && variantLevels(model).length > 0)) return models;
  return [
    ...models.map((model) =>
      model.isCustom || variantLevels(model).length === 0
        ? model
        : {
            ...model,
            capabilities: {
              ...model.capabilities,
              optionDescriptors: (model.capabilities?.optionDescriptors ?? []).map((option) =>
                option.type === "select" && option.id === effortOptionId
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
            id: effortOptionId,
            type: "select",
            role: "reasoning",
            label: "Reasoning",
            options: [
              { id: "default", label: "Default", isDefault: true },
              effortChoice,
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "xhigh", label: "Extra High" },
              { id: "max", label: "Max" },
            ],
          },
          ...budgetOptions,
        ],
      },
    },
  ];
}
