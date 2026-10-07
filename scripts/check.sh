#!/usr/bin/env bash
# Every check CI runs, runnable here. Each job in .github/workflows/check.yml
# calls one target of this script, so the list exists once and passing
# `scripts/check.sh all` locally is passing CI. The one job outside it is the
# `dco` sign-off check, which only has meaning on a pull request from outside.
#
#   scripts/check.sh ts      lockfile, type check (desktop and mobile), format,
#                            lint, token guard and vitest, both vite builds
#   scripts/check.sh rust    format, clippy, desktop crate tests, mobile crate
#                            check
#   scripts/check.sh audit   npm and crate advisories
#   scripts/check.sh all     all three, in that order
set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf '\n==> %s\n' "$*"
}

ts() {
  # Frozen, as CI installs: a package.json edit without its lockfile fails
  # here rather than on the pull request.
  step "install (frozen lockfile)"
  pnpm install --frozen-lockfile
  step "type check"
  pnpm exec tsc --noEmit
  step "type check (mobile)"
  pnpm --dir mobile typecheck
  step "format"
  pnpm exec vp fmt --check
  step "lint"
  pnpm exec vp lint --deny-warnings
  step "token guard and vitest"
  pnpm test
  step "vite build"
  pnpm build
  step "vite build (mobile)"
  pnpm --dir mobile build
}

rust() {
  step "format"
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  cargo fmt --manifest-path mobile/src-tauri/Cargo.toml --check
  step "clippy"
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  cargo clippy --manifest-path mobile/src-tauri/Cargo.toml --all-targets -- -D warnings
  step "desktop crate tests"
  cargo test --manifest-path src-tauri/Cargo.toml
  step "mobile crate check"
  cargo check --manifest-path mobile/src-tauri/Cargo.toml
}

audit() {
  if ! command -v cargo-audit >/dev/null; then
    echo "error: cargo-audit is not installed; run: cargo install cargo-audit --locked" >&2
    exit 1
  fi
  step "npm advisories"
  pnpm audit --prod
  # Called directly rather than as `cargo audit`: through cargo, rustup would
  # install the whole pinned toolchain just to read two lockfiles.
  step "desktop crate advisories"
  cargo-audit audit --file src-tauri/Cargo.lock
  step "mobile crate advisories"
  cargo-audit audit --file mobile/src-tauri/Cargo.lock
}

case "${1:-}" in
  ts) ts ;;
  rust) rust ;;
  audit) audit ;;
  all)
    ts
    rust
    audit
    ;;
  *)
    echo "usage: scripts/check.sh ts|rust|audit|all" >&2
    exit 2
    ;;
esac
