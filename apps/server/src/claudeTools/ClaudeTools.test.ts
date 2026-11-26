// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { listClaudeTools, setClaudeToolEnabled } from "./ClaudeTools.ts";

const RTK_GROUP = { matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] };
const OTHER_GROUP = { matcher: "Edit", hooks: [{ type: "command", command: "node other.js" }] };

function makeHome() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-tools-"));
  const claude = NodePath.join(home, ".claude");
  NodeFS.mkdirSync(NodePath.join(claude, "skills", "caveman"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(claude, "skills", "caveman", "SKILL.md"), "x");
  NodeFS.writeFileSync(
    NodePath.join(claude, "settings.json"),
    JSON.stringify({
      theme: "auto",
      enabledPlugins: { "ponytail@ponytail": true },
      hooks: { PreToolUse: [OTHER_GROUP, RTK_GROUP] },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(home, ".claude.json"),
    JSON.stringify({
      projects: { a: 1 },
      mcpServers: { context7: { command: "cmd", args: ["/c", "npx"] } },
    }),
  );
  return home;
}

const read = (home: string, ...parts: string[]) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(home, ...parts), "utf8"));
const state = (home: string, id: string) =>
  listClaudeTools(home).find((tool) => tool.id === id)?.enabled;

describe("ClaudeTools", () => {
  it("lists plugins, MCP servers, the RTK hook and skills as enabled", () => {
    const home = makeHome();
    expect(listClaudeTools(home).map((tool) => [tool.id, tool.enabled])).toEqual([
      ["plugin:ponytail@ponytail", true],
      ["mcp:context7", true],
      ["hook:rtk", true],
      ["skill:caveman", true],
    ]);
  });

  it("toggles a plugin flag without touching other settings", () => {
    const home = makeHome();
    setClaudeToolEnabled("plugin:ponytail@ponytail", false, home);
    expect(state(home, "plugin:ponytail@ponytail")).toBe(false);
    expect(read(home, ".claude", "settings.json").theme).toBe("auto");
    setClaudeToolEnabled("plugin:ponytail@ponytail", true, home);
    expect(state(home, "plugin:ponytail@ponytail")).toBe(true);
  });

  it("moves an MCP server to the stash and back, keeping its config and the other keys", () => {
    const home = makeHome();
    setClaudeToolEnabled("mcp:context7", false, home);
    expect(read(home, ".claude.json").mcpServers).toEqual({});
    expect(read(home, ".claude.json").projects).toEqual({ a: 1 });
    expect(state(home, "mcp:context7")).toBe(false);
    setClaudeToolEnabled("mcp:context7", true, home);
    expect(read(home, ".claude.json").mcpServers.context7.args).toEqual(["/c", "npx"]);
    expect(state(home, "mcp:context7")).toBe(true);
  });

  it("removes only the RTK hook group and restores it", () => {
    const home = makeHome();
    setClaudeToolEnabled("hook:rtk", false, home);
    expect(read(home, ".claude", "settings.json").hooks.PreToolUse).toEqual([OTHER_GROUP]);
    expect(state(home, "hook:rtk")).toBe(false);
    setClaudeToolEnabled("hook:rtk", true, home);
    expect(read(home, ".claude", "settings.json").hooks.PreToolUse).toEqual([
      OTHER_GROUP,
      RTK_GROUP,
    ]);
  });

  it("moves a skill folder out and back", () => {
    const home = makeHome();
    setClaudeToolEnabled("skill:caveman", false, home);
    expect(NodeFS.existsSync(NodePath.join(home, ".claude", "skills", "caveman"))).toBe(false);
    expect(state(home, "skill:caveman")).toBe(false);
    setClaudeToolEnabled("skill:caveman", true, home);
    expect(state(home, "skill:caveman")).toBe(true);
  });

  it("keeps a backup and refuses to overwrite an unreadable file", () => {
    const home = makeHome();
    setClaudeToolEnabled("plugin:ponytail@ponytail", false, home);
    expect(NodeFS.existsSync(NodePath.join(home, ".claude", "settings.json.t3-backup"))).toBe(true);
    NodeFS.writeFileSync(NodePath.join(home, ".claude", "settings.json"), "{ not json");
    expect(() => setClaudeToolEnabled("plugin:ponytail@ponytail", true, home)).toThrow();
    expect(NodeFS.readFileSync(NodePath.join(home, ".claude", "settings.json"), "utf8")).toBe(
      "{ not json",
    );
  });

  it("rejects unknown ids and path-like skill names", () => {
    const home = makeHome();
    expect(() => setClaudeToolEnabled("nope", true, home)).toThrow();
    expect(() => setClaudeToolEnabled("skill:../x", false, home)).toThrow();
    expect(() => setClaudeToolEnabled("mcp:missing", true, home)).toThrow();
  });
});

describe("ClaudeTools hardening", () => {
  it("keeps the other hooks that share a group with RTK", () => {
    const home = makeHome();
    const shared = {
      matcher: "Bash",
      hooks: [
        { type: "command", command: "rtk hook claude" },
        { type: "command", command: "my-audit.sh" },
      ],
    };
    NodeFS.writeFileSync(
      NodePath.join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [shared] } }),
    );
    setClaudeToolEnabled("hook:rtk", false, home);
    expect(read(home, ".claude", "settings.json").hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "my-audit.sh" }] },
    ]);
    setClaudeToolEnabled("hook:rtk", true, home);
    // RTK returns after the user's own hook, in the same group.
    expect(read(home, ".claude", "settings.json").hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [shared.hooks[1], shared.hooks[0]] },
    ]);
  });

  it("never duplicates RTK on a repeated disable or enable", () => {
    const home = makeHome();
    setClaudeToolEnabled("hook:rtk", false, home);
    setClaudeToolEnabled("hook:rtk", false, home);
    setClaudeToolEnabled("hook:rtk", true, home);
    setClaudeToolEnabled("hook:rtk", true, home);
    const groups = read(home, ".claude", "settings.json").hooks.PreToolUse as unknown[];
    expect(JSON.stringify(groups).split("rtk hook claude").length - 1).toBe(1);
  });

  it("ignores inherited property names and non-skill folders", () => {
    const home = makeHome();
    expect(() => setClaudeToolEnabled("plugin:toString", false, home)).toThrow();
    expect(() => setClaudeToolEnabled("mcp:constructor", true, home)).toThrow();
    NodeFS.mkdirSync(NodePath.join(home, ".claude", "skills", "plain"), { recursive: true });
    expect(() => setClaudeToolEnabled("skill:plain", false, home)).toThrow();
  });

  it("still lists the other tools when one config file is unreadable", () => {
    const home = makeHome();
    NodeFS.writeFileSync(NodePath.join(home, ".claude.json"), "{ broken");
    expect(listClaudeTools(home).some((tool) => tool.id === "skill:caveman")).toBe(true);
  });

  it("keeps the first backup instead of rolling it", () => {
    const home = makeHome();
    setClaudeToolEnabled("plugin:ponytail@ponytail", false, home);
    setClaudeToolEnabled("plugin:ponytail@ponytail", true, home);
    const backup = read(home, ".claude", "settings.json.t3-backup");
    expect(backup.enabledPlugins["ponytail@ponytail"]).toBe(true);
    expect(backup.theme).toBe("auto");
  });
});
