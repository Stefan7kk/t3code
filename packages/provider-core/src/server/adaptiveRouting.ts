import {
  ADAPTIVE_SELECTION,
  type AdaptiveModelTier,
  type AdaptiveRoute,
  type ModelSelection,
  type ServerProviderUsageLimits,
  type TurnTokenUsage,
} from "@t3tools/contracts";

const tiers = ["economy", "worker", "expert"] as const;
const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof efforts)[number];

export interface AdaptiveProviderCapabilities {
  readonly instanceId: ModelSelection["instanceId"];
  readonly effortOptionId: string;
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly tier?: AdaptiveModelTier;
    readonly efforts: ReadonlyArray<string>;
    readonly effortByLevel?: Readonly<Partial<Record<Effort, string>>>;
    readonly reportedId?: string;
    /** Overrides the provider effort option id for this model (e.g. Cursor's mixed ids). */
    readonly effortOptionId?: string;
  }>;
  readonly fixedEffort?: string;
  readonly usageLimits?: ServerProviderUsageLimits;
}

export interface AdaptiveTurnHistory {
  readonly failureCount: number;
  readonly tokens: number;
}

export function usesAdaptiveSelection(selection: ModelSelection): boolean {
  return (
    selection.model === ADAPTIVE_SELECTION ||
    (selection.options?.some(({ value }) => value === ADAPTIVE_SELECTION) ?? false)
  );
}

export function adaptiveUsageTokens(usage: TurnTokenUsage | undefined): number {
  return (
    (usage?.inputTokens ?? 0) +
    (usage?.outputTokens ?? 0) +
    (usage?.otherUsage?.inputTokens ?? 0) +
    (usage?.otherUsage?.outputTokens ?? 0)
  );
}

export function classifyAdaptiveTask(text: string, priorFailures: number) {
  const task = text.trim().slice(0, 4_000);
  const resolved =
    /^(?:thanks[,! ]+)?(?:fixed|resolved|solved|it works|tests (?:now )?pass)\b/i.test(task);
  const failed =
    /\b(?:still (?:fail\w*|broken|doesn.t work)|same (?:error|failure)|failed again|didn.t (?:fix|work))\b/i.test(
      task,
    );
  const continuation = /^(?:continue|keep going|try again|retry|same\b|still\b|that\b|it\b)/i.test(
    task,
  );
  const failureCount = resolved ? 0 : failed ? priorFailures + 1 : continuation ? priorFailures : 0;
  const route = (tier: AdaptiveModelTier, effort: Effort, reason: string) => ({
    tier,
    effort,
    reason,
    failureCount,
  });
  if (resolved) return route("economy", "low", "Task resolved");
  if (failureCount >= 2) return route("expert", "high", "Repeated failure on this task");
  if (
    /\b(?:architect(?:ure|ural)?|threat model|security[- ]critical|authorization design|data migration strategy)\b/i.test(
      task,
    )
  ) {
    return route("expert", "high", "Architecture or security-critical decision");
  }
  if (
    failed ||
    /\b(?:debug|race condition|deadlock|regression|intermittent|root cause|complex failure)\b/i.test(
      task,
    )
  ) {
    return route("worker", "high", "Debugging or a reported failure");
  }
  if (/\b(?:audit|review)\b/i.test(task)) return route("worker", "medium", "Independent review");
  if (/^(?:please\s+)?(?:map|explore|trace)\b/i.test(task)) {
    return route("economy", "low", "Repository exploration");
  }
  if (
    /^(?:please\s+)?(?:find|locate|list|show|search|map|explore|where|what|which|who|read|summarize|explain)\b/i.test(
      task,
    ) &&
    !/\b(?:fix|change|add|implement|debug|migrate|refactor|design)\b/i.test(task)
  )
    return route("economy", "low", "Lookup");
  if (/\b(?:typo|rename|formatting|simple fix|small fix|one-line)\b/i.test(task)) {
    return route("worker", "low", "Small implementation change");
  }
  return route("worker", "medium", "Implementation or general work");
}

export function resolveAdaptiveTurn(input: {
  readonly selection: ModelSelection;
  readonly capabilities: AdaptiveProviderCapabilities;
  readonly text: string;
  readonly history?: AdaptiveTurnHistory;
  readonly maxTier?: AdaptiveModelTier;
  readonly tokenBudget?: number;
  readonly nowMs: number;
}): { selection: ModelSelection; route: AdaptiveRoute } | { error: string } {
  const { selection, capabilities } = input;
  if (capabilities.instanceId !== selection.instanceId)
    return { error: "Auto cannot change providers." };
  if (input.tokenBudget !== undefined && (input.history?.tokens ?? 0) >= input.tokenBudget) {
    return {
      error:
        "This thread reached its Auto token budget. Increase the budget or use a manual selection.",
    };
  }
  const requested = classifyAdaptiveTask(input.text, input.history?.failureCount ?? 0);
  const modelAuto = selection.model === ADAPTIVE_SELECTION;
  const effortOptionIds = Array.from(
    new Set([
      capabilities.effortOptionId,
      ...capabilities.models
        .map((model) => model.effortOptionId)
        .filter((id): id is string => id !== undefined),
    ]),
  );
  const requestedEffort = selection.options?.find(({ id }) => effortOptionIds.includes(id))?.value;
  const effortAuto = requestedEffort === ADAPTIVE_SELECTION;
  if (effortAuto && capabilities.fixedEffort !== undefined) {
    return {
      error: "The provider environment fixes the effort level. Choose a manual effort to continue.",
    };
  }
  const currentWindows =
    capabilities.usageLimits?.windows.filter(
      (window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > input.nowMs,
    ) ?? [];
  const hasIncludedUsage = currentWindows.some(
    (window) => !window.modelIds && (window.kind === "session" || window.kind === "weekly"),
  );
  const windows = currentWindows.filter(
    (window) => !hasIncludedUsage || window.id !== "monthly_spend",
  );
  if (
    (!hasIncludedUsage && capabilities.usageLimits?.zeroSpendCap) ||
    windows.some((window) => !window.modelIds && window.usedPercent >= 100)
  ) {
    return { error: "The provider reports an exhausted usage or spend limit." };
  }
  if (
    modelAuto &&
    input.maxTier !== undefined &&
    tiers.indexOf(requested.tier) > tiers.indexOf(input.maxTier)
  ) {
    return { error: `This task needs the ${requested.tier} tier, above the Auto tier limit.` };
  }
  const matching = modelAuto
    ? capabilities.models.filter((model) => model.tier === requested.tier)
    : capabilities.models.filter((model) => model.id === selection.model);
  const model = matching.find(
    (candidate) =>
      (!effortAuto || candidate.efforts.length > 0) &&
      (typeof requestedEffort !== "string" ||
        effortAuto ||
        requestedEffort === "default" ||
        candidate.efforts.includes(requestedEffort)) &&
      !windows.some(
        (window) =>
          window.usedPercent >= 100 &&
          (window.modelIds?.includes(candidate.id) ||
            window.modelIds?.includes(candidate.reportedId ?? "")),
      ),
  );
  if (model === undefined) {
    return {
      error: modelAuto
        ? `No available ${requested.tier} model can honor this selection. Choose a model or effort manually.`
        : "Auto effort is unavailable for this model under the provider's current limits.",
    };
  }
  const preferredEffort =
    effortAuto &&
    requested.effort === "medium" &&
    windows.some(
      (window) =>
        window.usedPercent >= 90 &&
        (!window.modelIds ||
          window.modelIds.includes(model.id) ||
          window.modelIds.includes(model.reportedId ?? "")),
    )
      ? "low"
      : requested.effort;
  const wireEffort = (effort: Effort) => model.effortByLevel?.[effort] ?? effort;
  const supported = efforts.filter((effort) => model.efforts.includes(wireEffort(effort)));
  const autoEffort = supported.findLast(
    (level) => efforts.indexOf(level) <= efforts.indexOf(preferredEffort),
  );
  const effort = effortAuto
    ? autoEffort === undefined
      ? undefined
      : wireEffort(autoEffort)
    : typeof requestedEffort === "string" && requestedEffort !== "default"
      ? requestedEffort
      : undefined;
  if (effortAuto && effort === undefined)
    return { error: "No supported effort fits this Auto route. Choose an effort manually." };
  const modelEffortOptionId = model.effortOptionId ?? capabilities.effortOptionId;
  const options = selection.options?.filter(({ id }) => !effortOptionIds.includes(id)) ?? [];
  if (effort !== undefined) options.push({ id: modelEffortOptionId, value: effort });
  return {
    selection: { ...selection, model: model.id, options },
    route: {
      ...(model.tier === undefined ? {} : { tier: model.tier }),
      reason:
        preferredEffort !== requested.effort
          ? `${requested.reason}. Effort reduced near a subscription limit`
          : requested.reason,
      requestedModel: model.reportedId ?? model.id,
      ...(effort === undefined
        ? {}
        : { requestedEffort: effort, effortOptionId: modelEffortOptionId }),
      failureCount: requested.failureCount,
    },
  };
}
