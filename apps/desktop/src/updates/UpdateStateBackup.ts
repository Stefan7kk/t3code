import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Rollback safety net for desktop updates: before quitAndInstall stops the backends for good,
 * snapshot the schema-sensitive state (database, settings, credentials) into userdata/backups.
 * Migrations are forward-only, so a downgrade across a schema change restores one of these.
 */
const BACKUP_RETENTION = 3;
const STATE_FILES = ["statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm"];
const SETTINGS_FILES = [
  "settings.json",
  "desktop-settings.json",
  "client-settings.json",
  "keybindings.json",
];

export const snapshotStateDatabase = Effect.fn("desktop.updates.snapshotStateDatabase")(
  function* (input: { readonly stateDir: string; readonly targetVersion: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = path.join(input.stateDir, "statev2.sqlite");
    if (!(yield* fileSystem.exists(source))) return;

    const backupsDir = path.join(input.stateDir, "backups");
    yield* fileSystem.makeDirectory(backupsDir, { recursive: true });
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const safeVersion = input.targetVersion.replace(/[^A-Za-z0-9._-]/g, "_");
    // The timestamp leads so lexical order is chronological across versions.
    const target = path.join(backupsDir, `pre-${stamp}-${safeVersion}`);
    yield* fileSystem.makeDirectory(target, { recursive: true });

    for (const name of [...STATE_FILES, ...SETTINGS_FILES]) {
      const from = path.join(input.stateDir, name);
      if (yield* fileSystem.exists(from)) {
        yield* fileSystem.copyFile(from, path.join(target, name));
      }
    }
    const secretsDir = path.join(input.stateDir, "secrets");
    if (yield* fileSystem.exists(secretsDir)) {
      yield* fileSystem.copy(secretsDir, path.join(target, "secrets"));
    }

    const entries = yield* fileSystem.readDirectory(backupsDir);
    const backups = entries.filter((entry) => entry.startsWith("pre-")).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - BACKUP_RETENTION))) {
      yield* fileSystem.remove(path.join(backupsDir, old), { recursive: true });
    }
  },
);
