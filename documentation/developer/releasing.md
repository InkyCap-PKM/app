# Releasing InkyCap & the in-app updater

InkyCap ships an in-app **Check for updates** (Settings → Overview). This
document is the runbook for cutting a release that the updater can find,
verify, and install.

## How the updater works

The Tauri updater plugin fetches a small JSON **manifest** (`latest.json`),
compares its `version` to the running app, and — if newer — downloads the
platform artifact, verifies its **minisign signature** against the public key
baked into the build, installs it, and (on Windows/macOS) relaunches.

- **Auto-install**: Windows (NSIS `*-setup.exe`), macOS (`*.app.tar.gz`), and
  **Linux AppImage**. On Linux the AppImage is replaced in place and the user
  restarts.
- **Manual**: non-AppImage Linux (`.deb`/`.rpm`/Flatpak/Snap) is package-manager
  territory — the app detects this (`update_install_kind` → `manual`) and links
  to the releases page instead of self-installing.
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
| Release CI | `.forgejo/workflows/release.yml` |
| Manifest hosting | `pages` branch → `<channel>/latest.json`, served at `https://updates.inkycap.org/` |

The repo lives at `codeberg.org/InkyCap/app` (org-owned). The update channel is
served from the dedicated subdomain **`updates.inkycap.org`** — a Codeberg Pages
custom domain on the `pages` branch — so the URL baked into every build is
independent of the repo's name or host. The public manifest URLs are therefore
`https://updates.inkycap.org/stable/latest.json` and `.../beta/latest.json`.

## Versioning & channels

Versions are `YYYYMM.RELEASE.PATCH` (see `scripts/version.mjs`). The **RELEASE**
(middle) component selects the channel:

- **odd** → user-facing / **stable** → published to `stable/latest.json`
- **even** → development / **beta** → published to `beta/latest.json`

The in-app check uses the **stable** endpoint for the signed auto-install path.
If the user enables "Include development (beta) releases", the app also checks
the beta manifest and, if newer, points them at the releases page (betas install
by hand by design).

Bump the version with the npm aliases (they keep `package.json`,
`src-tauri/Cargo.toml`, and `tauri.conf.json` in lockstep):

```sh
npm run version:show
npm run version:stable     # next user-facing (odd)
npm run version:beta       # next development (even)
npm run version:patch      # bugfix bump
npm run version:release -- 202607   # start a new monthly release
```

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

Then add the DNS record at your `inkycap.org` provider:

```
updates.inkycap.org.   CNAME   inkycap.codeberg.page.
```

(Codeberg also wants the domain verified — see Codeberg's "Custom domains" Pages
docs.) Confirm the endpoint in `src-tauri/tauri.conf.json` and the constants in
`src/stores/updater.ts` both read `https://updates.inkycap.org/...` — **they must
agree**, and changing them after the first public release strands existing
installs on the old URL.

## Cutting a release

1. Bump the version (see above) and commit.
2. Tag and push: `git tag v202606.3.1 && git push origin v202606.3.1`.
3. CI (`.forgejo/workflows/release.yml`) builds the signed Linux AppImage,
   attaches it (+`.sig`) to the release, regenerates the manifest for the right
   channel, and pushes it to the `pages` branch.
4. Verify: visit the published `updates/<channel>/latest.json` and click
   **Check for updates** in an installed older build.

### Windows & macOS artifacts

Codeberg's shared runners are **Linux-only**, so CI builds only the AppImage.
For the other platforms, until you add self-hosted runners with matching labels:

1. On a Windows / macOS machine, set the same signing env vars and run
   `npm run tauri build`.
2. Upload the produced installer **and its `.sig`** to the same release.
3. Re-fold them into the manifest and re-publish:

   ```sh
   # with every platform's artifacts collected under one dir:
   npm run manifest:gen -- \
     --base-url https://codeberg.org/InkyCap/app/releases/download/v202606.3.1 \
     --artifacts ./collected-artifacts \
     --out latest.json
   # then copy latest.json to pages/updates/<channel>/ and push
   ```

The generator is platform-set agnostic — it emits entries only for the `.sig`
files it finds, so partial and complete manifests are both valid.

> **macOS note:** code-signing / notarization is intentionally **not** set up
> yet. The updater signature is separate from Apple's Gatekeeper; without an
> Apple Developer identity, macOS users will see "unidentified developer"
> warnings on install. Revisit before promoting macOS to a first-class target.

## Testing the updater locally

The updater only runs in a packaged build (not `tauri dev`). To smoke-test:
build version N, install it, publish a manifest for N+1 pointing at a real
signed artifact, then click **Check for updates**. The `manual`/non-AppImage and
error paths can be exercised by running a non-AppImage Linux build or pointing
the endpoint at an unreachable URL.
