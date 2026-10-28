#!/bin/bash
# Link the running dsh host's @deepseek-ai packages into this plugin's
# node_modules, so the plugin runs against the SAME module instances the host
# process uses (dual-package hazard: npm copies would break instanceof-style
# identities across the plugin boundary). Requires `dsh` on PATH. Re-run
# after updating dsh. Also usable from build.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Locate the dsh install's node_modules root: via the dsh binary on PATH
# (including the npm/nvm global layout where packages live under the bin's
# `lib/node_modules` ancestor), else via the npm/npx store pattern (works in
# restricted shells). The FIRST resolution keeps the plugin on the SAME module
# instances the host process loads — a npx-store copy would be a second,
# physically distinct copy of the same version (dual-package hazard).
resolve_dsh_root() {
  # R1 逃生门 (mirrors build.sh): DSH_ROOT explicitly names the host
  # node_modules root when no dsh binary is on PATH. Highest priority.
  if [ -n "${DSH_ROOT:-}" ]; then
    if [ -d "$DSH_ROOT/@deepseek-ai" ]; then
      echo "$DSH_ROOT"
      return 0
    fi
    echo "link-host: DSH_ROOT=$DSH_ROOT 下没有 @deepseek-ai/，不是宿主 node_modules 根" >&2
    return 1
  fi
  local bin=""
  if command -v dsh >/dev/null 2>&1; then
    bin=$(command -v dsh)
  fi
  if [ -n "$bin" ]; then
    local dir
    dir=$(dirname "$bin")
    while [ "$dir" != "/" ]; do
      if [ -d "$dir/node_modules/@deepseek-ai" ]; then
        echo "$dir/node_modules"
        return 0
      fi
      # npm/nvm global: the bin sits in <node>/bin and the packages live
      # INSIDE @deepseek-ai/dsh/node_modules — the location the host process
      # actually loads its services from. The plain lib/node_modules/@deepseek-ai
      # ancestor holds only the dsh package itself, so descend into the dsh
      # install's own dependency tree (the caller appends /@deepseek-ai/<pkg>).
      local global_dsh="$dir/lib/node_modules/@deepseek-ai/dsh/node_modules"
      if [ -d "$global_dsh/@deepseek-ai" ]; then
        echo "$global_dsh"
        return 0
      fi
      dir=$(dirname "$dir")
    done
  fi
  local cand
  for cand in "$HOME"/.npm/_npx/*/node_modules; do
    if [ -d "$cand/@deepseek-ai" ]; then
      echo "$cand"
      return 0
    fi
  done
  return 1
}

NODE_MODULES=$(resolve_dsh_root) || { echo "link-host: cannot locate the dsh install (dsh not on PATH, no npx store found)" >&2; exit 1; }

# The @deepseek-ai/dsh-* packages this plugin imports at runtime or whose
# types it compiles against, plus the ones the tests import directly.
# Transitive deps resolve from the host install.
LINK_PKGS=(
  cordis
  cosmokit
  schemastery
  dsh-agent
  dsh-brand
  # 0.2 line hosts (rc.2/rc.3) ship no dsh-invariants and the plugin never
  # imports it; a list entry missing on the host still fails hard below.
  dsh-llm
  dsh-scope
  dsh-session
  # tests/session-v4-persistence.spec.ts imports this chain directly.
  dsh-session-format
  dsh-session-format-catalog
  dsh-session-format-v0-to-v1
  dsh-session-format-v1-to-v2
  dsh-session-format-v2-to-v3
  dsh-session-format-v3-to-v4
  dsh-system-prompt
  dsh-timeout
  dsh-tools
  dsh-typert-protocol
  dsh-user-approval
  dsh-util-values
)

mkdir -p node_modules/@deepseek-ai
for p in "${LINK_PKGS[@]}"; do
  target="$NODE_MODULES/@deepseek-ai/$p"
  [ -e "$target" ] || { echo "link-host: missing host package: $target" >&2; exit 1; }
  # Remove the npm-installed copy (file or dir) before linking.
  rm -rf "node_modules/@deepseek-ai/$p"
  ln -sfn "$target" "node_modules/@deepseek-ai/$p"
done

# schemastery/cosmokit: hoisted to the top level of older host installs, but
# rc.2+ keeps them only under @deepseek-ai/ — link whichever exists.
for p in schemastery cosmokit; do
  target="$NODE_MODULES/$p"
  [ -e "$target" ] || target="$NODE_MODULES/@deepseek-ai/$p"
  [ -e "$target" ] || { echo "link-host: missing host package: $target" >&2; exit 1; }
  rm -rf "node_modules/$p"
  ln -sfn "$target" "node_modules/$p"
done

echo "linked host packages from: $NODE_MODULES"
