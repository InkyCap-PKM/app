<!-- Thanks for contributing. Keep changes focused: one logical change per PR.
     See CONTRIBUTING.md for the full workflow and conventions. -->

## What this changes

A short description of the change and why it is needed.

## Related issue

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor or cleanup
- [ ] Documentation
- [ ] Build, CI, or tooling

## Checklist

- [ ] Branched from `main`, one logical change.
- [ ] Documentation updated in this same change (a subsystem change updates its
      doc under `documentation/developer/`).
- [ ] User-facing strings go through the i18n seam (no bare text).
- [ ] All gates pass locally:
  - [ ] `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
  - [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
  - [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
  - [ ] `npx tsc --noEmit`
  - [ ] `npm test`
  - [ ] `npm run i18n:check`

## How I verified this

What you ran or clicked to confirm it works.
