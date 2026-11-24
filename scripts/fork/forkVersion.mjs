#!/usr/bin/env node
// Fork versions: plain X.Y.Z for upstream syncs, X.Y.(Z+1)-fork.N for custom releases, published
// as full GitHub releases. Semver keeps every fork release below the next official stable, so
// the native stable feed (newest non-prerelease release, semver-greater) offers both correctly.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-fork\.(\d+))?$/;

export function parseVersion(tag) {
  const match = VERSION.exec(String(tag).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    fork: match[4] === undefined ? null : Number(match[4]),
  };
}

export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A plain release outranks any fork prerelease of the same core version.
  if (a.fork === null && b.fork === null) return 0;
  if (a.fork === null) return 1;
  if (b.fork === null) return -1;
  return a.fork === b.fork ? 0 : a.fork < b.fork ? -1 : 1;
}

export function latestPlainVersion(tags) {
  let latest = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (!version || version.fork !== null) continue;
    if (latest === null || compareVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

export function formatVersion(version) {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.fork === null ? core : `${core}-fork.${version.fork}`;
}

/** Next custom release version above every existing tag, targeting the next upstream patch. */
export function nextForkVersion(base, tags) {
  const core = { major: base.major, minor: base.minor, patch: base.patch + 1, fork: null };
  let maxFork = 0;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (!version || version.fork === null) continue;
    if (
      version.major === core.major &&
      version.minor === core.minor &&
      version.patch === core.patch &&
      version.fork > maxFork
    ) {
      maxFork = version.fork;
    }
  }
  return formatVersion({ ...core, fork: maxFork + 1 });
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "next") {
    console.error("usage: forkVersion.mjs next --base <version> --tags <tag,tag,...>");
    process.exit(2);
  }
  let base = null;
  let tags = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--base") base = parseVersion(rest[i + 1] ?? "");
    else if (rest[i] === "--tags") tags = (rest[i + 1] ?? "").split(",").filter(Boolean);
    else {
      console.error(`unknown argument: ${rest[i]}`);
      process.exit(2);
    }
  }
  if (!base) {
    console.error("--base must be a plain fork release version (the current upstream base)");
    process.exit(2);
  }
  console.log(nextForkVersion(base, tags));
}

const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("/forkVersion.mjs");
if (import.meta.main || invokedDirectly) {
  main();
}
