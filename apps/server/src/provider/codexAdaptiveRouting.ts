import {
  ADAPTIVE_SELECTION,
  type AdaptiveModelTier,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { codexModelFamily } from "@t3tools/shared/model";
import type { AdaptiveProviderCapabilities } from "../orchestration-v2/adaptiveRouting.ts";

/**
 * Codex slugs don't encode a tier like Claude's families, so assign one by version-agnostic
 * keyword: small/fast variants Economy, large reasoning variants Expert, standard models Worker.
 * Auto effort always uses the reasoning levels the runtime reports.
 */
const effortOptionId = "reasoningEffort";

const economyVariant = /(?:^|[-.])(?:mini|nano|spark|flash|lite|small|air)(?:$|[-.])/i;
const expertVariant = /(?:^|[-.])(?:max|ultra|opus|thinking)(?:$|[-.])/i;

export function codexAdaptiveTier(slug: string): AdaptiveModelTier {
  const family = codexModelFamily(slug);
  if (economyVariant.test(family)) return "economy";
  if (expertVariant.test(family)) return "expert";
  return "worker";
}

function reasoningEfforts(model: ServerProviderModel): ReadonlyArray<string> {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (option) => option.id === effortOptionId && option.type === "select",
  );
  return descriptor?.type === "select" ? descriptor.options.map(({ id }) => id) : [];
}

export function codexAdaptiveCapabilities(
  instanceId: ModelSelection["instanceId"],
  models: ReadonlyArray<ServerProviderModel>,
): AdaptiveProviderCapabilities {
  const adaptiveModels = models.flatMap((model) => {
    if (model.isCustom || model.slug === ADAPTIVE_SELECTION) return [];
    const efforts = reasoningEfforts(model);
    return [
      {
        id: model.slug,
        reportedId: model.slug,
        tier: codexAdaptiveTier(model.slug),
        efforts,
      },
    ];
  });
  // Prefer the provider's default model first within a tier, then keep discovery order stable.
  const defaultSlug = models.find((model) => model.isDefault)?.slug;
  adaptiveModels.sort((a, b) => {
    const aDefault = a.id === defaultSlug;
    const bDefault = b.id === defaultSlug;
    return Number(bDefault) - Number(aDefault);
  });
  return { instanceId, effortOptionId, models: adaptiveModels };
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
 * Adds an independent Auto choice to each Codex model's reasoning selector and an Auto model entry,
 * without changing any existing default. Only models that actually expose reasoning levels get the
 * Auto effort choice, so unsupported capabilities stay visibly manual.
 */
export function withCodexAdaptiveChoices(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const anyReasoning = models.some(
    (model) => !model.isCustom && reasoningEfforts(model).length > 0,
  );
  if (!anyReasoning) return models;
  return [
    ...models.map((model) =>
      model.isCustom || reasoningEfforts(model).length === 0
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
