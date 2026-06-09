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
- Platform handling: Windows/macOS/Linux-AppImage auto-install; non-AppImage
  Linux detected and routed to the releases page. (`update_install_kind`)
- Updater + process **plugins** registered; **capabilities** granted.
- `tauri.conf.json`: `plugins.updater` endpoint = `https://updates.inkycap.org/stable/latest.json`,
  `createUpdaterArtifacts: true`. **`pubkey` is still an empty placeholder.**
- **Manifest generator** `scripts/gen-update-manifest.mjs` (`npm run manifest:gen`).
- **Release CI** `.forgejo/workflows/release.yml` (Linux AppImage build → sign →
  attach to release → publish manifest to the `pages` branch).
- **Versioning** `scripts/version.mjs` + `npm run version:*`; app is `26.6.1`.
- **Licence**: LiLiQ-P 1.1 in `LICENSE` (EN) + `LICENSE.fr` (FR).
- Repo moved to **`InkyCap/app`**; all in-repo URLs updated.
- **`pages` branch** pushed with `.domains` = `updates.inkycap.org`.
- **DNS**: `updates.inkycap.org CNAME inkycap.codeberg.page` — verified resolving.

## Remaining — owner actions (roughly in order)

1. **Generate the updater signing key** (on a trusted machine, *not* CI):
   `npx tauri signer generate -w ~/.tauri/inkycap.key`
   - Paste the **public key** into `src-tauri/tauri.conf.json` →
     `plugins.updater.pubkey`. (Builds won't produce updater artifacts until
     this is set.)
   - Keep the **private key + password** secret; back them up with a second
     maintainer (continuity). Losing it = can't ship accepted updates.

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

5. **Windows & macOS artifacts.** Codeberg's shared runners are Linux-only, so
   CI builds only the AppImage. For the others: build on each OS (self-hosted
   runner or local `npm run tauri build` with the signing env vars), attach the
   installer **and its `.sig`** to the release, then re-run `npm run manifest:gen`
   to fold them into the manifest.
   - **macOS notarization is deferred** — without an Apple Developer identity,
     macOS users get Gatekeeper "unidentified developer" warnings. Decide before
     promoting macOS to a first-class target.

6. **First-release dry run.** The updater only works in a packaged build (not
   `tauri dev`). Build vN, install it, publish a manifest for vN+1 pointing at a
   real signed artifact, and click **Check for updates**. Confirm: stable
   auto-installs; beta shows the manual/releases path; non-AppImage Linux shows
   "manual".

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
