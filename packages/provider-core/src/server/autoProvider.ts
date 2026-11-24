import {
  ADAPTIVE_SELECTION,
  AUTO_PROVIDER_INSTANCE_ID,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

export const isAutoProviderSelection = (selection: ModelSelection): boolean =>
  selection.instanceId === AUTO_PROVIDER_INSTANCE_ID;

/** Remaining quota in percent across the tightest window; undefined when the provider reports none. */
export function usageHeadroom(
  limits: ServerProvider["usageLimits"],
  nowMs: number,
): number | undefined {
  if (limits === undefined || limits.unavailable !== undefined) return undefined;
  if (limits.zeroSpendCap === true) return 0;
  const used = limits.windows.map(({ usedPercent, resetsAt }) =>
    // A window that already reset has refilled even if the snapshot is stale.
    resetsAt !== undefined && Date.parse(resetsAt) <= nowMs ? 0 : usedPercent,
  );
  return used.length === 0 ? undefined : 100 - Math.max(...used);
}

export type AutoProviderChoice =
  | { readonly instanceId: ProviderInstanceId; readonly switched: boolean; readonly reason: string }
  | { readonly error: string };

/**
 * Picks the provider for an Auto-provider turn. Gate order matters: the allowlist is applied
 * before any quota or capability ranking, so a provider outside it can never win.
 * An empty allowlist means every enabled, installed, signed-in provider the user already set up.
 */
export function chooseAutoProvider(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly allowlist: ReadonlyArray<ProviderInstanceId>;
  readonly currentInstanceId?: ProviderInstanceId | undefined;
  readonly nowMs: number;
}): AutoProviderChoice {
  const { providers, allowlist, currentInstanceId, nowMs } = input;
  const skipped: string[] = [];
  const eligible: Array<{ provider: ServerProvider; headroom: number | undefined }> = [];
  for (const provider of providers) {
    const id = provider.instanceId;
    if (allowlist.length > 0 && !allowlist.includes(id)) continue;
    const why = !provider.enabled
      ? "disabled"
      : !provider.installed
        ? "not installed"
        : provider.auth.status !== "authenticated"
          ? "not signed in"
          : !provider.models.some(({ slug }) => slug === ADAPTIVE_SELECTION)
            ? "has no Auto routing"
            : undefined;
    const headroom = usageHeadroom(provider.usageLimits, nowMs);
    if (why === undefined && (headroom === undefined || headroom > 0)) {
      eligible.push({ provider, headroom });
    } else {
      skipped.push(`${provider.displayName ?? id} (${why ?? "usage limit reached"})`);
    }
  }
  const stay = eligible.find(({ provider }) => provider.instanceId === currentInstanceId);
  if (stay) {
    return { instanceId: stay.provider.instanceId, switched: false, reason: "Current provider" };
  }
  // Unknown headroom ranks below any provider that reports some room.
  const best = eligible.toSorted((a, b) => (b.headroom ?? 1) - (a.headroom ?? 1))[0];
  if (best) {
    return {
      instanceId: best.provider.instanceId,
      switched: currentInstanceId !== undefined,
      reason:
        best.headroom === undefined
          ? "Most available provider"
          : `${Math.round(best.headroom)}% usage headroom`,
    };
  }
  const missing = allowlist.filter((id) => !providers.some((p) => p.instanceId === id));
  return {
    error: `Auto provider found no allowed provider to use${
      skipped.length > 0 ? `: ${skipped.join(", ")}` : ""
    }${missing.length > 0 ? `. Not available: ${missing.join(", ")}` : ""}. ${
      allowlist.length > 0
        ? "Sign in to, enable, or add providers to the Auto provider allowlist in Settings"
        : "Enable and sign in to a provider, or choose one manually"
    }.`,
  };
}

export const autoProviderSelection = (instanceId: ProviderInstanceId): ModelSelection => ({
  instanceId,
  model: ADAPTIVE_SELECTION,
});
