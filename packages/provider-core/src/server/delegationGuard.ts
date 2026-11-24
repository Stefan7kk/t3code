export type DelegationRole = "read-only" | "modify";

export function checkDelegation(input: {
  readonly depth: number;
  readonly role: DelegationRole;
  readonly tool: "read" | "write";
  readonly fanout: number;
  readonly seenAgents: ReadonlyArray<string>;
  readonly agentId: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.depth > 2) return { ok: false, reason: "Delegation depth is above 2." };
  if (input.seenAgents.includes(input.agentId)) {
    return { ok: false, reason: "This agent is already on the delegation path." };
  }
  if (input.role === "read-only" && input.tool === "write") {
    return { ok: false, reason: "A read-only agent cannot use a write tool." };
  }
  if (input.fanout > 3) return { ok: false, reason: "Parallel fan-out is above 3." };
  return { ok: true };
}
