import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { snapshotStateDatabase } from "./UpdateStateBackup.ts";

it.layer(NodeServices.layer)("snapshotStateDatabase", (it) => {
  it.effect("copies database, settings and secrets, and prunes to the newest three", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-update-backup-" });
      yield* fileSystem.writeFileString(path.join(dir, "statev2.sqlite"), "db");
      yield* fileSystem.writeFileString(path.join(dir, "statev2.sqlite-wal"), "wal");
      yield* fileSystem.writeFileString(path.join(dir, "settings.json"), "{}");
      yield* fileSystem.makeDirectory(path.join(dir, "secrets", "files"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(dir, "secrets", "provider-auth-x.bin"), "cred");
      yield* fileSystem.writeFileString(path.join(dir, "secrets", "files", "nested.bin"), "nested");
      for (const stamp of [
        "2026-01-01T00-00-00-000Z",
        "2026-01-02T00-00-00-000Z",
        "2026-01-03T00-00-00-000Z",
      ]) {
        yield* fileSystem.makeDirectory(path.join(dir, "backups", `pre-${stamp}-0.1.10`), {
          recursive: true,
        });
      }

      yield* snapshotStateDatabase({ stateDir: dir, targetVersion: "0.1.12-fork.1" });

      const entries = (yield* fileSystem.readDirectory(path.join(dir, "backups"))).sort();
      expect(entries).toHaveLength(3);
      expect(entries[2]).toContain("0.1.12-fork.1");
      expect(entries.some((entry) => entry.includes("2026-01-01"))).toBe(false);
      const newest = path.join(dir, "backups", entries[2]!);
      expect(yield* fileSystem.readFileString(path.join(newest, "statev2.sqlite"))).toBe("db");
      expect(yield* fileSystem.readFileString(path.join(newest, "statev2.sqlite-wal"))).toBe("wal");
      expect(yield* fileSystem.readFileString(path.join(newest, "settings.json"))).toBe("{}");
      expect(
        yield* fileSystem.readFileString(path.join(newest, "secrets", "provider-auth-x.bin")),
      ).toBe("cred");
      expect(
        yield* fileSystem.readFileString(path.join(newest, "secrets", "files", "nested.bin")),
      ).toBe("nested");
    }),
  );

  it.effect("does nothing on a fresh install without a database", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-update-backup-" });
      yield* snapshotStateDatabase({ stateDir: dir, targetVersion: "0.1.12" });
      expect(yield* fileSystem.exists(path.join(dir, "backups"))).toBe(false);
    }),
  );
});
