import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  compareVersions,
  formatVersion,
  latestPlainVersion,
  nextForkVersion,
  parseVersion,
} from "./forkVersion.mjs";

NodeTest.test("parses plain and fork versions, rejects everything else", () => {
  NodeAssert.deepEqual(parseVersion("v0.1.11"), { major: 0, minor: 1, patch: 11, fork: null });
  NodeAssert.deepEqual(parseVersion("0.1.12-fork.3"), { major: 0, minor: 1, patch: 12, fork: 3 });
  for (const bad of ["0.1", "0.1.11-nightly.20261124.1", "0.1.12-beta.1", "junk", "0.1.12-fork"]) {
    NodeAssert.equal(parseVersion(bad), null, bad);
  }
});

NodeTest.test("semver order keeps fork releases below the next upstream stable", () => {
  const ordered = ["0.1.11", "0.1.12-fork.1", "0.1.12-fork.2", "0.1.12", "0.1.13-fork.1"];
  for (let i = 1; i < ordered.length; i += 1) {
    const a = parseVersion(ordered[i - 1]);
    const b = parseVersion(ordered[i]);
    NodeAssert.equal(compareVersions(a, b), -1, `${ordered[i - 1]} < ${ordered[i]}`);
    NodeAssert.equal(compareVersions(b, a), 1);
  }
  NodeAssert.equal(compareVersions(parseVersion("0.1.12"), parseVersion("0.1.12")), 0);
});

NodeTest.test("latestPlainVersion ignores fork releases", () => {
  const latest = latestPlainVersion(["v0.1.11", "v0.1.12-fork.4", "v0.1.10"]);
  NodeAssert.equal(formatVersion(latest), "0.1.11");
  NodeAssert.equal(latestPlainVersion(["v0.1.12-fork.1"]), null);
});

NodeTest.test("nextForkVersion increments the fork counter above existing tags", () => {
  const base = parseVersion("0.1.11");
  NodeAssert.equal(nextForkVersion(base, ["v0.1.11"]), "0.1.12-fork.1");
  NodeAssert.equal(
    nextForkVersion(base, ["v0.1.11", "v0.1.12-fork.1", "v0.1.12-fork.2"]),
    "0.1.12-fork.3",
  );
  // Fork releases of other cores do not affect the counter.
  NodeAssert.equal(nextForkVersion(base, ["v0.1.11", "v0.1.13-fork.9"]), "0.1.12-fork.1");
});
