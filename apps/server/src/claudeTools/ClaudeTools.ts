// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerClaudeTool } from "@t3tools/contracts";

/**
 * Lists and toggles Claude Code extras from `~/.claude`. Disabling moves an entry to our own stash, never deletes it.
 * shortcut: Claude Code rewrites `~/.claude.json` too, so a racing toggle can lose a write; add a lock if seen.
 */

type Json = Record<string, unknown>;

interface Stash {
  mcp: Record<string, unknown>;
  hooks: Partial<Record<string, Array<{ event: string; group: unknown }>>>;
}

const RTK_ID = "hook:rtk";

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function paths(home: string) {
  const claudeDir = NodePath.join(home, ".claude");
  return {
    claudeDir,
    settings: NodePath.join(claudeDir, "settings.json"),
    claudeJson: NodePath.join(home, ".claude.json"),
    stash: NodePath.join(claudeDir, "t3-disabled-tools.json"),
    skills: NodePath.join(claudeDir, "skills"),
    skillsDisabled: NodePath.join(claudeDir, "skills-disabled"),
  };
}

function readJson(file: string): Json {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (text.trim() === "") return {};
  // A parse error must stop the toggle: never overwrite a file we could not read.
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

const hasOwn = (object: object, key: string): boolean => Object.hasOwn(object, key);

function writeJson(file: string, value: Json): void {
  // Keep the first backup only: a rolling copy would soon hold our own earlier edit.
  const backup = `${file}.t3-backup`;
  let mode = 0o600;
  if (NodeFS.existsSync(file)) {
    if (!NodeFS.existsSync(backup)) NodeFS.copyFileSync(file, backup);
    mode = NodeFS.statSync(file).mode & 0o777;
  }
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const tmp = `${file}.t3-tmp`;
  NodeFS.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  NodeFS.renameSync(tmp, file);
}

function readStash(file: string, read: (file: string) => Json = readJson): Stash {
  const raw = read(file);
  return {
    mcp: isRecord(raw.mcp) ? raw.mcp : {},
    hooks: isRecord(raw.hooks) ? (raw.hooks as Stash["hooks"]) : {},
  };
}

const isRtkCommand = (command: unknown): boolean =>
  typeof command === "string" &&
  /^"?(?:[^"\s]*[\\/])?rtk(?:\.exe)?"?\s+hook\b/i.test(command.trim());

const isRtkHook = (hook: unknown): boolean => isRecord(hook) && isRtkCommand(hook.command);

const groupHasRtk = (group: unknown): group is Json & { hooks: unknown[] } =>
  isRecord(group) && Array.isArray(group.hooks) && group.hooks.some(isRtkHook);

function activeRtkHookCount(settings: Json): number {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  return Object.values(hooks).reduce<number>(
    (count, groups) => count + (Array.isArray(groups) ? groups.filter(groupHasRtk).length : 0),
    0,
  );
}

function listDirectories(dir: string): string[] {
  try {
    return NodeFS.readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && NodeFS.existsSync(NodePath.join(dir, entry.name, "SKILL.md")),
      )
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

export function listClaudeTools(home: string = NodeOS.homedir()): ServerClaudeTool[] {
  const p = paths(home);
  // One unreadable file must not blank the whole list.
  const safeRead = (file: string): Json => {
    try {
      return readJson(file);
    } catch {
      return {};
    }
  };
  const settings = safeRead(p.settings);
  const stash = readStash(p.stash, safeRead);
  const tools: ServerClaudeTool[] = [];

  const plugins = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  for (const [key, value] of Object.entries(plugins)) {
    tools.push({
      id: `plugin:${key}`,
      name: key.split("@")[0] ?? key,
      kind: "plugin",
      enabled: value === true,
      detail: key,
    });
  }

  const claudeJson = safeRead(p.claudeJson);
  const liveMcp = isRecord(claudeJson.mcpServers) ? claudeJson.mcpServers : {};
  for (const name of Object.keys(liveMcp)) {
    tools.push({ id: `mcp:${name}`, name, kind: "mcp", enabled: true, detail: "MCP server" });
  }
  for (const name of Object.keys(stash.mcp)) {
    if (!hasOwn(liveMcp, name))
      tools.push({ id: `mcp:${name}`, name, kind: "mcp", enabled: false, detail: "MCP server" });
  }

  if (activeRtkHookCount(settings) > 0) {
    tools.push({
      id: RTK_ID,
      name: "RTK",
      kind: "hook",
      enabled: true,
      detail: "Shortens shell command output",
    });
  } else if ((stash.hooks[RTK_ID] ?? []).length > 0) {
    tools.push({
      id: RTK_ID,
      name: "RTK",
      kind: "hook",
      enabled: false,
      detail: "Shortens shell command output",
    });
  }

  for (const name of listDirectories(p.skills)) {
    tools.push({ id: `skill:${name}`, name, kind: "skill", enabled: true, detail: "Skill" });
  }
  for (const name of listDirectories(p.skillsDisabled)) {
    tools.push({ id: `skill:${name}`, name, kind: "skill", enabled: false, detail: "Skill" });
  }

  return tools;
}

export function setClaudeToolEnabled(
  id: string,
  enabled: boolean,
  home: string = NodeOS.homedir(),
): ServerClaudeTool[] {
  const p = paths(home);
  const separator = id.indexOf(":");
  const kind = id.slice(0, separator);
  const key = id.slice(separator + 1);
  if (separator < 1 || key === "") throw new Error(`Unknown tool id: ${id}`);

  if (kind === "plugin") {
    const settings = readJson(p.settings);
    const plugins = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
    if (!hasOwn(plugins, key)) throw new Error(`Plugin not found: ${key}`);
    writeJson(p.settings, { ...settings, enabledPlugins: { ...plugins, [key]: enabled } });
  } else if (kind === "mcp") {
    const config = readJson(p.claudeJson);
    const live = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
    const stash = readStash(p.stash);
    if (enabled) {
      if (hasOwn(live, key)) return listClaudeTools(home);
      if (!hasOwn(stash.mcp, key)) throw new Error(`MCP server not found: ${key}`);
      live[key] = stash.mcp[key];
      delete stash.mcp[key];
      // Write the stash last-but-one: a crash between the two files leaves the server enabled, never lost.
      writeJson(p.claudeJson, { ...config, mcpServers: live });
      writeJson(p.stash, stash as unknown as Json);
    } else {
      if (!hasOwn(live, key)) return listClaudeTools(home);
      // Stash first so the config is never removed before a copy exists.
      stash.mcp[key] = live[key];
      writeJson(p.stash, stash as unknown as Json);
      delete live[key];
      writeJson(p.claudeJson, { ...config, mcpServers: live });
    }
  } else if (kind === "hook" && id === RTK_ID) {
    setRtkHookEnabled(p, enabled);
  } else if (kind === "skill") {
    if (/[\\/]|^\.\.?$/.test(key)) throw new Error(`Invalid skill name: ${key}`);
    const from = NodePath.join(enabled ? p.skillsDisabled : p.skills, key);
    const to = NodePath.join(enabled ? p.skills : p.skillsDisabled, key);
    if (NodeFS.existsSync(from) && !NodeFS.existsSync(NodePath.join(from, "SKILL.md"))) {
      throw new Error(`Not a skill: ${key}`);
    }
    if (!NodeFS.existsSync(from)) {
      if (NodeFS.existsSync(to)) return listClaudeTools(home);
      throw new Error(`Skill not found: ${key}`);
    }
    if (NodeFS.existsSync(to)) throw new Error(`Skill already exists at ${to}`);
    NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
    NodeFS.renameSync(from, to);
  } else {
    throw new Error(`Unknown tool id: ${id}`);
  }
  return listClaudeTools(home);
}

function setRtkHookEnabled(p: ReturnType<typeof paths>, enabled: boolean): void {
  const settings = readJson(p.settings);
  const stash = readStash(p.stash);
  const hooks: Json = isRecord(settings.hooks) ? { ...settings.hooks } : {};

  if (!enabled) {
    const removed: Array<{ event: string; group: unknown }> = [];
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept: unknown[] = [];
      for (const group of groups) {
        if (!groupHasRtk(group)) {
          kept.push(group);
          continue;
        }
        // Only RTK's own entries leave; the user's other hooks in the same group stay put.
        removed.push({ event, group: { ...group, hooks: group.hooks.filter(isRtkHook) } });
        const rest = group.hooks.filter((hook) => !isRtkHook(hook));
        if (rest.length > 0) kept.push({ ...group, hooks: rest });
      }
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
    if (removed.length === 0) return;
    // Replace, never append: a retry after a failed settings write must not stash twice.
    stash.hooks[RTK_ID] = removed;
    writeJson(p.stash, stash as unknown as Json);
    const { hooks: _removed, ...rest } = settings;
    writeJson(p.settings, Object.keys(hooks).length === 0 ? rest : { ...rest, hooks });
    return;
  }

  const saved = stash.hooks[RTK_ID] ?? [];
  if (saved.length === 0) return;
  for (const { event, group } of saved) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    const current: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const present = new Set(
      current.flatMap((entry) =>
        isRecord(entry) && Array.isArray(entry.hooks)
          ? entry.hooks.map((hook) => (isRecord(hook) ? hook.command : undefined))
          : [],
      ),
    );
    const toAdd = group.hooks.filter((hook) => !(isRecord(hook) && present.has(hook.command)));
    if (toAdd.length === 0) continue;
    const index = current.findIndex((entry) => isRecord(entry) && entry.matcher === group.matcher);
    const target = current[index];
    if (index >= 0 && isRecord(target) && Array.isArray(target.hooks)) {
      current[index] = { ...target, hooks: [...target.hooks, ...toAdd] };
    } else {
      current.push({ ...group, hooks: toAdd });
    }
    hooks[event] = current;
  }
  writeJson(p.settings, { ...settings, hooks });
  delete stash.hooks[RTK_ID];
  writeJson(p.stash, stash as unknown as Json);
}
