import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import {
  isCommandMissingCause,
  providerProbeEnvironment,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * Token Plan quota is read through the Bailian CLI (`bl usage token-plan`), which owns its
 * credentials in the bl config profile; T3 stores no Bailian secret of its own. The command
 * reports console-gateway quota only, so probing it never spends inference tokens.
 */
export interface BailianTokenPlanQuotaOptions {
  readonly blPath: string;
  readonly configProfile: string;
  readonly consoleSite: "international" | "domestic";
  readonly consoleRegion: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cacheTtlMs?: number | undefined;
}

export interface BailianTokenPlanQuotaReading {
  readonly limits: ServerProviderUsageLimits;
  readonly tierLabel: string | undefined;
}

export type BailianQuotaAttempt =
  | {
      readonly _tag: "Output";
      readonly stdout: string;
      readonly stderr: string;
      readonly code: number;
    }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "Failed"; readonly message: string };

const BAILIAN_QUOTA_CACHE_TTL_MS = 5 * 60 * 1_000;
const COMMAND_TIMEOUT = "20 seconds";
const MAX_STDOUT_BYTES = 1_000_000;

// Mirrors the window fields emitted by `bl usage token-plan --output json`:
// per<N><Unit>Percentage is a 0-1 fraction and per<N><Unit>ResetTime epoch milliseconds.
const WINDOW_FIELD = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;
const UNIT_MINUTES: Record<string, number> = {
  Hour: 60,
  Day: 24 * 60,
  Week: 7 * 24 * 60,
  Month: 30 * 24 * 60,
};
const UNIT_KIND: Record<string, ServerProviderUsageWindow["kind"]> = {
  Hour: "other",
  Day: "other",
  Week: "weekly",
  Month: "monthly",
};
const UNIT_LABEL: Record<string, string> = {
  Hour: "Hourly",
  Day: "Daily",
  Week: "Weekly",
  Month: "Monthly",
};

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isoFromEpochMillis(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return DateTime.formatIso(DateTime.makeUnsafe(value));
}

function unavailable(checkedAt: string, message: string): ServerProviderUsageLimits {
  return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });
}

interface TokenPlanWindow {
  readonly key: string;
  readonly count: number;
  readonly unit: string;
  percentage?: number;
  resetTime?: number;
}

/** Missing quota data stays unreadable; it must never render as an unlimited allowance. */
export function parseBailianTokenPlanUsage(
  raw: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unavailable(checkedAt, "Bailian returned an unreadable Token Plan response.");
  }
  const record = raw as Record<string, unknown>;
  const windows = new Map<string, TokenPlanWindow>();
  for (const [field, value] of Object.entries(record)) {
    const match = WINDOW_FIELD.exec(field);
    if (!match || typeof value !== "number" || !Number.isFinite(value)) continue;
    const count = Number(match[1]);
    const unit = match[2]!;
    if (!Number.isInteger(count) || count <= 0) continue;
    const key = `per${count}${unit}`;
    const window = windows.get(key) ?? { key, count, unit };
    if (match[3] === "Percentage") {
      window.percentage = value;
    } else {
      window.resetTime = value;
    }
    windows.set(key, window);
  }
  const entries = [...windows.values()]
    .filter((window) => window.percentage !== undefined)
    .sort(
      (left, right) =>
        left.count * UNIT_MINUTES[left.unit]! - right.count * UNIT_MINUTES[right.unit]!,
    );
  if (record.hasQuotaData === false || entries.length === 0) {
    return unavailable(
      checkedAt,
      "Bailian reported no Token Plan quota data. Verify the subscription in the Bailian Token Plan console.",
    );
  }
  return makeUsageLimits({
    checkedAt,
    windows: entries.map((window) => ({
      id: `token_plan_${window.key}`,
      kind: UNIT_KIND[window.unit]!,
      label:
        window.count === 1
          ? `${UNIT_LABEL[window.unit]} quota`
          : `${window.count}-${window.unit.toLowerCase()} quota`,
      usedPercent: clampPercent(window.percentage! * 100),
      ...(window.resetTime !== undefined && isoFromEpochMillis(window.resetTime) !== undefined
        ? { resetsAt: isoFromEpochMillis(window.resetTime)! }
        : {}),
      windowDurationMins: window.count * UNIT_MINUTES[window.unit]!,
    })),
  });
}

export interface BailianHarnessQuotaReading {
  readonly tierLabel: string | undefined;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}

interface HarnessItem {
  readonly planCode: string;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly quotaUnit: string;
  readonly totalQuota: number | undefined;
  readonly availableQuota: number | undefined;
  readonly usedPercent: number | undefined;
  readonly instanceEndTime: number | undefined;
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function compactQuota(value: number): string {
  const scaled =
    value >= 1_000_000
      ? { amount: value / 1_000_000, suffix: "M" }
      : value >= 1_000
        ? { amount: value / 1_000, suffix: "K" }
        : { amount: value, suffix: "" };
  const rounded = Math.round(scaled.amount * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${scaled.suffix}`;
}

const scopeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/**
 * `bl token-plan harness-quota` lists per-harness entitlements with absolute quota and the
 * plan title; it is the only console-auth reading that names the subscription tier.
 */
export function parseBailianHarnessQuota(raw: unknown): BailianHarnessQuotaReading | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const items = (raw as { readonly items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  const issued: HarnessItem[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (item.status !== "issued") continue;
    issued.push({
      planCode: text(item.planCode),
      title: text(item.title),
      type: text(item.type),
      status: "issued",
      quotaUnit: text(item.quotaUnit),
      totalQuota: finiteNumber(item.totalQuota),
      availableQuota: finiteNumber(item.availableQuota),
      usedPercent: finiteNumber(item.usedPercent),
      instanceEndTime: finiteNumber(item.instanceEndTime),
    });
  }
  if (issued.length === 0) return undefined;
  const primary = issued.find((item) => item.type === "official_tool") ?? issued[0]!;
  const tierLabel = primary.title || primary.planCode || undefined;
  const windows = issued.flatMap((item, index): ServerProviderUsageWindow[] => {
    if (item.totalQuota === undefined || item.totalQuota <= 0 || item.usedPercent === undefined) {
      return [];
    }
    const name = item.title || item.planCode || `entitlement ${index + 1}`;
    const remaining =
      item.availableQuota !== undefined
        ? ` · ${compactQuota(Math.max(0, item.availableQuota))}${item.quotaUnit ? ` ${item.quotaUnit}` : ""} left`
        : "";
    const resetsAt =
      item.instanceEndTime !== undefined ? isoFromEpochMillis(item.instanceEndTime) : undefined;
    return [
      {
        id: `token_plan_harness_${index}_${scopeToken(item.planCode || name)}`,
        kind: "monthly",
        label: `${name}${item.planCode && item.title ? ` (${item.planCode})` : ""}${remaining}`,
        usedPercent: clampPercent(item.usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
  return { tierLabel, windows };
}

export function mergeBailianTokenPlanQuota(input: {
  readonly usage: ServerProviderUsageLimits;
  readonly harness: BailianHarnessQuotaReading | undefined;
}): BailianTokenPlanQuotaReading {
  const { usage, harness } = input;
  if (usage.unavailable || harness === undefined) {
    return { limits: usage, tierLabel: undefined };
  }
  return {
    limits: makeUsageLimits({
      checkedAt: usage.checkedAt,
      windows: [...usage.windows, ...harness.windows],
    }),
    tierLabel: harness.tierLabel,
  };
}

function consoleSignInHint(options: BailianTokenPlanQuotaOptions): string {
  const profile = options.configProfile.trim();
  const region = options.consoleRegion.trim();
  return [
    "Bailian console sign-in is required. Run:",
    `bl auth login --console --console-site ${options.consoleSite}`,
    ...(profile ? [`--config ${profile}`] : []),
    ...(region ? [`--console-region ${region}`] : []),
  ].join(" ");
}

function commandFailureMessage(
  attempt: Extract<BailianQuotaAttempt, { readonly _tag: "Output" }>,
  options: BailianTokenPlanQuotaOptions,
): string {
  const combined = `${attempt.stderr}\n${attempt.stdout}`;
  if (/console access token/i.test(combined)) return consoleSignInHint(options);
  for (const stream of [attempt.stdout, attempt.stderr]) {
    const parsed = tryParseJson(stream);
    if (typeof parsed !== "object" || parsed === null) continue;
    const error = (parsed as { readonly error?: unknown }).error;
    if (typeof error !== "object" || error === null) continue;
    const message = text((error as { readonly message?: unknown }).message);
    if (message) return message;
  }
  return `bl usage token-plan exited with code ${attempt.code}.`;
}

/** Pure mapping from CLI attempts to a reading, so failures never look like unlimited quota. */
export function bailianQuotaReadingFromAttempts(input: {
  readonly usage: BailianQuotaAttempt;
  readonly harness: BailianQuotaAttempt | undefined;
  readonly checkedAt: string;
  readonly options: BailianTokenPlanQuotaOptions;
}): BailianTokenPlanQuotaReading {
  const { usage, checkedAt, options } = input;
  const limits = ((): ServerProviderUsageLimits => {
    switch (usage._tag) {
      case "Missing":
        return unavailable(
          checkedAt,
          "Bailian CLI (bl) was not found on this environment. Install it with: npm install -g bailian-cli",
        );
      case "TimedOut":
        return unavailable(checkedAt, "Bailian CLI timed out reading Token Plan quota.");
      case "Failed":
        return unavailable(checkedAt, `Could not run the Bailian CLI: ${usage.message}`);
      case "Output": {
        if (usage.code !== 0) {
          return unavailable(checkedAt, commandFailureMessage(usage, options));
        }
        return parseBailianTokenPlanUsage(tryParseJson(usage.stdout), checkedAt);
      }
    }
  })();
  const harness =
    input.harness?._tag === "Output" && input.harness.code === 0
      ? parseBailianHarnessQuota(tryParseJson(input.harness.stdout))
      : undefined;
  return mergeBailianTokenPlanQuota({ usage: limits, harness });
}

export function bailianQuotaCommandArgs(
  options: BailianTokenPlanQuotaOptions,
  command: "usage" | "harness",
): ReadonlyArray<string> {
  const profile = options.configProfile.trim();
  const region = options.consoleRegion.trim();
  return [
    ...(command === "usage" ? ["usage", "token-plan"] : ["token-plan", "harness-quota"]),
    "--output",
    "json",
    ...(profile ? ["--config", profile] : []),
    "--console-site",
    options.consoleSite,
    ...(region ? ["--console-region", region] : []),
  ];
}

const runBailianCommand = Effect.fn("BailianTokenPlanQuota.runCommand")(function* (
  options: BailianTokenPlanQuotaOptions,
  args: ReadonlyArray<string>,
): Effect.fn.Return<BailianQuotaAttempt, never, ChildProcessSpawner.ChildProcessSpawner> {
  const command = options.blPath.trim() || "bl";
  const environment = providerProbeEnvironment(options.environment);
  const outcome = yield* Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
        // Quota reads are unattended; a CLI that waits on stdin must see EOF.
        stdin: "ignore",
      }),
      { maxStdoutBytes: MAX_STDOUT_BYTES },
    );
  }).pipe(Effect.timeoutOption(COMMAND_TIMEOUT), Effect.result);
  if (outcome._tag === "Failure") {
    return isCommandMissingCause(outcome.failure)
      ? { _tag: "Missing" }
      : {
          _tag: "Failed",
          message:
            outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure),
        };
  }
  if (Option.isNone(outcome.success)) return { _tag: "TimedOut" };
  const result = outcome.success.value;
  return { _tag: "Output", stdout: result.stdout, stderr: result.stderr, code: result.code };
});

export type BailianCommandRunner = (
  args: ReadonlyArray<string>,
) => Effect.Effect<BailianQuotaAttempt>;

export interface BailianTokenPlanQuotaProbe {
  /** Cached reading for periodic provider checks. */
  readonly check: Effect.Effect<BailianTokenPlanQuotaReading>;
  /** Bypasses the cache; used for recovery probes and explicit refreshes. */
  readonly checkFresh: Effect.Effect<BailianTokenPlanQuotaReading>;
  readonly invalidate: Effect.Effect<void>;
}

export const makeBailianTokenPlanQuotaProbe = Effect.fn("makeBailianTokenPlanQuotaProbe")(
  function* (
    options: BailianTokenPlanQuotaOptions,
    runCommand?: BailianCommandRunner,
  ): Effect.fn.Return<BailianTokenPlanQuotaProbe, never, ChildProcessSpawner.ChildProcessSpawner> {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run: BailianCommandRunner =
      runCommand ??
      ((args) =>
        runBailianCommand(options, args).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ));
    const ttl = options.cacheTtlMs ?? BAILIAN_QUOTA_CACHE_TTL_MS;
    const cache = yield* Ref.make<{
      readonly reading: BailianTokenPlanQuotaReading;
      readonly expiresAt: number;
    } | null>(null);
    const lock = yield* Semaphore.make(1);

    const readFresh = Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const usage = yield* run(bailianQuotaCommandArgs(options, "usage"));
      const partial = bailianQuotaReadingFromAttempts({
        usage,
        harness: undefined,
        checkedAt,
        options,
      });
      if (partial.limits.unavailable) return partial;
      // The harness reading only adds tier and entitlement rows; its failure keeps the quota bars.
      const harness = yield* run(bailianQuotaCommandArgs(options, "harness"));
      return bailianQuotaReadingFromAttempts({ usage, harness, checkedAt, options });
    });

    const store = (reading: BailianTokenPlanQuotaReading) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.set(cache, { reading, expiresAt: now + ttl })),
      );

    return {
      check: lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cached = yield* Ref.get(cache);
          if (cached !== null && cached.expiresAt > now) return cached.reading;
          const reading = yield* readFresh;
          yield* store(reading);
          return reading;
        }),
      ),
      checkFresh: lock.withPermits(1)(readFresh.pipe(Effect.tap(store))),
      invalidate: Ref.set(cache, null),
    };
  },
);
