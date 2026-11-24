# Enhanced fork deployment

This document describes the fork-based production deployment of T3 Code: one Windows desktop
application that tracks official `pingdotgg/t3code` stable releases while keeping our custom
features. It is a personal fork under the MIT license; the upstream copyright notice is retained.

## How this fork differs from official T3 Code

- **Update feed**: builds set `T3CODE_DESKTOP_UPDATE_REPOSITORY` to the fork repository, so the
  native updater reads the fork's GitHub Releases (`latest.yml`) instead of `pingdotgg/t3code`.
  The update popover's release links point at the fork.
- **Releases** are titled `T3 Code Enhanced <version> (fork)` and their notes state the upstream
  base and that the build is **unsigned** (official releases are Azure-signed by T3 Tools Inc).
- **Install identity is deliberately unchanged** (`com.t3tools.t3code`, product name
  `T3 Code (Beta)`, install path `%LOCALAPPDATA%\Programs\t3code`) so a fork installer replaces the
  official app in place and keeps all shortcuts, data and credentials.
- Custom features: Claude Auto model/effort routing, Alibaba Token Plan quota monitoring,
  update session interlock, pre-install state backups. Each lives in its own revertible commit.

## Application data locations (never in Git or release artifacts)

| Data                                                               | Location                                       |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Server state: database, settings, providers, encrypted credentials | `%USERPROFILE%\.t3\userdata`                   |
| Electron shell profile                                             | `%APPDATA%\t3code-v2`                          |
| Updater cache                                                      | `%LOCALAPPDATA%\t3code-updater`                |
| Provider CLI credentials (Claude, bl, …)                           | their own homes (`~/.claude`, `~/.bailian`, …) |

Secrets in `userdata/secrets/*.bin` are protected by Windows DPAPI (Electron safeStorage) for the
same Windows user. Migration keeps the same home, user and app identity; decryption is verified
explicitly during migration, never assumed.

## Versioning (native-updater compatible)

The stable updater offers the newest GitHub release **not flagged as prerelease** whose semver is
greater than the installed version. Therefore:

- Upstream sync releases use the plain official version, e.g. `0.1.12`.
- Custom feature releases between upstream stables use `0.1.12-fork.N` and are published as
  **full** releases. Semver orders `0.1.11 < 0.1.12-fork.1 < 0.1.12-fork.2 < 0.1.12`, so the next
  upstream sync always supersedes fork releases beneath it.
- The latest plain release in the fork records the current upstream base; no state file is needed.
- Logic and tests: `scripts/fork/forkVersion.mjs`.

## Release pipeline (`.github/workflows/fork-release.yml`)

Every 6 hours, and on demand (`workflow_dispatch`):

1. **detect** — compare the newest official _stable_ tag with the fork's latest plain release.
   `release-current` mode instead computes the next `-fork.N` version from our current main.
2. **gate** — merge the upstream tag (conflicts abort), mandatory gitleaks history scan,
   frozen-lockfile install, fork versioning tests, lint, typecheck, full regression tests.
3. **cli-archive** — build + smoke the Linux x64 CLI archive embedded as the WSL runtime, keeping
   official WSL functionality.
4. **build-publish** (Windows) — merge + push main, build the NSIS x64 installer with the fork
   update feed and public `.env.example` T3 Connect configuration, verify `latest.yml`
   sha512/size against the installer, gitleaks-scan the artifacts, publish a GitHub Release with
   installer + `latest.yml` + blockmaps + `SHA256SUMS`.
5. **notify-failure** — any failure opens an issue; **nothing is published on conflict, scan
   finding, test failure or build failure**.

Security posture: least-privilege per-job permissions, actions pinned by SHA, no repository
secrets beyond the scoped `GITHUB_TOKEN`, branch protection on `main` (PRs required for humans,
release bot bypass), GitHub secret scanning + push protection enabled on the public repository.

Updates are never force-installed: the native updater only offers the rocket button; install
requires an explicit confirmation, is blocked while any coding session is running, and snapshots
state first (below).

## Pre-install state backups and rollback

Before `quitAndInstall`, after backends stop cleanly, the desktop copies
`statev2.sqlite` (+WAL/SHM), `settings.json`, `desktop-settings.json`, `client-settings.json`,
`keybindings.json` and `secrets/` into `userdata/backups/pre-<timestamp>-<targetVersion>/`,
keeping the newest three (`apps/desktop/src/updates/UpdateStateBackup.ts`). A failed backup
aborts the install.

Migrations are forward-only. Rollback procedure:

1. Close T3 Code completely (tray included).
2. Install the last-known-good installer (previous fork release, or the retained official
   installer for the initial migration).
3. If the failed update advanced the database schema (version crossed a migration), restore the
   matching pre-update backup **with the app closed**: copy the backup's files over
   `%USERPROFILE%\.t3\userdata` (database, settings, secrets). Attachments and provider homes are
   untouched by updates and need no restore.
4. Start the app and verify projects, threads, provider authentication and usage history.

Within the same upstream base, fork ↔ official rollback needs no database restore: the fork adds
no migrations.

## Migration verification checklist (initial cutover)

- Backup of `userdata` + `t3code-v2` exists and the database copy passes `PRAGMA integrity_check`
  with baseline record counts recorded.
- Fork installer replaces the official app at the same path; app opens.
- Projects/threads/messages/usage history match the baseline counts.
- Providers authenticate: Claude subscription, Qwen Token Plan credentials **decrypt** (DPAPI
  verification on a copied home before cutover, then live).
- Claude Auto model/effort routing works; Token Plan quota toggle present; live quota reads.
- Settings → updates show the fork repository; `resources/app-update.yml` owner is the fork.
- Only after all of the above: retire the dev launcher and isolated dev home.
