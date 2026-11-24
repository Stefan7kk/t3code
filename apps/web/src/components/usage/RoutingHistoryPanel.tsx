import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import {
  buildRoutingRows,
  estimateSavings,
  sumMeasuredTokens,
  type RoutingEvent,
  type RoutingPrice,
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

/**
 * Auto routing history. Token counts are MEASURED from the provider; dollar figures are ESTIMATES
 * and appear only where `priceFor` knows a model's price. "n/a" means the provider did not report it.
 */
export function RoutingHistoryPanel({
  providerTurns,
  providerThreads,
  priceFor,
  baselineModel,
}: {
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
  readonly priceFor?: ((model: string) => RoutingPrice | undefined) | undefined;
  /** Model whose price the savings estimate compares against, e.g. the expert-tier model. */
  readonly baselineModel?: string | undefined;
}) {
  const resolve = useMessages();
  const gt = useGT();
  const unavailable = resolve(msg("n/a"));
  const requested = resolve(msg(" (requested)"));
  const rows = buildRoutingRows({
    providerTurns,
    providerThreads,
    ...(priceFor === undefined ? {} : { priceFor }),
  });
  if (rows.length === 0) return null;
  const measured = sumMeasuredTokens(rows);
  const savings =
    priceFor === undefined || baselineModel === undefined
      ? undefined
      : estimateSavings({ providerTurns, priceFor, baselinePrice: priceFor(baselineModel) });
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
        <T>Auto routing history</T>
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
          {usd.format(savings.baselineUsd)} <T>on</T> {baselineModel} (
          {usd.format(savings.savedUsd)} <T>saved</T>, {savings.pricedTurns}/{savings.totalTurns}{" "}
          <T>turns priced</T>). <T>Assumes the same tokens; not a bill.</T>
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
