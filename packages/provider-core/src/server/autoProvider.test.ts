import { ADAPTIVE_SELECTION, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { chooseAutoProvider, usageHeadroom } from "./autoProvider.ts";

const id = (value: string) => ProviderInstanceId.make(value);
const nowMs = Date.parse("2026-11-24T12:00:00.000Z");

const provider = (
  name: string,
  overrides: Partial<ServerProvider> & { usedPercent?: number } = {},
): ServerProvider => {
  const { usedPercent, ...rest } = overrides;
  return {
    instanceId: id(name),
    driver: name as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-24T11:59:00.000Z",
    models: [{ slug: ADAPTIVE_SELECTION, name: "Auto", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(usedPercent === undefined
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-11-24T11:59:00.000Z",
            windows: [{ id: "w", kind: "session" as const, label: "Session", usedPercent }],
          },
        }),
    ...rest,
  } as ServerProvider;
};

const choose = (
  providers: ReadonlyArray<ServerProvider>,
  allowlist: ReadonlyArray<string> = [],
  current?: string,
) =>
  chooseAutoProvider({
    providers,
    allowlist: allowlist.map(id),
    currentInstanceId: current === undefined ? undefined : id(current),
    nowMs,
  });

describe("Auto provider allowlist gate", () => {
  it("never picks a provider outside a non-empty allowlist, even with the most headroom", () => {
    const choice = choose(
      [provider("claude", { usedPercent: 90 }), provider("codex", { usedPercent: 0 })],
      ["claude"],
    );
    expect(choice).toMatchObject({ instanceId: "claude" });
  });

  it("fails with a clear message instead of using a non-allowlisted provider", () => {
    const choice = choose([provider("codex")], ["claude"]);
    expect(choice).toMatchObject({ error: expect.stringContaining("allowlist") });
    expect(choice).toMatchObject({ error: expect.stringContaining("Not available: claude") });
  });

  it("does not stay on a current provider that left the allowlist", () => {
    const choice = choose([provider("claude"), provider("codex")], ["codex"], "claude");
    expect(choice).toMatchObject({ instanceId: "codex", switched: true });
  });

  it("with an empty allowlist only uses enabled, installed, signed-in providers with Auto", () => {
    const choice = choose([
      provider("off", { enabled: false }),
      provider("missing", { installed: false }),
      provider("anon", { auth: { status: "unauthenticated" } }),
      provider("manual", {
        models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }],
      }),
    ]);
    expect(choice).toMatchObject({
      error: expect.stringMatching(
        /off \(disabled\).*missing \(not installed\).*anon \(not signed in\)/,
      ),
    });
  });
});

describe("Auto provider choice", () => {
  it("prefers the current provider to avoid a context handoff", () => {
    const choice = choose(
      [provider("claude", { usedPercent: 80 }), provider("codex", { usedPercent: 5 })],
      [],
      "claude",
    );
    expect(choice).toMatchObject({ instanceId: "claude", switched: false });
  });

  it("switches by headroom only when the current provider is exhausted", () => {
    const choice = choose(
      [
        provider("claude", { usedPercent: 100 }),
        provider("codex", { usedPercent: 60 }),
        provider("cursor", { usedPercent: 20 }),
      ],
      [],
      "claude",
    );
    expect(choice).toMatchObject({ instanceId: "cursor", switched: true });
  });

  it("is not a switch on a new thread", () => {
    expect(choose([provider("codex")])).toMatchObject({ instanceId: "codex", switched: false });
  });

  it("treats a window that already reset as refilled", () => {
    const limits = {
      checkedAt: "2026-11-24T10:00:00.000Z",
      windows: [
        {
          id: "w",
          kind: "session" as const,
          label: "Session",
          usedPercent: 100,
          resetsAt: "2026-11-24T11:00:00.000Z",
        },
      ],
    };
    expect(usageHeadroom(limits, nowMs)).toBe(100);
    expect(usageHeadroom({ ...limits, zeroSpendCap: true }, nowMs)).toBe(0);
    expect(usageHeadroom(undefined, nowMs)).toBeUndefined();
  });
});
