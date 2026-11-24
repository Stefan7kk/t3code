import { describe, expect, it } from "@effect/vitest";

import { recordAdaptiveStats } from "./adaptiveStats.ts";
import { checkDelegation } from "./delegationGuard.ts";

describe("adaptive stats", () => {
  it("accumulates one category without inventing missing counters", () => {
    const once = recordAdaptiveStats([], {
      category: "lookup",
      success: true,
      latencyMs: 10,
      tokens: 4,
    });
    const twice = recordAdaptiveStats(once, {
      category: "lookup",
      success: false,
      latencyMs: -1,
      tokens: 6,
    });
    expect(twice).toEqual([
      { category: "lookup", attempts: 2, successes: 1, failures: 1, latencyMs: 10, tokens: 10 },
    ]);
  });
});

describe("delegation guard", () => {
  const base = {
    depth: 1,
    role: "modify" as const,
    tool: "write" as const,
    fanout: 1,
    seenAgents: ["scout"],
    agentId: "worker",
  };

  it("allows a bounded modifying delegation", () => {
    expect(checkDelegation(base)).toEqual({ ok: true });
  });

  it("blocks depth, recursion, read-only writes, and wide fan-out", () => {
    expect(checkDelegation({ ...base, depth: 3 }).ok).toBe(false);
    expect(checkDelegation({ ...base, agentId: "scout" }).ok).toBe(false);
    expect(checkDelegation({ ...base, role: "read-only" }).ok).toBe(false);
    expect(checkDelegation({ ...base, fanout: 4 }).ok).toBe(false);
  });
});
