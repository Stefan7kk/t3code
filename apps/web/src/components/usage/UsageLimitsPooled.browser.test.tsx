import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled provider quota status", () => {
  it("shows exposed fields and marks absent ones unavailable, never unlimited", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              {
                ...managedChatGpt("claude", "Claude Max"),
                driver: ProviderDriverKind.make("claudeAgent"),
                auth: { status: "authenticated" as const, label: "Max 5x" },
                usageLimits: {
                  checkedAt,
                  windows: [
                    {
                      id: "session",
                      kind: "session" as const,
                      label: "Session",
                      usedPercent: 100,
                      resetsAt: "2026-10-25T18:00:00.000Z",
                    },
                  ],
                },
              },
              {
                ...managedChatGpt("grok", "Grok Build"),
                driver: ProviderDriverKind.make("grok"),
                auth: { status: "unauthenticated" as const },
                usageLimits: undefined,
              },
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    const claude = screen.getByRole("row", { name: /Claude Max/ });
    await expect.element(claude).toMatchTextContent("Max 5x");
    await expect.element(claude).toMatchTextContent("Limit reached");
    await expect.element(claude).toMatchTextContent("Signed in");
    const grok = screen.getByRole("row", { name: /Grok Build/ });
    await expect.element(grok).toMatchTextContent("Sign-in required");
    await expect.element(grok).toMatchTextContent("unavailable");
    await expect.element(screen.getByText(/unlimited/i)).not.toBeInTheDocument();
  });
});

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});
