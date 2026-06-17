# Releasing InkyCap & the in-app update check

InkyCap has an in-app **Check for updates** (Settings → Overview). This document
is the runbook for cutting a release and how the check finds it.

## How the update check works

InkyCap **does not self-update**. The in-app check is notify-only: it asks
Codeberg's releases API for the latest published release and, if it's newer than
the running version, shows a *"version X is available"* notice with a **View
releases** button that opens the releases page. Users download and install the
new build by hand (every platform — `.deb`/`.rpm`/Flatpak/Windows installer).

- The check runs in Rust (`src-tauri/src/commands/updates.rs`,
  `check_latest_release`) rather than the webview, because the Codeberg API
  sends no CORS headers. It hits:
  - `…/releases/latest` for the **stable** channel (the API excludes drafts and
    pre-releases here), or
  - `…/releases?limit=1&draft=false` when the user opted into betas.
- **Privacy**: a check runs only on an explicit click, or on startup if the user
  opted in (`Settings → Behaviour → Software updates`). No silent network calls,
  no telemetry. Note content and filesystem paths never leave the device.

The moving parts:

| Piece | Where |
|-------|-------|
| Release check (Codeberg API) | `src-tauri/src/commands/updates.rs` |
| In-app UI | `src/components/UpdateChecker.tsx`, `src/stores/updater.ts` |
| Settings toggles | `src/components/settings/BehaviourSettingsSection.tsx` (`updates.check_on_startup`, `updates.include_beta`) |
| Linux `.deb`/`.rpm` build (CI) | `.forgejo/workflows/release.yml` (Ubuntu 22.04 container) |
| Linux `.deb`/`.rpm` build (local) | `scripts/build-linux-docker.sh` |
| Linux Flatpak build (local) | `scripts/build-flatpak.sh` (+ `flatpak/com.inkycap.editor.yml`) |

The repo lives at `codeberg.org/InkyCap/app` (org-owned). There is no separate
update server, signed manifest, or Codeberg Pages dependency — the releases API
*is* the source of truth, and reflects a published release immediately.

> **History:** earlier versions (≤ 26.6.8) used the Tauri updater plugin with a
> signed `latest.json` manifest hosted on Codeberg Pages at
> `updates.inkycap.org`. That whole chain (minisign signing,
> `createUpdaterArtifacts`, the `pages` branch, the manifest generator) was
> removed in 26.6.10 in favour of this notify-only check. Existing ≤ 26.6.8
> installs still point at the old manifest endpoint and won't auto-discover newer
> releases; they upgrade by downloading 26.6.10+ once, after which the API-based
> check takes over.

## Versioning & channels

InkyCap uses a date-based scheme, **`YY.MM.RELEASE`** (the canonical
implementation is `scripts/version.mjs`):

| Component | Meaning | Example (`26.6.3`) |
|-----------|---------|--------------------|
| `YY`      | two-digit year (the semver *major*) | `26` → 2026 |
| `MM`      | month, 1–12 (the semver *minor*) | `6` → June |
| `RELEASE` | per-month release counter (the semver *patch*) **and** the channel selector | `3` |

The **RELEASE** (last) component does double duty — it counts releases within
the month *and* its parity selects the channel:

- **even** → user-facing / **stable**
- **odd** → development / **beta** (marked a *prerelease* on Codeberg)

So a month reads `26.6.1` (first beta), `26.6.2` (first stable), `26.6.3` (next
beta), `26.6.4` (next stable), and so on. The stable check uses
`…/releases/latest`, which the API filters to exclude prereleases — so a beta
tag never shows up as a stable update. A user who enables "Include development
(beta) releases" gets notified of the newest release of any kind.

### Why parity lives in the last component

The scheme must satisfy the **Windows MSI `ProductVersion`** limits — major ≤
255, minor ≤ 255, build ≤ 65535. A `YYYYMM`-style major (e.g. `202606`) overflows
the major field and the WiX bundler refuses it. Keeping `YY.MM` as a clean
two-field calendar stamp fits those limits, which leaves the channel parity to
ride in the last component.

### Bumping the version

Never hand-edit the number — use the npm aliases. Each keeps `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in lockstep and prints
`old -> new (channel)`:

```sh
npm run version:show                # print current version + channel; change nothing
npm run version:beta                # next development release (next odd RELEASE)
npm run version:stable              # next user-facing release (next even RELEASE)
npm run version:patch               # next release in the current channel (+2, keeps parity)
npm run version:release -- 202607   # start a new month, resetting to RELEASE 1 (-> 26.7.1)
```

`stable` / `beta` **cross** channels (jump to the next even / odd); `patch`
**stays** in the current channel (`+2`). The `release` argument is a 6-digit
`YYYYMM` — its year is truncated to two digits and a fresh month starts at
RELEASE 1 (beta).

The lockfile `src-tauri/Cargo.lock` also carries the version; it refreshes on
the next `cargo build`. Commit it alongside the bump so it doesn't drift.

## Cutting a release

A release is built across machines: you create the draft, attach the Linux,
Flatpak, and Windows artifacts, and **publish it by hand**. Once published,
Codeberg's releases API serves it immediately and the in-app check finds it.

**1. Bump and tag.**

```sh
npm run version:stable          # or version:beta — see "Bumping the version"
git commit -am "release: vXX.YY.Z"
git tag vXX.YY.Z && git push origin main vXX.YY.Z
```

**2. Create the draft release by hand.** In the web UI, make a new release for
the tag `vXX.YY.Z`, leave it a **draft**, and tick **pre-release** when the
RELEASE component is odd (a beta). Do this yourself — the CI workflow *can*
create the draft when a runner picks up the tag, but in practice the runners
have been unreliable, so creating it by hand is the dependable path. (If CI does
run, it reuses an existing draft rather than making a second one.)

**3. Add the Linux `.deb` + `.rpm`.** When a runner is up,
`.forgejo/workflows/release.yml` (fired by the `v*` tag) builds them in an
Ubuntu 22.04 container (`tauri build --bundles deb rpm`) and attaches them to
the draft. Don't count on it — if CI doesn't fire, build them locally and upload
by hand:

```sh
scripts/build-linux-docker.sh                  # -> .deb + .rpm
```

**4. Build the Flatpak locally** and attach it to the draft release:

```sh
scripts/build-linux-docker.sh                 # produces the .deb the Flatpak packages
scripts/build-flatpak.sh                       # -> dist-linux/InkyCap-<version>.flatpak
```

Upload the `.flatpak` to the draft (web UI: drag it onto the release).

**5. Build Windows locally** (on a Windows machine):

```powershell
npm run tauri build                            # NSIS -setup.exe (and .msi)
src-tauri\target\release\inkycap.exe --version # MUST print the version you tagged
```

Verify the printed version matches the tag before uploading. A reused local
`target/` can otherwise bake the *previous* version into the installer while the
filename reads the new one. If it's wrong, delete `src-tauri\target\release` (or
run `cargo clean -p inkycap`) and rebuild. Upload the `*-setup.exe` (and the
`.msi` if you ship it) to the same draft. No signing or `.sig` is needed.

**6. Publish the release.** In the web UI, edit the draft and publish it. The
releases API now returns it, and **Check for updates** in older builds (26.6.10+)
will show the notice with a **View releases** link.

> **macOS note:** macOS is not yet a first-class target. Code-signing /
> notarization isn't set up, so macOS users see "unidentified developer"
> warnings; attach the `.dmg`/`.app.tar.gz` to the release when you build one.
