import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import {
  bailianQuotaCommandArgs,
  bailianQuotaReadingFromAttempts,
  makeBailianTokenPlanQuotaProbe,
  mergeBailianTokenPlanQuota,
  parseBailianHarnessQuota,
  parseBailianTokenPlanUsage,
  type BailianQuotaAttempt,
  type BailianTokenPlanQuotaOptions,
} from "./bailianTokenPlanQuota.ts";

const checkedAt = "2026-11-24T10:00:00.000Z";
// 2026-01-01T00:00:00.000Z
const resetMs = 1_767_225_600_000;
const resetIso = "2026-01-01T00:00:00.000Z";

const options: BailianTokenPlanQuotaOptions = {
  blPath: "",
  configProfile: "token-plan",
  consoleSite: "international",
  consoleRegion: "ap-southeast-1",
  environment: {},
};

const output = (stdout: string, code = 0): BailianQuotaAttempt => ({
  _tag: "Output",
  stdout,
  stderr: "",
  code,
});

describe("parseBailianTokenPlanUsage", () => {
  it("maps percentage fractions and epoch-millis resets to windows", () => {
    const limits = parseBailianTokenPlanUsage(
      {
        per1MonthPercentage: 0.423,
        per1MonthResetTime: resetMs,
        per1HourPercentage: 0.1,
        per1HourResetTime: resetMs + 3_600_000,
        hasQuotaData: true,
      },
      checkedAt,
    );
    expect(limits.unavailable).toBeUndefined();
    expect(limits.checkedAt).toBe(checkedAt);
    expect(limits.windows).toEqual([
      {
        id: "token_plan_per1Month",
        kind: "monthly",
        label: "Monthly quota",
        usedPercent: 42.3,
        resetsAt: resetIso,
        windowDurationMins: 30 * 24 * 60,
      },
      {
        id: "token_plan_per1Hour",
        kind: "other",
        label: "Hourly quota",
        usedPercent: 10,
        resetsAt: "2026-01-01T01:00:00.000Z",
        windowDurationMins: 60,
      },
    ]);
  });

  it("keeps multi-count and weekly windows with their own ids", () => {
    const limits = parseBailianTokenPlanUsage(
      { per2WeekPercentage: 0.5, per1DayPercentage: 0.25, hasQuotaData: true },
      checkedAt,
    );
    // makeUsageLimits orders by window kind (weekly before other), then id.
    expect(limits.windows.map((window) => [window.id, window.kind, window.label])).toEqual([
      ["token_plan_per2Week", "weekly", "2-week quota"],
      ["token_plan_per1Day", "other", "Daily quota"],
    ]);
    expect(limits.windows[0]?.windowDurationMins).toBe(2 * 7 * 24 * 60);
    expect(limits.windows[1]?.resetsAt).toBeUndefined();
  });

  it("clamps out-of-range percentages", () => {
    const limits = parseBailianTokenPlanUsage(
      { per1MonthPercentage: 1.5, hasQuotaData: true },
      checkedAt,
    );
    expect(limits.windows[0]?.usedPercent).toBe(100);
  });

  it("treats missing quota data as unreadable, never unlimited", () => {
    const limits = parseBailianTokenPlanUsage({ hasQuotaData: false }, checkedAt);
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable).toMatchObject({ reason: "probeFailed" });
    expect(limits.unavailable?.message).toMatch(/no Token Plan quota data/i);
  });

  it("rejects payloads without usable windows", () => {
    for (const raw of [undefined, null, [], "text", {}, { hasQuotaData: true }]) {
      const limits = parseBailianTokenPlanUsage(raw, checkedAt);
      expect(limits.windows).toEqual([]);
      expect(limits.unavailable?.reason).toBe("probeFailed");
    }
  });

  it("ignores malformed fields but keeps valid ones", () => {
    const limits = parseBailianTokenPlanUsage(
      {
        per1MonthPercentage: "0.4",
        per0MonthPercentage: 0.4,
        per1MonthResetTime: -5,
        per1WeekPercentage: 0.2,
        hasQuotaData: true,
      },
      checkedAt,
    );
    expect(limits.windows.map((window) => window.id)).toEqual(["token_plan_per1Week"]);
    expect(limits.windows[0]?.resetsAt).toBeUndefined();
  });
});

describe("parseBailianHarnessQuota", () => {
  const harnessJson = {
    generatedAt: resetMs,
    items: [
      {
        planCode: "qwen_code_pro",
        title: "Qwen Code Pro",
        type: "official_tool",
        status: "issued",
        quotaUnit: "tokens",
        totalQuota: 2_000_000,
        availableQuota: 1_500_000,
        usedQuota: 500_000,
        usedPercent: 25,
        instanceStartTime: resetMs - 86_400_000,
        instanceEndTime: resetMs,
      },
      {
        planCode: "infra_pack",
        title: "Infrastructure pack",
        type: "infrastructure",
        status: "issuing",
      },
    ],
  };

  it("reads the tier from the official tool and skips issuing entitlements", () => {
    const reading = parseBailianHarnessQuota(harnessJson);
    expect(reading?.tierLabel).toBe("Qwen Code Pro");
    expect(reading?.windows).toEqual([
      {
        id: "token_plan_harness_0_qwen_code_pro",
        kind: "monthly",
        label: "Qwen Code Pro (qwen_code_pro) · 1.5M tokens left",
        usedPercent: 25,
        resetsAt: resetIso,
      },
    ]);
  });

  it("returns undefined without issued items", () => {
    expect(parseBailianHarnessQuota(undefined)).toBeUndefined();
    expect(parseBailianHarnessQuota({ items: [] })).toBeUndefined();
    expect(
      parseBailianHarnessQuota({ items: [{ status: "issuing", title: "x" }] }),
    ).toBeUndefined();
  });

  it("omits windows without a positive quota total", () => {
    const reading = parseBailianHarnessQuota({
      items: [{ status: "issued", title: "Starter", planCode: "starter", totalQuota: 0 }],
    });
    expect(reading?.tierLabel).toBe("Starter");
    expect(reading?.windows).toEqual([]);
  });
});

describe("mergeBailianTokenPlanQuota", () => {
  const usage = parseBailianTokenPlanUsage(
    { per1MonthPercentage: 0.4, hasQuotaData: true },
    checkedAt,
  );
  const harness = parseBailianHarnessQuota({
    items: [
      {
        status: "issued",
        title: "Pro",
        planCode: "pro",
        type: "official_tool",
        totalQuota: 100,
        usedPercent: 10,
      },
    ],
  });

  it("adds harness rows and the tier to a good reading", () => {
    const merged = mergeBailianTokenPlanQuota({ usage, harness });
    expect(merged.tierLabel).toBe("Pro");
    expect(merged.limits.windows.map((window) => window.id)).toEqual([
      "token_plan_harness_0_pro",
      "token_plan_per1Month",
    ]);
  });

  it("never enriches an unreadable reading", () => {
    const failed = parseBailianTokenPlanUsage({ hasQuotaData: false }, checkedAt);
    const merged = mergeBailianTokenPlanQuota({ usage: failed, harness });
    expect(merged.limits).toBe(failed);
    expect(merged.tierLabel).toBeUndefined();
  });
});

describe("bailianQuotaReadingFromAttempts", () => {
  const read = (usage: BailianQuotaAttempt, harness?: BailianQuotaAttempt) =>
    bailianQuotaReadingFromAttempts({ usage, harness, checkedAt, options });

  it("reports a missing CLI with install guidance", () => {
    const reading = read({ _tag: "Missing" });
    expect(reading.limits.unavailable?.message).toMatch(/npm install -g bailian-cli/);
  });

  it("reports timeouts and spawn failures as probe failures", () => {
    expect(read({ _tag: "TimedOut" }).limits.unavailable?.message).toMatch(/timed out/i);
    expect(read({ _tag: "Failed", message: "boom" }).limits.unavailable?.message).toMatch(/boom/);
  });

  it("turns a missing console token into the sign-in command", () => {
    const reading = read(
      output(
        JSON.stringify({
          error: { code: 3, message: "No console access token found." },
        }),
        3,
      ),
    );
    expect(reading.limits.unavailable?.message).toBe(
      "Bailian console sign-in is required. Run: bl auth login --console --console-site international --config token-plan --console-region ap-southeast-1",
    );
  });

  it("surfaces other CLI errors without treating them as quota", () => {
    const reading = read(output(JSON.stringify({ error: { message: "Gateway unavailable." } }), 1));
    expect(reading.limits.unavailable?.message).toBe("Gateway unavailable.");
    expect(reading.limits.windows).toEqual([]);
  });

  it("merges a successful harness reading and survives its failure", () => {
    const usage = output(
      JSON.stringify({
        per1MonthPercentage: 0.42,
        per1MonthResetTime: resetMs,
        hasQuotaData: true,
      }),
    );
    const harness = output(
      JSON.stringify({
        items: [
          {
            status: "issued",
            title: "Qwen Code Pro",
            planCode: "pro",
            type: "official_tool",
            totalQuota: 100,
            usedPercent: 42,
          },
        ],
      }),
    );
    const merged = read(usage, harness);
    expect(merged.tierLabel).toBe("Qwen Code Pro");
    expect(merged.limits.windows).toHaveLength(2);
    const withoutHarness = read(usage, { _tag: "TimedOut" });
    expect(withoutHarness.tierLabel).toBeUndefined();
    expect(withoutHarness.limits.windows).toHaveLength(1);
  });

  it("keeps unreadable stdout unreadable", () => {
    const reading = read(output("not json"));
    expect(reading.limits.unavailable?.reason).toBe("probeFailed");
  });
});

describe("bailianQuotaCommandArgs", () => {
  it("targets the Singapore console profile by default", () => {
    expect(bailianQuotaCommandArgs(options, "usage")).toEqual([
      "usage",
      "token-plan",
      "--output",
      "json",
      "--config",
      "token-plan",
      "--console-site",
      "international",
      "--console-region",
      "ap-southeast-1",
    ]);
    expect(bailianQuotaCommandArgs(options, "harness").slice(0, 2)).toEqual([
      "token-plan",
      "harness-quota",
    ]);
  });

  it("omits empty profile and region", () => {
    const args = bailianQuotaCommandArgs(
      { ...options, configProfile: " ", consoleRegion: "" },
      "usage",
    );
    expect(args).not.toContain("--config");
    expect(args).not.toContain("--console-region");
  });
});

describe("makeBailianTokenPlanQuotaProbe", () => {
  const usageJson = JSON.stringify({
    per1MonthPercentage: 0.42,
    per1MonthResetTime: resetMs,
    hasQuotaData: true,
  });

  // The injected runner replaces command execution, so the spawner is never used.
  const withUnusedSpawner = Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.ChildProcessSpawner.of({
      spawn: () => Effect.die("unused spawner"),
      exitCode: () => Effect.die("unused spawner"),
      streamString: () => Stream.die("unused spawner"),
      streamLines: () => Stream.die("unused spawner"),
      lines: () => Effect.die("unused spawner"),
      string: () => Effect.die("unused spawner"),
    }),
  );

  const countingRunner = Effect.fn("test.countingRunner")(function* () {
    const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const runner = (args: ReadonlyArray<string>) =>
      Ref.update(calls, (current) => [...current, args]).pipe(
        Effect.as(args[0] === "usage" ? output(usageJson) : output(JSON.stringify({ items: [] }))),
      );
    return { calls, runner };
  });

  it.effect("caches readings until invalidated", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* countingRunner();
      const probe = yield* makeBailianTokenPlanQuotaProbe(options, runner);
      const first = yield* probe.check;
      const second = yield* probe.check;
      expect(second).toBe(first);
      expect(first.limits.windows[0]?.usedPercent).toBe(42);
      // One usage read plus one best-effort harness read.
      expect(yield* Ref.get(calls)).toHaveLength(2);
      yield* probe.invalidate;
      yield* probe.check;
      expect(yield* Ref.get(calls)).toHaveLength(4);
    }).pipe(withUnusedSpawner),
  );

  it.effect("checkFresh bypasses the cache", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* countingRunner();
      const probe = yield* makeBailianTokenPlanQuotaProbe(options, runner);
      yield* probe.check;
      yield* probe.checkFresh;
      expect(yield* Ref.get(calls)).toHaveLength(4);
    }).pipe(withUnusedSpawner),
  );

  it.effect("expires cached readings after the TTL", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* countingRunner();
      const probe = yield* makeBailianTokenPlanQuotaProbe(
        { ...options, cacheTtlMs: 1_000 },
        runner,
      );
      yield* probe.check;
      yield* TestClock.adjust(Duration.millis(1_001));
      yield* probe.check;
      expect(yield* Ref.get(calls)).toHaveLength(4);
    }).pipe(withUnusedSpawner),
  );

  it.effect("does not call the harness command when quota is unreadable", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const runner = (args: ReadonlyArray<string>) =>
        Ref.update(calls, (current) => [...current, args]).pipe(
          Effect.as(output(JSON.stringify({ hasQuotaData: false }))),
        );
      const probe = yield* makeBailianTokenPlanQuotaProbe(options, runner);
      const reading = yield* probe.check;
      expect(reading.limits.unavailable?.reason).toBe("probeFailed");
      expect(yield* Ref.get(calls)).toHaveLength(1);
    }).pipe(withUnusedSpawner),
  );
});
