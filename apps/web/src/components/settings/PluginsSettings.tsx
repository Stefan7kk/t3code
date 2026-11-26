import { AuthDiagnosticsReadScope, type ServerClaudeTool } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useState } from "react";
import { useGT, useMessages } from "gt-react";

import { m as resolveMessage } from "~/i18n/messages";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const KIND_ORDER = ["plugin", "mcp", "hook", "skill"] as const;

export function PluginsSettingsPanel() {
  const { environment } = useSettingsScope();
  return <PluginsSettingsBody key={environment?.environmentId ?? ""} />;
}

function PluginsSettingsBody() {
  const gt = useGT();
  const m = useMessages();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null || !canRead
      ? null
      : serverEnvironment.claudeTools({ environmentId, input: {} }),
    m,
  );
  const setEnabled = useAtomCommand(serverEnvironment.setClaudeToolEnabled, {
    reportFailure: false,
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = async (tool: ServerClaudeTool, enabled: boolean) => {
    if (environmentId === null || busyId !== null) return;
    setBusyId(tool.id);
    const result = await setEnabled({ environmentId, input: { id: tool.id, enabled } });
    setBusyId(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Could not change {name}", { name: tool.name }),
          description:
            failure instanceof Error
              ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
              : gt("The change was not applied."),
        });
      }
    } else {
      toastManager.add({
        type: "info",
        title: enabled
          ? gt("{name} enabled", { name: tool.name })
          : gt("{name} disabled", { name: tool.name }),
        description: gt("Applies to new Claude Code sessions. Restart open sessions."),
      });
    }
    refresh();
  };

  const kindTitle = (kind: ServerClaudeTool["kind"]) =>
    kind === "plugin"
      ? gt("Plugins")
      : kind === "mcp"
        ? gt("MCP servers")
        : kind === "hook"
          ? gt("Hooks")
          : gt("Skills");

  const tools = data?.tools ?? [];
  return (
    <SettingsPageContainer>
      {!canRead ? (
        <SettingsSection title={gt("Plugins")}>
          <SettingsRow
            title={gt("Not available")}
            description={gt("This environment does not allow reading tool settings.")}
          />
        </SettingsSection>
      ) : error ? (
        <SettingsSection title={gt("Plugins")}>
          <SettingsRow title={gt("Could not read your Claude config")} description={error} />
        </SettingsSection>
      ) : isPending && data === null ? (
        <SettingsSection title={gt("Plugins")}>
          <SettingsRow title={gt("Loading…")} />
        </SettingsSection>
      ) : tools.length === 0 ? (
        <SettingsSection title={gt("Plugins")}>
          <SettingsRow
            title={gt("Nothing installed")}
            description={gt(
              "No plugins, MCP servers, hooks or skills were found in your Claude config.",
            )}
          />
        </SettingsSection>
      ) : (
        KIND_ORDER.map((kind) => {
          const group = tools.filter((tool) => tool.kind === kind);
          if (group.length === 0) return null;
          return (
            <SettingsSection key={kind} title={kindTitle(kind)}>
              {group.map((tool) => (
                <SettingsRow
                  key={tool.id}
                  title={tool.name}
                  description={tool.detail}
                  control={
                    <Switch
                      checked={tool.enabled}
                      disabled={busyId !== null}
                      onCheckedChange={(checked) => void toggle(tool, checked)}
                      aria-label={gt("Enable {name}", { name: tool.name })}
                    />
                  }
                />
              ))}
            </SettingsSection>
          );
        })
      )}
    </SettingsPageContainer>
  );
}
