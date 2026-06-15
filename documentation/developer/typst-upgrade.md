# Upgrading the Typst pipeline

This is the runbook for bumping the pinned `typst*` crates (today `0.15.x`).
It exists because a Typst bump has two real costs, and both are recurring:

1. **Finding which call sites broke.** The API surface shifts every minor
   release (`typst-syntax` refactors, crate splits, signature changes).
2. **Confirming rendered output didn't silently shift.** Layout, HTML
   structure, and serialization change in ways the changelog under-counts.

The investments below target both, so each bump becomes mechanical. The
`0.14 → 0.15` arc (branch `typst-0.15`) is the first run of this procedure;
see `.claude/plans/typst-0.15-upgrade.md` for that arc's full migration log.

---

## The procedure

1. **Bump the pins.** Edit the `typst*` versions in
   [`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml) (the block under the
   pin-rationale comment). Update the comment's version. `cargo update -p typst`
   et al., then `cargo build`.

2. **Diff the API surface — but only *our* symbols.** The whole `use typst::*`
   surface is confined to [`src-tauri/src/typst_pipeline/`](../../src-tauri/src/typst_pipeline/)
   (enforced by habit + the re-export seam in
   [`syntax.rs`](../../src-tauri/src/typst_pipeline/syntax.rs) — the only place
   outside the pipeline that needs Typst AST/value types imports from there).
   So a bump's blast radius is one directory. Walk the compiler errors; the
   symbol inventory the `0.15` arc recorded (layout-crate split, introspection
   trait, `FileId`/`VirtualPath` rework, diagnostic spans, `leaf_text`,
   `World::today`, export option structs) is in the plan file as a starting map.

3. **Construct every option struct with `..Default::default()`.** This is why
   `0.15`'s new `PdfOptions` `creator`/`pretty` fields cost us nothing. Additive
   fields never break a spread-default construction. Keep it that way.

4. **Run the fidelity corpus and review the diff.**

   ```sh
   cd src-tauri
   cargo test --test fidelity            # fails if any surface shifted
   cargo insta review                    # walk each diff, accept or reject
   ```

   The corpus ([`tests/fidelity.rs`](../../src-tauri/tests/fidelity.rs) +
   [`tests/fixtures/fidelity/`](../../src-tauri/tests/fixtures/fidelity/))
   compiles representative notes (math, lists, tables, callouts, verse,
   wikilinks/tags, `#note(...)` properties, citations + bibliography) through
   the real pipeline and snapshots three surfaces with `insta`:

   - **HTML** — full serialized output (the readable fidelity signal).
   - **SVG** — a layout digest (page count + rounded page geometry + byte
     length), not the raw glyph-outline data, which would be unreadable and
     noisy under sub-pixel font shifts.
   - **Metadata** — the `typst query` result (`#note` properties, tags, links,
     heading labels, agenda markers): the load-bearing label-stability invariant.

   Snapshots are **machine-independent**: the corpus uses only the fonts bundled
   in `typst-assets` (it never calls `ensure_system_fonts()`), so the same input
   renders identically on any machine. A diff here is a real output change to
   accept deliberately, not a per-machine artifact. Adding a `.typ` under
   `fixtures/fidelity/` extends the corpus with no code change.

5. **Re-run the pin benchmark and record the numbers** (below).

6. **Walk the manual validation checklist** in the plan file — the surfaces a
   snapshot can't cover (in-app SVG preview, PDF/A · PDF/UA export, site export,
   the font picker).

7. **Check MSRV / `rust-toolchain.toml`.** Typst bumps its MSRV regularly
   (`1.89 → 1.92` across `0.14 → 0.15`). Skim the changelog from the embedder's
   angle and keep the toolchain pin current.

---

## The pin benchmark

The `Cargo.toml` pin comment mandates a perf re-measurement on every minor bump.
It lives as an ignored test in the fidelity corpus (it replaces the obsolete
pre-pivot `spike-bench`/`bench-napi.mjs` NAPI scripts, which measured a
`typst.ts` prototype that no longer exists):

```sh
cd src-tauri
cargo test --release --test fidelity -- --ignored --nocapture pin_benchmark
```

It compiles every fixture to SVG and HTML `N` times and prints the mean
per-compile wall-clock. Record the `ALL` line in the bump's plan/commit so the
next bump has a baseline to compare against. It is a *measurement*, not a
pass/fail gate — a regression is a signal to investigate, not an automatic block.

---

## Deliberately not adopting `typst-kit`

The reworked `typst-kit` exists to "make `World` easier," but this project
hand-rolls its `World` ([`world.rs`](../../src-tauri/src/typst_pipeline/world.rs)),
font loading ([`fonts.rs`](../../src-tauri/src/typst_pipeline/fonts.rs)), and
package resolution
([`package_fetch.rs`](../../src-tauri/src/typst_pipeline/package_fetch.rs)). The
`0.15` bump proved that's the *more* stable choice: our `World` needed a
one-line `today` change while `typst-kit` itself was rewritten wholesale.
Revisit only if we later need on-demand system-font discovery or sandboxed
package fetching that `typst-kit` does materially better.
