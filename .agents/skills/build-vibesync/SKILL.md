---
name: build-vibesync
description: "Compile and smoke-test the VibeSync Rust CLI. Use for local setup, build failures, dependency changes, debug binaries, or release binaries on the supported macOS Apple Silicon target."
---

# Build VibeSync

Build from the repository root. Treat the Rust binary as the product; Node dependencies serve `.sandcastle/`, not runtime (`Cargo.toml [package]`, `package.json "devDependencies"`).

## Procedure

1. Confirm supported host with `uname -srm`. Expect Darwin arm64; platform calls are concentrated in `src/volume.rs::get_vol_attr` and `src/run.rs::copyfile`.
2. Confirm Rust is available with `rustc --version` and `cargo --version`. No pinned toolchain file exists.
3. Run `cargo build --locked` for a development binary.
4. Smoke only the non-mutating CLI surface with `cargo run --locked -- --help`.
5. When a release binary is requested, run `cargo build --release --locked`.
6. Report command, host, result, and binary path: `target/debug/vibesync` or `target/release/vibesync`.

Keep `--locked` so dependency drift fails visibly. Update `Cargo.lock` only when dependency/version work is in scope. Never use a real `vibesync run` as a build smoke test; Run mutates its configured destination (`src/run.rs::execute_reviewed_plan`).

For full quality gates, invoke `$test-vibesync`.
