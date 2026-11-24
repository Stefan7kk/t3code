import * as NodeChildProcess from "node:child_process";

import { isBrowserConnectionDrop } from "./browserInfraRetry.mjs";

const attempts = 3;

function runOnce() {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("vp", ["run", "test"], {
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
    });
    let log = "";
    const capture = (chunk) => {
      const text = chunk.toString();
      log += text;
      process.stdout.write(text);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("close", (code) => resolve({ code: code ?? 1, log }));
  });
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const { code, log } = await runOnce();
  if (code === 0) process.exit(0);
  if (attempt < attempts && isBrowserConnectionDrop(log, code)) {
    console.error(
      `Retrying regression tests after a confirmed Chromium connection drop (${attempt}/${attempts}).`,
    );
    continue;
  }
  process.exit(code);
}
