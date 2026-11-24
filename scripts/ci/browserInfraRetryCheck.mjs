import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { isBrowserConnectionDrop } from "./browserInfraRetry.mjs";

const passed = "Test Files  574 passed (631)\nTests  6967 passed (6967)\nErrors  1 error\n";

NodeTest.test("retries only a browser socket drop after every test passed", () => {
  const log = `${passed}Serialized Error: { code: 'VITEST_BROWSER_CONNECTION_CLOSED' }`;
  NodeAssert.equal(isBrowserConnectionDrop(log, 1), true);
  NodeAssert.equal(isBrowserConnectionDrop(log, 0), false);
});

NodeTest.test("does not retry assertion failures or unrelated crashes", () => {
  NodeAssert.equal(
    isBrowserConnectionDrop(`${passed}Tests  1 failed\nVITEST_BROWSER_CONNECTION_CLOSED`, 1),
    false,
  );
  NodeAssert.equal(
    isBrowserConnectionDrop(
      `${passed} FAIL  src/example.test.ts\nVITEST_BROWSER_CONNECTION_CLOSED`,
      1,
    ),
    false,
  );
  NodeAssert.equal(isBrowserConnectionDrop(passed, 1), false);
});
