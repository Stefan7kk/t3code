import { msg } from "gt-react";

import { APP_VERSION } from "~/branding";
import { m } from "~/i18n/messages";
import { stackedThreadToast, toastManager } from "../ui/toast";

// shortcut: the fork's repository is fixed here; make it configurable if the fork moves.
const ISSUES_URL =
  "https://api.github.com/repos/Stefan7kk/t3code/issues?state=open&per_page=10&sort=created&direction=desc";
const FAILURE_TITLE = "Fork release pipeline failed";
const SEEN_KEY = "t3code:fork-pipeline-notice";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** The newest open issue the fork's release workflow opened when a scheduled run failed. */
export function findPipelineFailure(
  issues: unknown,
): { readonly number: number; readonly title: string } | undefined {
  if (!Array.isArray(issues)) return undefined;
  for (const issue of issues) {
    if (
      typeof issue === "object" &&
      issue !== null &&
      !("pull_request" in issue) &&
      "number" in issue &&
      typeof issue.number === "number" &&
      "title" in issue &&
      typeof issue.title === "string" &&
      issue.title.startsWith(FAILURE_TITLE)
    ) {
      return { number: issue.number, title: issue.title };
    }
  }
  return undefined;
}

function alreadyShown(number: number): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === String(number);
  } catch {
    return false;
  }
}

/** Tells the user, once per failure, that the fork's scheduled merge or release did not publish. */
export function startForkPipelineNotice(): () => void {
  // Only fork builds know this repository; upstream builds never make the request.
  if (!APP_VERSION.includes("-fork.")) return () => {};
  const check = async () => {
    try {
      const response = await fetch(ISSUES_URL, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (!response.ok) return;
      const failure = findPipelineFailure(await response.json());
      if (failure === undefined || alreadyShown(failure.number)) return;
      try {
        localStorage.setItem(SEEN_KEY, String(failure.number));
      } catch {
        // Without storage the notice repeats on the next check; that is acceptable.
      }
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: m(msg("Fork update did not publish")),
          description: m(
            msg("{title} (issue #{number}). You stay on {version} until it is fixed.", {
              title: failure.title,
              number: failure.number,
              version: APP_VERSION,
            }),
          ),
        }),
      );
    } catch {
      // Offline or rate-limited: say nothing, check again later.
    }
  };
  void check();
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  return () => clearInterval(timer);
}
