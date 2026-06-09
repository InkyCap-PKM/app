# In-app updates & release pipeline — remaining work

Status checkpoint (2026-06-04). The full how-to lives in
[`releasing.md`](releasing.md); this file is the punch list to take the update
system from **built** to **live**, plus the repo/org changes that go with it.
Safe to copy elsewhere and to hand to a future session as the starting point.

## Already done (in the codebase)

- In-app **Check for updates** (Settings → Overview): check → download → install
  → restart, with up-to-date / manual / error states and a progress bar.
  (`src/components/UpdateChecker.tsx`, `src/stores/updater.ts`)
- **Channels** wired to the version scheme — versions are `YY.MM.RELEASE` and
  the last (RELEASE) component selects the channel: even = stable auto-install,
  odd = beta/manual — and an opt-in **"Include development releases"** +
  **"Check on startup"** toggle (Settings → Behaviour). Privacy: no check
  without user action unless opted in.
- Platform handling: Windows/macOS auto-install; **all Linux**
  (`.deb`/`.rpm`/Flatpak — AppImage dropped) routed to the releases page.
  (`update_install_kind`)
- Updater + process **plugins** registered; **capabilities** granted.
- `tauri.conf.json`: `plugins.updater` endpoint = `https://updates.inkycap.org/stable/latest.json`,
  `createUpdaterArtifacts: true`. **`pubkey` is set** (keypair generated
  2026-06-09 at `~/.inkycap-updater.key` / `.pub`, both backed up).
- **Manifest generator** `scripts/gen-update-manifest.mjs` (`npm run manifest:gen`).
- **Release CI** `.forgejo/workflows/release.yml` (builds Linux `.deb`+`.rpm` in
  an Ubuntu 22.04 container → attaches to the release). Flatpak, the signed
  Windows installer, and the manifest are produced/published **locally** after
  CI — see releasing.md.
- **Versioning** `scripts/version.mjs` + `npm run version:*`; app is `26.6.2`
  (first stable; bumped from beta `26.6.1` for the public launch).
- **Licence**: LiLiQ-P 1.1 in `LICENSE` (EN) + `LICENSE.fr` (FR).
- Repo moved to **`InkyCap/app`**; all in-repo URLs updated.
- **`pages` branch** pushed with `.domains` = `updates.inkycap.org`.
- **DNS**: `updates.inkycap.org CNAME app.inkycap.codeberg.page` — the
  `<repo>.<owner>` scheme routes to the `pages` branch of `InkyCap/app`. (NOT
  bare `inkycap.codeberg.page`, which looks for a repo named `pages` and yields a
  TLS `internal error`.) No separate verify step — DNS is the proof.

## Remaining — owner actions (roughly in order)

1. ~~**Generate the updater signing key**~~ **DONE 2026-06-09.** Keypair at
   `~/.inkycap-updater.key` (private) / `~/.inkycap-updater.key.pub` (public),
   both backed up by owner. Public key pasted into `src-tauri/tauri.conf.json`
   → `plugins.updater.pubkey`. (Key custody with a second maintainer still a
   nice-to-have for bus-factor.)

2. **Add CI secrets** (Codeberg → Settings → Actions → Secrets; prefer
   **org-level** so future repos share them):
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (`""` if you made the key without one)
   - `PAGES_PUSH_TOKEN` (write access to the `pages` branch + release assets)

3. **Make `InkyCap/app` public.** This is the gate for the whole channel:
   Codeberg Pages won't serve a private repo, and release-asset downloads need
   anonymous access. Until then `updates.inkycap.org` will 404 (expected).
   - *If you want to stay private longer:* split a separate **public**
     `InkyCap/updates` repo to hold the `pages` branch + release binaries, and
     have CI push the manifest/asset there. More plumbing; revisit if needed.

4. **Verify the custom domain on Codeberg** (after public): repo → Settings →
   Pages → verify `updates.inkycap.org` (may want a TXT token). Then
   `https://updates.inkycap.org/stable/latest.json` serves once a release runs.

5. **Local release artifacts + manifest.** CI builds only Linux `.deb`+`.rpm`.
   You build the rest locally and publish the manifest last (full recipe in
   releasing.md → "Cutting a release"):
   - **Flatpak**: `scripts/build-linux-docker.sh` then `scripts/build-flatpak.sh`;
     attach the `.flatpak` to the release (no `.sig`).
   - **Windows**: `npm run tauri build` with the signing env vars; attach the
     `*-setup.exe` **and its `.sig`**.
   - **Manifest**: run `npm run manifest:gen` over the signed Windows artifact
     (deb/rpm/Flatpak are unsigned manual installs, so the manifest carries the
     top-level `version` + a `windows-x86_64` entry), then push `latest.json` to
     the `pages` branch under `stable/` or `beta/`.
   - **macOS deferred** — without an Apple Developer identity, macOS users get
     Gatekeeper "unidentified developer" warnings. Decide before promoting macOS.

6. **First-release dry run.** The updater only works in a packaged build (not
   `tauri dev`). For the auto path: build a Windows vN, install it, publish a
   manifest for vN+1 pointing at a real signed Windows artifact, and click
   **Check for updates**. Confirm: Windows stable auto-installs; beta shows the
   manual/releases path; every Linux install shows "manual".

## Don't-forget constraints

- **The endpoint is frozen.** `https://updates.inkycap.org/...` is compiled into
  every build; changing it after the first public release strands existing
  installs. It's locked in — keep it.
- The `pages` branch is **CI-maintained** after the initial `.domains` seed —
  don't hand-edit `stable/latest.json` / `beta/latest.json`.

## Nice-to-have (collaboration / continuity, not blocking)

- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`.
- Add a second org **Owner** (bus-factor) + a key-custody plan.
- Future org repos under the component convention: `InkyCap/notebox`,
  `InkyCap/website`, etc.
