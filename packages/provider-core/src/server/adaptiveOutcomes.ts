import type { AdaptiveModelTier } from "@t3tools/contracts";

/** One finished Auto turn, in thread order. Only objective runtime facts; never user wording. */
export interface AdaptiveOutcomeTurn {
  readonly tier: AdaptiveModelTier;
  readonly effort: string | undefined;
  /** The failure streak after the turn (failing tests, loops, repeated tool errors). */
  readonly failureCount: number;
  readonly completed: boolean;
  readonly outputTokens: number | undefined;
}

const RANK: Record<AdaptiveModelTier, number> = { economy: 0, worker: 1, expert: 2 };
// An answer this short from a high-effort turn means the effort was not needed.
const SHORT_OUTPUT_TOKENS = 400;

/**
 * "Too low": a turn hit failures and a stronger tier then finished cleanly.
 * "Too high": a high-effort turn that no failure led to finished short with none of its own.
 * Complaints in the user's words are never a signal, and neither are unfinished turns.
 */
export function classifyAdaptiveOutcomes(turns: ReadonlyArray<AdaptiveOutcomeTurn>): {
  readonly tooLow: ReadonlyArray<number>;
  readonly tooHigh: ReadonlyArray<number>;
} {
  const tooLow: number[] = [];
  const tooHigh: number[] = [];
  turns.forEach((turn, index) => {
    if (!turn.completed) return;
    const before = turns[index - 1]?.failureCount ?? 0;
    if (turn.failureCount > before) {
      const solved = turns
        .slice(index + 1)
        .find((later) => later.completed && RANK[later.tier] > RANK[turn.tier]);
      if (solved !== undefined && solved.failureCount === 0) tooLow.push(index);
    } else if (
      turn.effort === "high" &&
      RANK[turn.tier] >= RANK.worker &&
      before === 0 &&
      turn.failureCount === 0 &&
      turn.outputTokens !== undefined &&
      turn.outputTokens <= SHORT_OUTPUT_TOKENS
    ) {
      tooHigh.push(index);
    }
  });
  return { tooLow, tooHigh };
}
