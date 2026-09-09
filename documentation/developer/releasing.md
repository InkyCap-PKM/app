# Releasing InkyCap & the in-app update check

InkyCap has an in-app **Check for updates** (Settings → Overview). This document
is the runbook for cutting a release and how the check finds it.

## How the update check works

InkyCap **does not self-update**. The in-app check is notify-only: it finds the
latest published release and, if it's newer than the running version, shows a
*"version X is available"* notice with **Download** and **View releases**
buttons. Users download and install the new build by hand (every platform —
`.deb`/`.rpm`/Flatpak/Windows installer/macOS `.dmg`).

### The release feed

The app asks one **static JSON file on a host InkyCap controls**, not a code
forge's API:

```
https://inkycap.org/releases/latest.json
```

The feed — not the app — knows where releases are hosted, so **moving the
project to a different forge is a change to one uploaded file**, not a new app
release that older installs would never receive. The feed also carries the
"releases" and "download" links, so those aren't baked into the binary either.

```json
{
  "schema": 1,
  "releases_url": "https://codefloe.com/InkyCap/app/releases",
  "download_url": "https://inkycap.org/download",
  "channels": {
    "stable": {
      "version": "26.6.10",
      "published": "2026-06-14",
      "url": "https://codefloe.com/InkyCap/app/releases/tag/v26.6.10",
      "notes": "…"
    },
    "beta": { "version": "26.7.1", "…": "…" }
  }
}
```

Rules the feed must keep:

- **`schema: 1` at that URL is permanent.** The app refuses a schema it doesn't
  recognize, so a breaking change has to be published at a *new* path with the
  old one left serving schema 1. Adding optional keys is always safe — unknown
  fields are ignored.
- **Every URL must be `http(s)`.** The app drops anything else and uses its
  built-in defaults, because the frontend hands these to the OS URL opener.
- **Serve it with a short cache lifetime** (a few minutes). A long `max-age` on
  a CDN or Pages host means users keep being told they're up to date after a
  release lands.
- **Both channels live in one file.** One request answers stable and beta; with
  betas enabled the app offers whichever channel is numerically newer, so a beta
  from earlier in the month never looks like an update over a later stable.

Serving it from `inkycap.org` gives a second escape hatch: the file can move to
any static host by repointing DNS, with no app change at all.

### Fallback

If the feed can't be fetched or parsed, the check falls back to querying the
forge's releases API directly (`codefloe.com/api/v1/repos/InkyCap/app`) — the
path builds before 26.9 used exclusively. That covers a lapsed domain or a host
outage. Note the fallback is what *older* builds do permanently: **any forge
move must ship in a release before the move**, and the old repository should
keep serving at least one final release pointing at the new home.

### Advanced override

`settings.updates.feed_url` in `settings.json` replaces the feed URL, for forks
and self-builders. It has no Settings UI on purpose. It must be `https`, and
when it's set the forge fallback is skipped — someone who redirected the check
wouldn't expect it to quietly reach InkyCap's hosts instead.

### Privacy

A check runs only on an explicit click, or on startup if the user opted in
(`Settings → Behaviour → Software updates`). No silent network calls, no
telemetry. Note content and filesystem paths never leave the device. The fetch
runs in Rust rather than the webview because neither host sends CORS headers.

### The moving parts

| Piece | Where |
|-------|-------|
| Release check (feed + forge fallback) | `src-tauri/src/commands/updates.rs` |
| Feed generator | `scripts/release-manifest.mjs` (`npm run release:manifest`) |
| In-app UI | `src/components/UpdateChecker.tsx`, `src/stores/updater.ts` |
| Settings toggles | `src/components/settings/BehaviourSettingsSection.tsx` (`updates.check_on_startup`, `updates.include_beta`) |
| Linux `.deb`/`.rpm` build (CI, optional — see "Cutting a release") | `.forgejo/workflows/release.yml` (Ubuntu 22.04 container) |
| Linux `.deb`/`.rpm` build (local) | `scripts/build-linux-docker.sh` |
| Linux Flatpak build (local) | `scripts/build-flatpak.sh` (+ `flatpak/com.inkycap.editor.yml`) |
| macOS + Windows installer build (CI) | `.github/workflows/build-desktop.yml` on the GitHub build mirror |

The repo lives at `codefloe.com/InkyCap/app` (org-owned). The project moved
there from Codeberg in September 2026; `codeberg.org/InkyCap/app` is archived
and read-only, and still serves every release up to v26.9.4.

> **History:** versions ≤ 26.6.8 used the Tauri updater plugin with a signed
> `latest.json` manifest hosted on Codeberg Pages at `updates.inkycap.org`. That
> whole chain (minisign signing, `createUpdaterArtifacts`, the `pages` branch,
> the manifest generator) was removed in 26.6.10 in favour of a notify-only
> check against Codeberg's releases API. 26.9 kept the notify-only behaviour but
> moved the source of truth back to a static feed — unsigned this time, which is
> safe precisely because nothing is downloaded or executed automatically.

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
- **odd** → development / **beta** (marked a *prerelease* on CodeFloe)

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

Build the artifacts, attach them to a **draft** release, and **publish by hand**.
The git tag is created *by publishing the draft* — never push it beforehand (see
the warning below). Once published, CodeFloe's releases API serves the release
immediately and the in-app check finds it.

> **⚠ Never push the release tag before the draft is ready.** Forgejo treats a
> draft as *a release whose tag does not exist yet*, and **auto-publishes a draft
> the instant a matching tag is pushed** — including a force-move of an existing
> tag ([forgejo#9706](https://codeberg.org/forgejo/forgejo/issues/9706)). So
> pushing `vXX.YY.Z` while a draft of that name exists flips it live immediately,
> in whatever half-attached state it's in, no matter that it was created with
> `draft: true`. The flow below never pushes the tag by hand — **publishing the
> draft is what creates it.**

**1. Bump and push `main` — no tag.**

```sh
npm run version:stable          # or version:beta — see "Bumping the version"
git commit -am "release: vXX.YY.Z"
git push origin main            # main only — do NOT push a tag
```

**2. Create the draft release.** In the web UI, make a new release with **Tag =
`vXX.YY.Z`** and **Target = `main`**. Because that tag doesn't exist yet, Forgejo
holds it as a genuine draft. Leave it a **draft** and tick **pre-release** when
the RELEASE component is odd (a beta). Don't push further commits to `main` until
you've published, or target the exact release commit instead of the branch — the
tag is created at the target when you publish.

**3. Build the Linux `.deb` + `.rpm`** and attach them to the draft:

```sh
scripts/build-linux-docker.sh                  # -> .deb + .rpm (clean container build)
```

**4. Build the Flatpak** and attach it to the draft:

```sh
scripts/build-flatpak.sh                       # -> dist-linux/InkyCap-<version>.flatpak
```

(`build-flatpak.sh` packages the `.deb` from step 3 — run that first.)

**5. Build Windows and macOS** on the GitHub build mirror (see "The GitHub
build mirror" below) and attach the installers:

1. Push the release commit to the mirror: `git push github main`.
2. On GitHub, open **Actions → Build desktop installers → Run workflow**, leave
   `ref` as `main`, and run it.
3. When the run finishes, download the three artifacts from the run summary:
   `inkycap-windows-x86_64`, `inkycap-macos-aarch64`, `inkycap-macos-x86_64`.
4. Unzip them and attach the `*-setup.exe`, `.msi` and `.dmg` files to the
   CodeFloe draft. No signing or `.sig` is needed.

The workflow runs the same version self-check as the Linux job, so a bump that
didn't reach every manifest fails the build instead of shipping.

If you'd rather build Windows by hand on a Windows machine, that still works:

```powershell
npm run tauri build                            # NSIS -setup.exe (and .msi)
src-tauri\target\release\inkycap.exe --version # MUST print the version you bumped to
```

Verify the printed version matches before uploading. A reused local `target/`
can otherwise bake the *previous* version into the installer while the filename
reads the new one. If it's wrong, delete `src-tauri\target\release` (or run
`cargo clean -p inkycap`) and rebuild.

**6. Publish the draft.** In the web UI, edit the draft and publish it — **this
is what creates the `vXX.YY.Z` tag** (at the `main` target). (`git fetch --tags`
to pull the new tag locally.)

**7. Update the release feed.** Nothing tells users about the release until this
is uploaded.

```sh
# Take the release notes from a file so they show up in the in-app notice.
npm run release:manifest -- --notes release-artifacts/RELEASE-NOTES.md --out latest.json
npm run release:manifest:verify -- latest.json        # sanity check
```

RELEASE-NOTES.md must be manually updated to reflect the message that should appear for users (plain text, no markdown). The generator reads the version from `package.json` (so it can't be mistyped)
and merges into the existing `latest.json`, leaving the *other* channel's entry
untouched — publishing a beta never erases the stable entry. Download the
currently published `latest.json` first, or pass it with `--in`, so the merge
has something to merge into.

Upload it to `https://inkycap.org/releases/latest.json`. Once it's live,
**Check for updates** in 26.9+ builds shows the notice; builds from 26.6.10 to
26.8 pick it up through the forge-API fallback instead.

> **CI build (`.forgejo/workflows/release.yml`) is optional and off the happy
> path.** It fires on a `v*` tag push and tries to build the Linux packages into
> a draft, but two things work against it: the runners have been unreliable, and
> a tag push is exactly what auto-publishes a draft (above) — so it fights this
> flow rather than helping it. The dependable path is the local
> `scripts/build-linux-docker.sh`. The workflow is kept for the day the runners
> are reliable *and* the ordering is reworked; until then, don't lean on it.

> **macOS note:** macOS builds are produced by the mirror workflow, but macOS
> is not yet a *fully* first-class target: code-signing and notarization aren't
> set up, so macOS users see an "unidentified developer" warning on first
> launch. Fixing that needs a paid Apple Developer account and two repository
> secrets (a signing certificate and an app-specific password for notarytool).
> Until then, the release notes should tell macOS users to right-click the app
> and choose **Open** the first time.

## The GitHub build mirror

CodeFloe has no macOS or Windows runners, so a push-only mirror of `main` lives
on GitHub purely to build those two installers. GitHub Actions is free and
unmetered for public repositories on its standard Linux, Windows **and** macOS
runners, which is the whole reason the mirror exists.

**What stays on CodeFloe:** the canonical repository, issues, pull requests, and
every published release. The mirror has no issue tracker in use and the workflow
deliberately never creates a GitHub release. `src-tauri/src/commands/updates.rs`
still queries CodeFloe's API, and nothing in the app points at GitHub.

**One-time setup:**

1. Create a public repository on GitHub (for example `InkyCap-PKM/app`) with no
   README, licence or `.gitignore`.
2. Add it as a second remote and push:

   ```sh
   git remote add github git@github.com:InkyCap-PKM/app.git
   git push github main
   ```

3. In the GitHub repo, **Settings → Actions → General**, confirm actions are
   allowed. No secrets are needed; the workflow only reads the repository and
   uploads artifacts.

**Keeping it in sync.** Push to `github` whenever you're about to cut a release.
There is no automatic mirroring, and that's deliberate: the mirror is a build
tool you reach for, not a second source of truth that can drift silently.

**Ongoing cost.** The `.forgejo/workflows/ci.yml` gates (rustfmt, clippy, tests,
typecheck) are *not* duplicated on the mirror. CodeFloe remains the place where
correctness is checked; GitHub only compiles installers.
