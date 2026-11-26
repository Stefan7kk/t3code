import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { Atom } from "effect/reactivity";
import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { msg, T, useGT, useMessages } from "gt-react";

import { useQuietThreadProjection } from "../../state/entities";
import { environmentCatalog } from "../../connection/catalog";
import { environmentThreadShells } from "../../state/threads";
import { costPerMillionTokens } from "./usageBreakdown";

import {
  buildRoutingRows,
  estimateSavings,
  lastVisitedThreadRef,
  sumMeasuredTokens,
  type RoutingEvent,
} from "./routingHistory.logic";

const number = new Intl.NumberFormat();
const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const formatTokens = (value: number | undefined, unavailable: string) =>
  value === undefined ? unavailable : number.format(value);

function eventLabel(event: RoutingEvent | undefined, resolve: ReturnType<typeof useMessages>) {
  if (event === undefined) return "";
  if (event.kind === "retry-after-failure") {
    return resolve(msg("Retry after failure ({count})", { count: event.failureCount }));
  }
  return event.kind === "escalated"
    ? resolve(msg("Escalated {from} to {to}", { from: event.from, to: event.to }))
    : resolve(msg("De-escalated {from} to {to}", { from: event.from, to: event.to }));
}

const lastVisitedThreadRefAtom = Atom.make((get) =>
  lastVisitedThreadRef(
    [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].flatMap((environmentId) =>
      get(environmentThreadShells.environmentThreadsAtom(environmentId)).map((thread) => ({
        ref: { environmentId, threadId: thread.id },
        lastVisitedAt: thread.lastVisitedAt,
      })),
    ),
  ),
).pipe(Atom.withLabel("web-last-visited-thread-ref"));

/** Usage page section. The chat itself stays free of routing notices. */
export function LastThreadRoutingHistory({ models }: { readonly models: readonly ModelTotals[] }) {
  const projection = useQuietThreadProjection(useAtomValue(lastVisitedThreadRefAtom))?.projection;
  return projection ? (
    <RoutingHistoryPanel
      providerTurns={projection.providerTurns}
      providerThreads={projection.providerThreads}
      ratePerMillion={(model) => {
        const found = models.find((candidate) => candidate.model === model);
        return found === undefined ? undefined : (costPerMillionTokens(found) ?? undefined);
      }}
    />
  ) : null;
}

/**
 * Auto routing history. Token counts are MEASURED from the provider; dollar figures are ESTIMATES
 * and appear only where `priceFor` knows a model's price. "n/a" means the provider did not report it.
 */
function RoutingHistoryPanel({
  providerTurns,
  providerThreads,
  ratePerMillion,
}: {
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
  /** Effective USD per million tokens of a model from the user's own priced usage. */
  readonly ratePerMillion?: ((model: string) => number | undefined) | undefined;
}) {
  const resolve = useMessages();
  const gt = useGT();
  const unavailable = resolve(msg("n/a"));
  const requested = resolve(msg(" (requested)"));
  const rows = buildRoutingRows({
    providerTurns,
    providerThreads,
  });
  if (rows.length === 0) return null;
  const measured = sumMeasuredTokens(rows);
  const savings =
    ratePerMillion === undefined ? undefined : estimateSavings({ providerTurns, ratePerMillion });
  const headers = [
    resolve(msg("Turn")),
    resolve(msg("Provider / model")),
    resolve(msg("Effort")),
    resolve(msg("Reason")),
    resolve(msg("Input")),
    resolve(msg("Cached")),
    resolve(msg("Output")),
    resolve(msg("Est. cost")),
    resolve(msg("Event")),
  ];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">
        <T>Auto routing history (last opened thread)</T>
      </h2>
      <p className="text-xs text-muted-foreground">
        <T>Measured tokens</T>: {formatTokens(measured.inputTokens, unavailable)} <T>input</T> ·{" "}
        {formatTokens(measured.cachedInputTokens, unavailable)} <T>cached</T> ·{" "}
        {formatTokens(measured.outputTokens, unavailable)} <T>output</T> ({measured.turns}{" "}
        <T>turns</T>
        {measured.turnsWithoutUsage > 0
          ? resolve(msg(", {count} without usage", { count: measured.turnsWithoutUsage }))
          : ""}
        )
      </p>
      {savings === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          <T>Estimated API-equivalent cost</T>: {usd.format(savings.actualUsd)} <T>vs</T>{" "}
          {usd.format(savings.baselineUsd)} <T>on</T> {savings.baselineModel} (
          {usd.format(savings.savedUsd)} <T>saved</T>, {savings.pricedTurns}/{savings.totalTurns}{" "}
          <T>turns priced</T>).{" "}
          <T>Same tokens on the worker model, at your measured average price; not a bill.</T>
        </p>
      )}
      <div
        className="overflow-x-auto"
        role="region"
        aria-label={gt("Auto routing history")}
        tabIndex={0}
      >
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              {headers.map((header) => (
                <th key={header} className="py-2 pl-4 font-normal first:pl-2">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.turnId} className="border-b border-border/50">
                <td className="py-2 pl-2">{row.ordinal}</td>
                <td className="py-2 pl-4">
                  {row.provider} / {row.model}
                  {row.modelSource === "requested" ? requested : ""}
                </td>
                <td className="py-2 pl-4">
                  {row.effort === undefined
                    ? unavailable
                    : `${row.effort}${row.effortSource === "requested" ? requested : ""}`}
                </td>
                <td className="py-2 pl-4">{row.reason}</td>
                <td className="py-2 pl-4 text-right">
                  {formatTokens(row.inputTokens, unavailable)}
                </td>
                <td className="py-2 pl-4 text-right">
                  {formatTokens(row.cachedInputTokens, unavailable)}
                </td>
                <td className="py-2 pl-4 text-right">
                  {formatTokens(row.outputTokens, unavailable)}
                </td>
                <td className="py-2 pl-4 text-right">
                  {row.estimatedCostUsd === undefined
                    ? unavailable
                    : `~${usd.format(row.estimatedCostUsd)}`}
                </td>
                <td className="py-2 pl-4">{eventLabel(row.event, resolve)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
