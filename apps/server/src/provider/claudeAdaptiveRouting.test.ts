import { ADAPTIVE_SELECTION, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeAdaptiveAgents,
  claudeAdaptiveCapabilities,
  claudeAdaptiveDiffTool,
  withClaudeAdaptiveChoices,
} from "./claudeAdaptiveRouting.ts";

const reported = (family: string, major: number): ModelInfo => ({
  value: family,
  resolvedModel: `claude-${family}-${major}-0`,
  displayName: family,
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high"],
});
const runtimeModels = [reported("haiku", 90), reported("sonnet", 90), reported("opus", 90)];

describe("Claude Auto capabilities", () => {
  it("uses native family aliases and runtime efforts for previously unknown versions", () => {
    const capabilities = claudeAdaptiveCapabilities(ProviderInstanceId.make("claude"), {
      models: [],
      runtimeModels,
    });
    expect(capabilities.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "economy", reportedId: "claude-haiku-90-0" }),
        expect.objectContaining({ tier: "worker", reportedId: "claude-sonnet-90-0" }),
        expect.objectContaining({ tier: "expert", reportedId: "claude-opus-90-0" }),
      ]),
    );
    const agents = claudeAdaptiveAgents(capabilities, claudeAdaptiveDiffTool, true);
    expect(agents.audit).toMatchObject({
      model: "claude-sonnet-90-0",
      effort: "medium",
      tools: ["Read", "Glob", "Grep", claudeAdaptiveDiffTool],
    });
    expect(agents.map?.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(agents.architect).toMatchObject({ model: "claude-opus-90-0", effort: "high" });
    expect(claudeAdaptiveAgents(capabilities, undefined, false)).not.toHaveProperty("audit");
  });

  it("offers each Auto independently without changing the original model default or effort", () => {
    const models = withClaudeAdaptiveChoices(
      [
        {
          slug: "claude-sonnet-90-0",
          name: "Sonnet",
          isCustom: false,
          isDefault: true,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                label: "Reasoning",
                options: [{ id: "high", label: "High", isDefault: true }],
              },
            ],
          },
        },
      ],
      runtimeModels,
    );
    expect(models[0]).toMatchObject({
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            options: [{ id: ADAPTIVE_SELECTION }, { id: "high", isDefault: true }],
          },
        ],
      },
    });
    expect(models[1]).toMatchObject({ slug: ADAPTIVE_SELECTION, supportsTextGeneration: false });
    expect(models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ id: "default", isDefault: true }),
        expect.objectContaining({ id: ADAPTIVE_SELECTION }),
        expect.objectContaining({ id: "high" }),
      ]),
    });
  });
});
