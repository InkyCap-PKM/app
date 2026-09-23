# Releasing InkyCap & the in-app update check

InkyCap has an in-app **Check for updates** (Settings → Overview). This document
is the runbook for cutting a release and how the check finds it.

## How the update check works

InkyCap **does not self-update yet** (as of v26.9.12). The in-app check is notify-only: it finds
the latest published release and, if it's newer than the running version,
shows a *"version X is available"* notice with **Download** and **View
releases** buttons. Users download and install the new build by hand (every
platform: `.deb`/`.rpm`/Flatpak/Windows installer/macOS `.dmg`).

An in-app **Upgrade** button is on the way. The release process already
publishes the signed *updater feeds* it will read (see "The updater feeds"
below), so they are proven before any app depends on them.

### The release feed

The app asks one **static JSON file on a host InkyCap controls**:

```
https://inkycap.org/releases/latest.json
```

The feed knows where releases are hosted, so **moving the
project to a different forge is a change to the uploaded file**, not requiring a new app
release that older installs wouldn't receive. The feed also carries the
"releases" and "download" links, so those can be changed if needed.

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

Serving it from `inkycap.org` allow the file to be moved to
any static host by repointing DNS.

### The updater feeds

The Upgrade button is driven by the Tauri updater plugin, which reads its own
feed format, not `latest.json`. So each release also publishes one small file
per channel:

```
https://inkycap.org/releases/updater/stable.json
https://inkycap.org/releases/updater/beta.json
```

Each lists, per platform (`linux-x86_64-deb`, `windows-x86_64-msi`,
`darwin-aarch64-app`, …), the installer's download link on CodeFloe and its
**signature**. The app refuses any download whose signature doesn't match the
public key built into it, so where the files are hosted doesn't affect
safety. The stable feed names the latest stable release; the beta feed names
the newest release of either kind.

- **These addresses are permanent** once a version that reads them ships. A
  breaking change goes to a new path.
- **Currently, there is no Flatpak entry.** A Flatpak installed from a bundle file can't
  update itself, and the updater must never run inside the Flatpak. Users should manually update Flatpak installations until some future possibility occurs that permits InkyCap's presence on a system like Flathub.
- The feeds are signed with the project's private key; see "The signing
  key" below.

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
wouldn't expect it to reach InkyCap's hosts instead.

### Privacy

A check runs only on an explicit click, or on startup if the user opted-in
(`Settings → Behaviour → Software updates`). No silent network calls, no
telemetry. The fetch
runs in Rust rather than the webview because neither host sends CORS headers.

### The pieces

| Piece | Where |
|-------|-------|
| Release check (feed + forge fallback) | `src-tauri/src/commands/updates.rs` |
| Signing + feed generator | `scripts/release-feeds.mjs` (`npm run release:feeds`, `release:feeds:check`) with helpers in `scripts/release/` |
| Release computer setup check | `scripts/release/check-setup.mjs` (`npm run release:check-setup`) |
| In-app UI | `src/components/UpdateChecker.tsx`, `src/stores/updater.ts` |
| Settings toggles | `src/components/settings/BehaviourSettingsSection.tsx` (`updates.check_on_startup`, `updates.include_beta`) |
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
> moved the source of truth back to a static feed, unsigned, which is safe
> precisely because nothing is downloaded or executed automatically. The
> updater feeds that followed differ from the ≤ 26.6.8 setup in two ways: the
> builds carry no key (signing happens afterwards on the maintainer's
> computer, so the GitHub mirror needs no secrets), and the feeds are plain
> files on inkycap.org uploaded by hand.

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

A month reads as `26.6.1` (first beta), `26.6.2` (first stable), `26.6.3` (next
beta), `26.6.4` (next stable), and so on. The stable check uses
`…/releases/latest`, which the API filters to exclude pre-releases. A beta tag won't show up as a stable update. A user who enables "Include development
(beta) releases" gets notified of the newest release of any kind.

### Why parity lives in the last component

The scheme satisfies the **Windows MSI `ProductVersion`** limits — major ≤
255, minor ≤ 255, build ≤ 65535. A `YYYYMM`-style major (e.g. `202606`) overflows
the major field and the WiX bundler refuses it. Keeping `YY.MM` as a clean
two-field calendar stamp fits those limits, which leaves the channel parity to
ride in the last component.

### Bumping the version

Never hand-edit the number, instead use the npm aliases. Each keeps `package.json`,
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

Build the artifacts into one local folder, attach them to a **draft**
release, sign them and write the feeds, then **publish by hand** and upload
the feeds.
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

**3. Build the Linux `.deb` + `.rpm`**:

```sh
scripts/build-linux-docker.sh                  # -> dist-linux/ .deb + .rpm (clean container build)
mkdir -p release-artifacts/XX.YY.Z
cp dist-linux/*XX.YY.Z*.deb dist-linux/*XX.YY.Z*.rpm release-artifacts/XX.YY.Z/
```

`release-artifacts/<version>/` is the one folder this release's installers
are gathered in: step 6 signs them there, and you attach them to the draft
from there. Attach the `.deb` and `.rpm` now or later; signing doesn't change
the files.

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
4. Unzip them into `release-artifacts/<version>/` (subfolders are fine)
   and attach the `*-setup.exe`, `.msi`, `.dmg` and both `.app.tar.gz`
   files to the CodeFloe draft from there. The `.app.tar.gz` files are what
   the Upgrade button installs on macOS.

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

**6. Sign the installers and write the feeds** (the release is still a
draft). This needs a computer set up with the signing key (see "The signing key"
below); `npm run release:check-setup` confirms it.

Signing doesn't change the installers. It produces a short *signature* for
each one, a fingerprint stamped with the private key, which goes into the
feed next to that installer's download link. When a user clicks Upgrade,
their app downloads the installer and checks it against the signature before
installing. So the files attached to the draft stay valid, **as long as they
are the same files that were signed** (not a rebuild).

1. Make sure `release-artifacts/<version>/` holds every installer from
   steps 3 and 5. The Flatpak is not needed.
2. Write the text users should see in the in-app update notice into
   `release-artifacts/<version>/RELEASE-NOTES.md` (plain text, no markdown).
3. Run:

   ```sh
   npm run release:feeds
   ```

   It asks for the key's password, then:
   - signs each installer and checks each signature against the public key
     in `tauri.conf.json`;
   - downloads the live `latest.json` and merges this release into it,
     leaving the other channel's entry alone, so a beta never erases the
     stable entry;
   - writes the results to `release-artifacts/<version>/feeds/`.

   If an installer is missing (for example a failed Intel macOS build), it
   stops. `npm run release:feeds -- --partial` goes ahead without it; people
   on that platform see the update and use Download.

The `.sig` files it leaves next to the installers are working files; don't
attach them to the release.

**7. Publish the draft.** In the web UI, edit the draft and publish it — **this
is what creates the `vXX.YY.Z` tag** (at the `main` target).

```sh
git fetch --tags                # pull the newly created tag locally
git push github vXX.YY.Z        # mirror it, so the mirror keeps tag parity
```

Mirroring the tag is housekeeping, not a build step — the installers were
already built from `main` in step 5. It keeps the mirror's refs matching
CodeFloe's, so a later rebuild of exactly this release is a matter of pressing
**Run workflow** and typing the tag into its `ref` field. Pushing the tag
starts nothing: the workflow runs only from that button, never from a push.
The Forgejo draft-auto-publish hazard warned about above is a *CodeFloe*
behaviour — GitHub has nothing equivalent, and `build-desktop.yml` never
creates a GitHub release.

**8. Upload the feeds by hand, then check.** Nothing tells users about the
release until this is done. In cPanel's File Manager, upload the files from
`release-artifacts/<version>/feeds/` into the website's `releases/` folder,
replacing the old ones: `latest.json` into `releases/`, and the
`updater/*.json` file(s) into `releases/updater/` (step 6 lists exactly
which). Then:

```sh
npm run release:feeds:check
```

It checks two things:

- **Download links:** each installer link on CodeFloe works and serves the
  same file that was signed (compared by size with the files in
  `release-artifacts/<version>/`). A different file would fail the signature
  check on users' computers: their Upgrade would refuse it and point them to
  Download.
- **Feeds:** inkycap.org serves feeds naming this version.

Once it passes, **Check for updates** in 26.9+ builds shows the notice;
builds from 26.6.10 to 26.8 pick it up through the forge-API fallback
instead.

### The signing key

The Upgrade button installs only files signed with the project's private
key. The key has two halves:

- **Private key**: a short text file protected by a password. It never goes
  in the repository or on GitHub. On each computer used to cut releases it
  lives at `~/.config/inkycap-release/updater.key`, readable only by its
  owner (`chmod 600`). The password is never stored on disk; the release
  command asks for it each time. Keep the key text and password somewhere
  safe and reachable from every release computer, plus an offline backup.
- **Public key**: one line of text in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`. Every copy of InkyCap carries it and checks
  downloads against it.

`npm run release:check-setup` checks a computer's setup and says how to fix
anything missing. Computers used only for development need none of this.

**Creating a key** (once per project, or when replacing it):

```sh
mkdir -p ~/.config/inkycap-release
npm run tauri signer generate -- -w ~/.config/inkycap-release/updater.key
chmod 600 ~/.config/inkycap-release/updater.key
```

It asks for a password and writes `updater.key` (private) and
`updater.key.pub` (public). Put the text of `updater.key.pub` into
`tauri.conf.json` as above, and commit it.

**Replacing the key** takes one release, because installed copies trust only
the public key they were built with. Create the new key under another name,
put its public key in `tauri.conf.json`, and sign that one release with the
**old** key, telling the release command to check against the old public
key:

```sh
npm run release:feeds -- --verify-with path/to/old/updater.key.pub
```

From the next release on, sign with the new key.

**If the key or its password is lost**, installed copies can't be sent
updates through the Upgrade button. Their Download button still works.
Create a new key; everyone installs the next version by hand once (say so at
the top of its release notes), and Upgrade works again after that.

> **There is no CI build for the Linux packages, by design.** A
> `.forgejo/workflows/release.yml` used to try it on a `v*` tag push and was
> removed in September 2026: it never once succeeded, and two things work
> against the idea. CodeFloe's shared runners are unreliable, and a tag push is
> exactly what auto-publishes a draft (above) — so a tag-triggered build fights
> this flow rather than helping it. `scripts/build-linux-docker.sh` is the way
> Linux packages are built.

> **macOS note:** macOS builds are produced by the mirror workflow, but macOS
> is not yet a *fully* first-class target: code-signing and notarization aren't
> set up, so macOS users see an "unidentified developer" warning on first
> launch. Fixing that needs a paid Apple Developer account and two repository
> secrets (a signing certificate and an app-specific password for notarytool).
> Until then, the release notes should tell macOS users to right-click the app
> and choose **Open** the first time.

## The GitHub build mirror

CodeFloe has no macOS or Windows runners, so a push-only mirror of `main` lives
on GitHub purely to build those two installers.