import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";

export type QuotaRateLimit = "limited" | "near" | "ok" | "unavailable";

export interface ProviderQuotaRow {
  readonly key: string;
  readonly environmentLabel: string;
  readonly name: string;
  readonly driver: ServerProvider["driver"];
  /** The provider's own plan label; null when it reports none. */
  readonly tier: string | null;
  /** The most consumed window; null when the provider reports no window. */
  readonly tightest: ServerProviderUsageWindow | null;
  /** The window that resets first; null when no window reports a reset time. */
  readonly nextReset: ServerProviderUsageWindow | null;
  readonly rateLimit: QuotaRateLimit;
  readonly auth: ServerProvider["auth"]["status"];
  readonly health: ServerProvider["status"];
  /** `usageLimits.checkedAt`; null when the provider exposes no usage limits at all. */
  readonly checkedAt: string | null;
  readonly probeFailed: boolean;
  readonly note: string | null;
}

const NEAR_LIMIT_PERCENT = 90;

/** Every enabled, installed provider, with fields the provider does not expose left null. */
export function collectProviderQuotaRows(
  presentations: LimitPresentations,
): readonly ProviderQuotaRow[] {
  return [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.providers ?? [])
      .filter((provider) => provider.enabled && provider.installed)
      .map((provider): ProviderQuotaRow => {
        const limits = provider.usageLimits;
        const windows = limits?.windows ?? [];
        const tightest = windows.reduce<ServerProviderUsageWindow | null>(
          (best, window) =>
            best === null || window.usedPercent > best.usedPercent ? window : best,
          null,
        );
        const nextReset = windows.reduce<ServerProviderUsageWindow | null>(
          (best, window) =>
            window.resetsAt === undefined ||
            (best?.resetsAt !== undefined &&
              Date.parse(best.resetsAt) <= Date.parse(window.resetsAt))
              ? best
              : window,
          null,
        );
        const rateLimit: QuotaRateLimit =
          tightest === null
            ? limits?.zeroSpendCap
              ? "limited"
              : "unavailable"
            : tightest.usedPercent >= 100
              ? "limited"
              : tightest.usedPercent >= NEAR_LIMIT_PERCENT
                ? "near"
                : "ok";
        return {
          key: `${environmentId}:${provider.instanceId}`,
          environmentLabel: presentation.entry.target.label,
          name: provider.displayName?.trim() || String(provider.driver),
          driver: provider.driver,
          tier: provider.auth.label ?? null,
          tightest,
          nextReset,
          rateLimit,
          auth: provider.auth.status,
          health: provider.status,
          checkedAt: limits?.checkedAt ?? null,
          probeFailed: limits?.unavailable?.reason === "probeFailed",
          note: limits?.unavailable?.message ?? null,
        };
      }),
  );
}
