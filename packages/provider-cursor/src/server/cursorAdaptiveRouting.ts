import {
  ADAPTIVE_SELECTION,
  type AdaptiveModelTier,
  type ModelSelection,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import {
  resolveAdaptiveTurn,
  type AdaptiveProviderCapabilities,
  type AdaptiveTurnHistory,
} from "@t3tools/provider-core/server/adaptiveRouting";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

/**
 * Cursor's effort option id varies per model (e.g. `effort` vs `reasoning_effort`), so each model
 * carries its own. `effort` is the provider-level fallback and the id the Auto model exposes.
 */
const defaultEffortOptionId = "effort";
const effortOptionPattern = /^(?:reasoning[_-]?)?effort$|^reasoning$/i;

// Cursor's own Auto (catalog slug `default`, T3 `auto`) picks its own model; never a candidate.
const excludedSlugs: ReadonlySet<string> = new Set(["default", "auto", ADAPTIVE_SELECTION]);

const economyVariant = /(?:^|[-.])(?:haiku|flash|mini|nano|lite|small|spark)(?:$|[-.])/i;
const expertVariant = /(?:^|[-.])(?:opus|max|ultra)(?:$|[-.])/i;

/** Version-agnostic: Cursor slugs encode a family keyword, never a tier. */
export function cursorAdaptiveTier(slug: string): AdaptiveModelTier {
  if (economyVariant.test(slug)) return "economy";
  if (expertVariant.test(slug)) return "expert";
  return "worker";
}

function effortDescriptor(model: ServerProviderModel) {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && effortOptionPattern.test(option.id),
  );
  return descriptor?.type === "select" ? descriptor : undefined;
}

function isRoutable(model: ServerProviderModel): boolean {
  return !model.isCustom && !excludedSlugs.has(model.slug);
}

export function cursorAdaptiveCapabilities(
  instanceId: ModelSelection["instanceId"],
  models: ReadonlyArray<ServerProviderModel>,
): AdaptiveProviderCapabilities {
  const defaultSlug = models.find((model) => model.isDefault)?.slug;
  const adaptiveModels = models.filter(isRoutable).map((model) => {
    const descriptor = effortDescriptor(model);
    return {
      id: model.slug,
      reportedId: model.slug,
      tier: cursorAdaptiveTier(model.slug),
      // A model with only boolean options (e.g. fastMode) has no effort and stays manual-only.
      efforts: descriptor?.options.map(({ id }) => id) ?? [],
      ...(descriptor === undefined ? {} : { effortOptionId: descriptor.id }),
    };
  });
  adaptiveModels.sort((a, b) => Number(b.id === defaultSlug) - Number(a.id === defaultSlug));
  return { instanceId, effortOptionId: defaultEffortOptionId, models: adaptiveModels };
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
 * Adds an Auto choice to each routable model's effort selector and an Auto model entry, without
 * changing any default. Models without an effort selector get no Auto effort.
 */
export function withCursorAdaptiveChoices(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  const routable = models.filter(isRoutable);
  if (routable.length === 0) return models;
  const anyEffort = routable.some((model) => effortDescriptor(model) !== undefined);
  return [
    ...models.map((model) =>
      !isRoutable(model) || effortDescriptor(model) === undefined
        ? model
        : {
            ...model,
            capabilities: {
              ...model.capabilities,
              optionDescriptors: (model.capabilities?.optionDescriptors ?? []).map((option) =>
                option.type === "select" && option.id === effortDescriptor(model)?.id
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
          ...(anyEffort
            ? [
                {
                  id: defaultEffortOptionId,
                  type: "select" as const,
                  role: "reasoning" as const,
                  label: "Effort",
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
              ]
            : []),
          ...budgetOptions,
        ],
      },
    },
  ];
}

/** Resolves an Auto selection to a concrete Cursor model and effort for one turn. */
export function resolveCursorAdaptiveSelection(input: {
  readonly selection: ModelSelection;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
  readonly text: string;
  readonly history?: AdaptiveTurnHistory | undefined;
  readonly nowMs: number;
}) {
  const tierOption = getModelSelectionStringOptionValue(input.selection, "autoMaxTier");
  const budget = Number(getModelSelectionStringOptionValue(input.selection, "autoTokenBudget"));
  return resolveAdaptiveTurn({
    selection: input.selection,
    capabilities: {
      ...cursorAdaptiveCapabilities(input.selection.instanceId, input.models),
      ...(input.usageLimits ? { usageLimits: input.usageLimits } : {}),
    },
    text: input.text,
    ...(input.history ? { history: input.history } : {}),
    maxTier: tierOption === "economy" || tierOption === "worker" ? tierOption : "expert",
    ...(Number.isSafeInteger(budget) && budget > 0 ? { tokenBudget: budget } : {}),
    nowMs: input.nowMs,
  });
}
