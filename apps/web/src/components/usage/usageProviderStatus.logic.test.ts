import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectProviderQuotaRows } from "./usageProviderStatus.logic";

const checkedAt = "2026-10-25T16:00:00.000Z";

function provider(
  id: string,
  patch: Partial<ServerProvider> & { usageLimits?: ServerProviderUsageLimits },
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: id,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

const window = (id: string, usedPercent: number, resetsAt?: string) => ({
  id,
  kind: "session" as const,
  label: id,
  usedPercent,
  ...(resetsAt ? { resetsAt } : {}),
});

function rowsFor(...providers: ServerProvider[]) {
  return collectProviderQuotaRows(
    new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers } },
      ],
    ]),
  );
}

describe("collectProviderQuotaRows", () => {
  it("summarises the tightest window, earliest reset, tier and refresh time", () => {
    const [row] = rowsFor(
      provider("claude", {
        auth: { status: "authenticated", label: "Max 5x" },
        usageLimits: {
          checkedAt,
          windows: [
            window("session", 40, "2026-10-25T20:00:00.000Z"),
            window("weekly", 92, "2026-10-28T00:00:00.000Z"),
          ],
        },
      }),
    );
    expect(row).toMatchObject({
      tier: "Max 5x",
      rateLimit: "near",
      checkedAt,
      auth: "authenticated",
      probeFailed: false,
    });
    expect(row?.tightest?.id).toBe("weekly");
    expect(row?.nextReset?.id).toBe("session");
  });

  it("reports a window at 100% as limited", () => {
    const [row] = rowsFor(
      provider("claude", { usageLimits: { checkedAt, windows: [window("session", 100)] } }),
    );
    expect(row?.rateLimit).toBe("limited");
    expect(row?.nextReset).toBeNull();
  });

  it("leaves every field null or unavailable for a provider without usage limits", () => {
    const [row] = rowsFor(
      provider("grok", { auth: { status: "unauthenticated" }, status: "error" }),
    );
    expect(row).toMatchObject({
      tier: null,
      tightest: null,
      nextReset: null,
      rateLimit: "unavailable",
      checkedAt: null,
      auth: "unauthenticated",
      health: "error",
    });
  });

  it("flags a failed probe and keeps the provider's message", () => {
    const [row] = rowsFor(
      provider("claude", {
        usageLimits: {
          checkedAt,
          windows: [],
          unavailable: { reason: "probeFailed", message: "Rate limited by API." },
        },
      }),
    );
    expect(row).toMatchObject({
      probeFailed: true,
      note: "Rate limited by API.",
      rateLimit: "unavailable",
    });
  });

  it("skips disabled and uninstalled providers", () => {
    expect(rowsFor(provider("a", { enabled: false }), provider("b", { installed: false }))).toEqual(
      [],
    );
  });
});
