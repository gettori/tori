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
#   scripts/check.sh packs   the pack snapshot against src-tauri/packs.lock
#   scripts/check.sh all     all four, in that order
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

# Packs are changed in gettori/packs and brought in by scripts/sync-packs.sh,
# never edited here: the lock is what says which packs commit this build ships.
packs() {
  step "pack snapshot matches src-tauri/packs.lock"
  local lock=src-tauri/packs.lock
  if ! (cd src-tauri/packs && grep -v '^#\|^commit ' "../packs.lock" | shasum -a 256 -c --quiet); then
    echo "error: a file in src-tauri/packs differs from $lock; change it in gettori/packs and run scripts/sync-packs.sh" >&2
    exit 1
  fi
  if ! diff <(grep -v '^#\|^commit ' "$lock" | sed 's/^[0-9a-f]*  //') \
    <(cd src-tauri/packs && find lsp dap formatters themes agents icons -type f | LC_ALL=C sort); then
    echo "error: src-tauri/packs and $lock list different files (< lock only, > disk only); run scripts/sync-packs.sh" >&2
    exit 1
  fi
}

case "${1:-}" in
  ts) ts ;;
  rust) rust ;;
  audit) audit ;;
  packs) packs ;;
  all)
    ts
    rust
    audit
    packs
    ;;
  *)
    echo "usage: scripts/check.sh ts|rust|audit|packs|all" >&2
    exit 2
    ;;
esac
