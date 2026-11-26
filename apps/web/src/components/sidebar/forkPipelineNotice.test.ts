import { describe, expect, it } from "vite-plus/test";

import { findPipelineFailure } from "./forkPipelineNotice";

describe("findPipelineFailure", () => {
  it("finds the newest failure issue and ignores other issues and pull requests", () => {
    expect(
      findPipelineFailure([
        { number: 9, title: "Fork release pipeline failed (release-current)", pull_request: {} },
        { number: 7, title: "Unrelated bug" },
        { number: 5, title: "Fork release pipeline failed (sync-upstream v0.1.14-fork.1)" },
        { number: 3, title: "Fork release pipeline failed (older)" },
      ]),
    ).toEqual({ number: 5, title: "Fork release pipeline failed (sync-upstream v0.1.14-fork.1)" });
  });

  it("returns nothing for no failure or a malformed response", () => {
    expect(findPipelineFailure([{ number: 1, title: "Question" }])).toBeUndefined();
    expect(findPipelineFailure({ message: "rate limited" })).toBeUndefined();
  });
});
