# Releasing InkyCap & the in-app updater

InkyCap ships an in-app **Check for updates** (Settings → Overview). This
document is the runbook for cutting a release that the updater can find,
verify, and install.

## How the updater works

The Tauri updater plugin fetches a small JSON **manifest** (`latest.json`),
compares its `version` to the running app, and — if newer — downloads the
platform artifact, verifies its **minisign signature** against the public key
baked into the build, installs it, and (on Windows/macOS) relaunches.

- **Auto-install**: Windows (NSIS `*-setup.exe`) and macOS (`*.app.tar.gz`).
  The app downloads the signed artifact, verifies it, installs, and relaunches.
- **Manual**: **all Linux** (`.deb`/`.rpm`/Flatpak). InkyCap no longer ships an
  AppImage — the one self-updating Linux format — so every Linux install is
  package-manager territory: the app detects this (`update_install_kind` →
  `manual`) and links to the releases page instead of self-installing. The "a
  newer version exists" notice still works because the frontend reads only the
  manifest's top-level `version` (`src/stores/updater.ts`), which needs no
  per-platform signature.

### Why no AppImage

AppImage was dropped: bundling a self-contained GUI/GPU stack into it pulled in
dependencies that became fragile on hosts much newer than the 22.04 build base,
for more trouble than it was worth. **Flatpak** is the "runs anywhere" Linux
option instead (it runs against the GNOME runtime, which supplies a
version-matched WebKitGTK/GTK/Mesa stack), alongside native **`.deb`/`.rpm`**.
None of these can self-update from inside the app — that capability was unique to
AppImage — so Linux is manual-update across the board, by design.
- **Privacy**: a check runs only on an explicit click, or on startup if the user
  opted in (`Settings → Behaviour → Software updates`). No silent network calls.

The moving parts:

| Piece | Where |
|-------|-------|
| Updater config (pubkey + endpoint) | `src-tauri/tauri.conf.json` → `plugins.updater` |
| `createUpdaterArtifacts` | `src-tauri/tauri.conf.json` → `bundle` |
| Plugin registration | `src-tauri/src/lib.rs` |
| In-app UI | `src/components/UpdateChecker.tsx`, `src/stores/updater.ts` |
| Endpoint URLs (must match config) | `src/stores/updater.ts` constants |
| Manifest generator | `scripts/gen-update-manifest.mjs` (`npm run manifest:gen`) |
| Linux `.deb`/`.rpm` build (CI) | `.forgejo/workflows/release.yml` (Ubuntu 22.04 container) |
| Linux `.deb`/`.rpm` build (local) | `scripts/build-linux-docker.sh` |
| Linux Flatpak build (local) | `scripts/build-flatpak.sh` (+ `flatpak/com.inkycap.editor.yml`) |
| Manifest hosting | `pages` branch → `<channel>/latest.json`, served at `https://updates.inkycap.org/` |

The repo lives at `codeberg.org/InkyCap/app` (org-owned). The update channel is
served from the dedicated subdomain **`updates.inkycap.org`** — a Codeberg Pages
custom domain on the `pages` branch — so the URL baked into every build is
independent of the repo's name or host. The public manifest URLs are therefore
`https://updates.inkycap.org/stable/latest.json` and `.../beta/latest.json`.

## Versioning & channels

InkyCap uses a date-based scheme, **`YY.MM.RELEASE`** (the canonical
implementation is `scripts/version.mjs`):

| Component | Meaning | Example (`26.6.3`) |
|-----------|---------|--------------------|
| `YY`      | two-digit year (the semver *major*) | `26` → 2026 |
| `MM`      | month, 1–12 (the semver *minor*) | `6` → June |
| `RELEASE` | per-month release counter (the semver *patch*) **and** the channel selector | `3` |

The **RELEASE** (last) component does double duty — it counts releases within
the month *and* its parity selects the distribution channel:

- **even** → user-facing / **stable** → published to `stable/latest.json`
- **odd** → development / **beta** → published to `beta/latest.json`

So a month's history reads `26.6.1` (first beta), `26.6.2` (first stable),
`26.6.3` (next beta), `26.6.4` (next stable), and so on — odd and even
interleave as work alternates between development and shipping.

### Why parity lives in the last component

It would be more natural to put the channel in the middle, but the scheme must
satisfy the **Windows MSI `ProductVersion`** limits — major ≤ 255, minor ≤ 255,
build ≤ 65535. A `YYYYMM`-style major (e.g. `202606`) overflows the major field
and the WiX bundler refuses to package it (`app version major number cannot be
greater than 255`). Keeping `YY.MM` as a clean two-field calendar stamp fits
those limits, which leaves the channel parity to ride in the last component.

### How the channel is consumed

- **Release CI** (`.forgejo/workflows/release.yml`) reads the RELEASE component
  of the pushed tag and publishes the manifest to `stable/` or `beta/`.
- **The in-app check** uses the **stable** endpoint for the signed
  auto-install path. If the user enables "Include development (beta) releases",
  the app also checks the beta manifest and, if newer, points them at the
  releases page (betas install by hand by design).
- **Settings → Overview** shows a "development build" badge when the running
  version's RELEASE component is odd (`src/components/settings/OverviewSection.tsx`).

### Bumping the version

Never hand-edit the number — use the npm aliases. Each one keeps `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in lockstep and prints
`old -> new (channel)`:

```sh
npm run version:show                # print current version + channel; change nothing
npm run version:beta                # next development release (next odd RELEASE)
npm run version:stable              # next user-facing release (next even RELEASE)
npm run version:patch               # next release in the current channel (+2, keeps parity)
npm run version:release -- 202607   # start a new month, resetting to RELEASE 1 (-> 26.7.1)
```

Worked from a starting point of `26.6.1` (a beta):

| Command | Result | Channel | Notes |
|---------|--------|---------|-------|
| `version:beta` | `26.6.3` | beta | next dev build this month |
| `version:stable` | `26.6.2` | stable | promote to a stable release |
| `version:patch` | `26.6.3` | beta | stays beta — `+2` preserves parity |
| `version:release -- 202607` | `26.7.1` | beta | begin July's cycle |

`stable` / `beta` **cross** channels (jump to the next even / odd); `patch`
**stays** in the current channel (`+2`). The `release` argument is a 6-digit
`YYYYMM` — its year is truncated to two digits (`2026 → 26`) and a fresh month
always starts at RELEASE 1 (beta).

The lockfiles (`src-tauri/Cargo.lock`, `package-lock.json`) also carry the
version; they refresh on the next `cargo` / `npm` build, or run `npm install` /
`cargo build` to update them before committing.

## One-time setup

### 1. Generate the signing keypair

On a trusted machine (NOT in CI), generate the minisign keypair the updater
will trust:

```sh
npx tauri signer generate -w ~/.tauri/inkycap.key
```

- Put the **public key** it prints into `src-tauri/tauri.conf.json` →
  `plugins.updater.pubkey`. (It currently holds an empty placeholder; `tauri
  build` will refuse to produce updater artifacts until it's set.)
- Keep the **private key** secret. Never commit it. Store it — and its password
  — as CI secrets (below). If you lose it, users on the old key can't accept
  updates; if it leaks, rotate immediately.

### 2. Add CI secrets

In the Codeberg repo → Settings → Actions → Secrets:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/inkycap.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password (`""` if none) |
| `PAGES_PUSH_TOKEN` | a token with write access to the repo's `pages` branch + release assets |

### 3. Set up Codeberg Pages on `updates.inkycap.org`

Codeberg Pages serves any branch literally named `pages` as a static website.
Seed it **once** (the release CI writes the channel manifests into it from then
on). The channel directories live at the branch root — the subdomain already
means "updates" — so the served URLs are
`https://updates.inkycap.org/stable/latest.json` and `.../beta/latest.json`.

Do this in a throwaway clone — `git switch --orphan` empties the working tree,
so running it in your main checkout would scrub your dev files out of that
folder:

```sh
git clone git@codeberg.org:InkyCap/app.git /tmp/inkycap-pages
cd /tmp/inkycap-pages
git switch --orphan pages            # new empty branch, unrelated history
# Tell Codeberg Pages which custom domain this branch serves:
printf 'updates.inkycap.org\n' > .domains
git add .domains
git commit -m "init pages: updates.inkycap.org"
git push -u origin pages
cd - && rm -rf /tmp/inkycap-pages    # CI maintains the branch from here
```

(No need to pre-create `stable/`/`beta/` — git doesn't track empty directories,
and CI creates them on the first release.)

Then add the DNS record at your `inkycap.org` provider. Codeberg routes a custom
domain to a repo by the **`<repo>.<owner>.codeberg.page`** subdomain scheme, and
the `pages` branch lives in the repo **`app`** under the **`InkyCap`** org — so
the CNAME target carries *both* the repo and owner:

```
updates.inkycap.org.   CNAME   app.inkycap.codeberg.page.
```

(Pointing at the bare `inkycap.codeberg.page` instead makes Codeberg look for a
repo literally named `pages`, fail to match, and never issue a TLS cert — the
symptom is a `tlsv1 alert internal error`.) There is **no separate verification
step or web-UI button**: Codeberg verifies ownership purely via this CNAME (the
fact that it resolves into `codeberg.page` is the proof), then auto-issues a
Let's Encrypt certificate. Confirm the endpoint in `src-tauri/tauri.conf.json`
and the constants in `src/stores/updater.ts` both read
`https://updates.inkycap.org/...` — **they must
agree**, and changing them after the first public release strands existing
installs on the old URL.

## Cutting a release

A release is built across three machines: CI builds the portable Linux packages,
and you build Flatpak and Windows locally. The **manifest is published last,
locally**, because it needs the signed Windows artifact (`.deb`/`.rpm`/Flatpak
carry no signature, and `gen-update-manifest.mjs` requires at least one `.sig`).

**1. Bump and tag.**

```sh
npm run version:stable          # or version:beta — see "Bumping the version"
git commit -am "release: vXX.YY.Z"
git tag vXX.YY.Z && git push origin main vXX.YY.Z
```

**2. CI builds Linux `.deb` + `.rpm`** (`.forgejo/workflows/release.yml`, fired
by the `v*` tag): inside an Ubuntu 22.04 container it runs
`tauri build --bundles deb rpm`, creates the release for the tag, and attaches
the two packages. It marks the release a *prerelease* when the RELEASE component
is odd (beta). It publishes **no manifest** — see step 5.

**3. Build the Flatpak locally** and attach it to the release:

```sh
scripts/build-linux-docker.sh                 # produces the .deb the Flatpak packages
scripts/build-flatpak.sh                       # -> dist-linux/InkyCap-<version>.flatpak
```

Upload the `.flatpak` to the release (web UI: drag it onto the release, or the
API). It needs no `.sig`.

**4. Build Windows locally** (on a Windows machine), signed:

```sh
set TAURI_SIGNING_PRIVATE_KEY=<contents of your private key>
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<its password>
npm run tauri build                            # NSIS -setup.exe + .sig (and .msi)
```

Upload the `*-setup.exe` **and its `.sig`** to the same release.

**5. Generate and publish the manifest** (locally, once the Windows `.sig`
exists). Collect the signed Windows artifacts under one directory, then:

```sh
npm run manifest:gen -- \
  --base-url https://codeberg.org/InkyCap/app/releases/download/vXX.YY.Z \
  --version XX.YY.Z \
  --artifacts ./collected-artifacts \
  --out latest.json
```

The generator emits a `windows-x86_64` entry from the `.sig` it finds, plus the
top-level `version` that drives the Linux "new version" notice. Copy it to the
right channel on the `pages` branch (even RELEASE → `stable/`, odd → `beta/`)
and push:

```sh
git clone --branch pages git@codeberg.org:InkyCap/app.git /tmp/pages
mkdir -p /tmp/pages/stable        # or beta/
cp latest.json /tmp/pages/stable/latest.json
cd /tmp/pages && git add stable/latest.json \
  && git commit -m "release: stable manifest for vXX.YY.Z" && git push
```

**6. Verify.** Visit `https://updates.inkycap.org/<channel>/latest.json`, then
click **Check for updates** in an installed older build (Windows auto-installs;
Linux shows the manual "View releases" path).

> **macOS note:** macOS is not yet a first-class target. Code-signing /
> notarization isn't set up, so macOS users see "unidentified developer"
> warnings; when you do build a macOS bundle, attach the `*.app.tar.gz` + `.sig`
> and re-run step 5 so the generator adds the `darwin-*` entry too.

## Testing the updater locally

The updater only runs in a packaged build (not `tauri dev`). To smoke-test the
**auto** path: build a Windows version N, install it, publish a manifest for N+1
pointing at a real signed Windows artifact, then click **Check for updates**. The
**manual** path is whatever you get on Linux (any `.deb`/`.rpm`/Flatpak install
shows "View releases"); the **error** path can be exercised by pointing the
endpoint at an unreachable URL.
