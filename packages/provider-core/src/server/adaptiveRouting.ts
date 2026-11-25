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
  /** The last Auto route on this provider thread; follow-ups inherit it. */
  readonly previousRoute?: AdaptiveRoute;
}

/** The economy model's verdict on a request the rules cannot place. */
export interface AdaptivePrecheck {
  readonly tier: AdaptiveModelTier;
  readonly effort: "low" | "medium" | "high";
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

export interface AdaptivePreviousRoute {
  readonly tier: AdaptiveModelTier;
  readonly effort: Effort;
  readonly reason?: string;
}

const CATCH_ALL_REASON = "Implementation or general work";
const ESCALATED_REASON = "Repeated failure on this task";
const FILE_REFERENCE =
  /[\w./\-]+\.(?:tsx?|jsx?|mjs|py|rs|go|java|cs|cpp|c|h|json|ya?ml|toml|md|css|html|sql|sh|ps1)\b/g;
const rank = (route: { readonly tier: AdaptiveModelTier; readonly effort: Effort }) =>
  tiers.indexOf(route.tier) * efforts.length + efforts.indexOf(route.effort);

function classifyByRules(
  task: string,
  failed: boolean,
  continuation: boolean,
): readonly [AdaptiveModelTier, Effort, string] {
  if (
    /\b(?:architect(?:ure|ural)?|threat model|security[- ]critical|authorization design|data migration strategy)\b/i.test(
      task,
    )
  ) {
    return ["expert", "high", "Architecture or security-critical decision"];
  }
  if (
    failed ||
    /\b(?:debug|race condition|deadlock|regression|intermittent|root cause|complex failure)\b/i.test(
      task,
    )
  ) {
    return ["worker", "high", "Debugging or a reported failure"];
  }
  if (
    /\b(?:design|algorithm|data structure|trade-?offs?|optimi[sz]e|concurren\w*|scalab\w*|performance)\b/i.test(
      task,
    )
  ) {
    return ["worker", "high", "Design or algorithmic work"];
  }
  if (/\b(?:audit|review)\b/i.test(task)) return ["worker", "medium", "Independent review"];
  if (/^(?:please\s+)?(?:map|explore|trace)\b/i.test(task)) {
    return ["economy", "low", "Repository exploration"];
  }
  if (
    /^(?:please\s+)?(?:find|locate|list|show|search|map|explore|where|what|which|who|read|summarize|explain)\b/i.test(
      task,
    ) &&
    !/\b(?:fix|change|add|implement|debug|migrate|refactor|design)\b/i.test(task)
  )
    return ["economy", "low", "Lookup"];
  if (/\b(?:typo|rename|formatting|simple fix|small fix|one-line)\b/i.test(task)) {
    return ["worker", "low", "Small implementation change"];
  }
  // Short chat with no code and no change request needs no worker model.
  if (
    !continuation &&
    task.split(/\s+/).length <= 12 &&
    !/[`{}<>]|\w\.\w{1,5}\b|\/\w/.test(task) &&
    !/\b(?:fix|change|add|implement|debug|migrate|refactor|write|build|create|update|remove|delete|test|run|install|deploy|edit)\b/i.test(
      task,
    )
  ) {
    return ["economy", "low", "Short or conversational request"];
  }
  return ["worker", "medium", CATCH_ALL_REASON];
}

export function classifyAdaptiveTask(
  text: string,
  priorFailures: number,
  previous?: AdaptivePreviousRoute,
  precheck?: AdaptivePrecheck,
) {
  const full = text.trim();
  const task = full.slice(0, 4_000);
  const resolved =
    /^(?:thanks[,! ]+)?(?:fixed|resolved|solved|it works|tests (?:now )?pass)\b/i.test(task);
  const failed =
    /\b(?:still (?:fail\w*|broken|doesn.t work|wrong)|same (?:error|failure)|failed again|didn.t (?:fix|work)|(?:is|it.s|that.s|this is) (?:wrong|incorrect)|not working)\b/i.test(
      task,
    );
  const continuation = /^(?:continue|keep going|try again|retry|same\b|still\b|that\b|it\b)/i.test(
    task,
  );
  // Harness-written turns (background results, resume notes) continue the running task.
  const notification =
    /^(?:Background (?:command|task)\b|Continue where you left off\b|Note: the T3 server restarted|Delegated task\b|\[User attached\b)/.test(
      task,
    );
  const large =
    !notification &&
    (full.length >= 1_500 ||
      new Set(full.match(FILE_REFERENCE)).size >= 5 ||
      (full
        .match(/```[\s\S]*?```/g)
        ?.join("\n")
        .split("\n").length ?? 0) >= 30);
  let [tier, effort, reason] = resolved
    ? (["economy", "low", "Task resolved"] as const)
    : classifyByRules(task, failed, continuation);
  // The rules decide every clear case; only a fresh request they cannot place is worth one
  // economy-model call, and never when the running task already holds a high route.
  const unclear =
    reason === CATCH_ALL_REASON &&
    !notification &&
    !continuation &&
    !large &&
    (previous === undefined || rank(previous) < rank({ tier: "worker", effort: "high" }));
  if (unclear && precheck !== undefined) {
    // The expert model stays a rule decision (architecture, security, a failure streak).
    [tier, effort, reason] = [
      precheck.tier === "expert" ? "worker" : precheck.tier,
      precheck.tier === "expert" ? "high" : precheck.effort,
      "Unclear request, judged by the economy model",
    ];
  }
  // Only a fresh standalone request is judged alone: short follow-ups, harness notices and
  // anything the rules have no opinion on stay on the running task's route.
  const followUp =
    previous !== undefined &&
    !resolved &&
    (notification ||
      continuation ||
      task.split(/\s+/).length <= 12 ||
      tier === "economy" ||
      unclear ||
      reason === CATCH_ALL_REASON);
  // A streak survives pings and notices; a new request of its own (catch-all or a rule) ends it.
  const failureCount = resolved
    ? 0
    : failed
      ? priorFailures + 1
      : continuation || notification || tier === "economy"
        ? priorFailures
        : 0;
  if (failureCount >= 2) {
    [tier, effort, reason] = ["expert", "high", ESCALATED_REASON];
  } else {
    if (followUp) {
      // An escalation ends with its failure streak; the follow-up drops back to the worker.
      const running = previous.reason?.startsWith(ESCALATED_REASON)
        ? ({ tier: "worker", effort: "high" } as const)
        : previous;
      if (rank(running) > rank({ tier, effort })) {
        [tier, effort, reason] = [running.tier, running.effort, "Follow-up on the running task"];
      }
    }
    if (large && rank({ tier, effort }) < rank({ tier: "worker", effort: "high" })) {
      [tier, effort, reason] = ["worker", "high", "Large or multi-file request"];
    }
    // Safety floor: a problem report never goes to the economy model.
    if (tier === "economy" && /\b(?:errors?|crash\w*|bugs?|why|broken|fail\w*)\b/i.test(task)) {
      [tier, effort, reason] = ["worker", "medium", "Problem report"];
    }
  }
  return { tier, effort, reason, failureCount, unclear };
}

function previousAdaptiveRoute(
  history: AdaptiveTurnHistory | undefined,
  capabilities: AdaptiveProviderCapabilities,
): AdaptivePreviousRoute | undefined {
  const route = history?.previousRoute;
  if (route === undefined) return undefined;
  const model = capabilities.models.find(
    (candidate) => (candidate.reportedId ?? candidate.id) === route.requestedModel,
  );
  return {
    tier: route.tier ?? "worker",
    effort:
      efforts.find((level) => (model?.effortByLevel?.[level] ?? level) === route.requestedEffort) ??
      "medium",
    reason: route.reason,
  };
}

/** True when the rules only reach the catch-all, so an economy-model pre-check can help. */
export function adaptiveTaskIsUnclear(input: {
  readonly text: string;
  readonly history?: AdaptiveTurnHistory;
  readonly capabilities: AdaptiveProviderCapabilities;
}): boolean {
  return classifyAdaptiveTask(
    input.text,
    input.history?.failureCount ?? 0,
    previousAdaptiveRoute(input.history, input.capabilities),
  ).unclear;
}

export function resolveAdaptiveTurn(input: {
  readonly selection: ModelSelection;
  readonly capabilities: AdaptiveProviderCapabilities;
  readonly text: string;
  readonly history?: AdaptiveTurnHistory;
  readonly precheck?: AdaptivePrecheck;
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
  const classified = classifyAdaptiveTask(
    input.text,
    input.history?.failureCount ?? 0,
    previousAdaptiveRoute(input.history, capabilities),
    input.precheck,
  );
  const modelAuto = selection.model === ADAPTIVE_SELECTION;
  // The tier cap is a spending ceiling: route to the best allowed tier rather than refusing.
  const requested =
    modelAuto &&
    input.maxTier !== undefined &&
    tiers.indexOf(classified.tier) > tiers.indexOf(input.maxTier)
      ? {
          ...classified,
          tier: input.maxTier,
          reason: `${classified.reason} (capped at ${input.maxTier})`,
        }
      : classified;
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
