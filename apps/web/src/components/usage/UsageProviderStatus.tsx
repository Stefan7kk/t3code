import { remainingPercent, type LimitPresentations } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { T, useGT, useMessages } from "gt-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { collectProviderQuotaRows } from "./usageProviderStatus.logic";

/** Per-provider quota summary. A field the provider does not expose reads "unavailable", never "unlimited". */
export function UsageProviderStatus({
  presentations,
  now,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const gt = useGT();
  const m = useMessages();
  const rows = collectProviderQuotaRows(presentations);
  if (rows.length === 0) return null;
  const unavailable = gt("unavailable");
  const multiEnvironment = presentations.size > 1;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">
        <T>Provider quota status</T>
      </h2>
      <div
        className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        role="region"
        aria-label={gt("Provider quota status")}
        tabIndex={0}
      >
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pl-2 font-normal">
                <T>Provider</T>
              </th>
              <th className="py-2 pl-4 font-normal">
                <T context="subscription plan">Plan</T>
              </th>
              <th className="py-2 pl-4 text-right font-normal">
                <T>Remaining</T>
              </th>
              <th className="py-2 pl-4 text-right font-normal">
                <T>Used</T>
              </th>
              <th className="py-2 pl-4 font-normal">
                <T>Resets</T>
              </th>
              <th className="py-2 pl-4 font-normal">
                <T>Rate limit</T>
              </th>
              <th className="py-2 pl-4 font-normal">
                <T>Auth</T>
              </th>
              <th className="py-2 pr-2 pl-4 font-normal">
                <T>Last refresh</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rateLimit = {
                limited: gt("Limit reached"),
                near: gt("Near limit"),
                ok: gt("OK", { $context: "usage is within its limits" }),
                unavailable,
              }[row.rateLimit];
              const auth =
                row.auth === "authenticated"
                  ? row.health === "error" || row.health === "warning"
                    ? gt("Signed in, provider has issues")
                    : gt("Signed in")
                  : row.auth === "unauthenticated"
                    ? gt("Sign-in required")
                    : unavailable;
              const resetsAt = row.nextReset?.resetsAt;
              const resetsIn = row.nextReset ? formatResetsIn(row.nextReset, now, m, "in") : null;
              const checked = row.checkedAt ? formatRelativeTimeLabel(row.checkedAt, now, m) : "";
              return (
                <tr key={row.key} className="border-b border-border/50 text-muted-foreground">
                  <td className="py-2 pl-2 text-foreground">
                    {row.name}
                    {multiEnvironment ? ` · ${row.environmentLabel}` : ""}
                    {row.note ? (
                      <span className="block max-w-72 truncate text-xs text-muted-foreground">
                        {row.note}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pl-4">{row.tier ?? unavailable}</td>
                  <td className="py-2 pl-4 text-right tabular-nums">
                    {row.tightest ? `${remainingPercent(row.tightest)}%` : unavailable}
                  </td>
                  <td className="py-2 pl-4 text-right tabular-nums">
                    {row.tightest ? `${Math.round(row.tightest.usedPercent)}%` : unavailable}
                  </td>
                  <td className="py-2 pl-4 tabular-nums">
                    {resetsAt
                      ? `${formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m)}${resetsIn ? ` · ${resetsIn}` : ""}`
                      : unavailable}
                  </td>
                  <td
                    className={cn(
                      "py-2 pl-4",
                      row.rateLimit === "limited" && "text-destructive",
                      row.rateLimit === "near" && "text-warning-foreground",
                    )}
                  >
                    {rateLimit}
                  </td>
                  <td
                    className={cn(
                      "py-2 pl-4",
                      row.auth === "unauthenticated" && "text-destructive",
                    )}
                  >
                    {auth}
                  </td>
                  <td className="py-2 pr-2 pl-4 tabular-nums">
                    {checked
                      ? row.probeFailed
                        ? gt("{checked}, failed", { checked })
                        : checked
                      : unavailable}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
