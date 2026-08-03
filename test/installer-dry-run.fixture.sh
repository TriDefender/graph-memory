#!/usr/bin/env bash
set -euo pipefail

repo="$(pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "$1" >&2
  exit 1
}

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/openclaw" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DRY_RUN_RECORD"
exit 0
SCRIPT
chmod +x "$fake_bin/openclaw"
export PATH="$fake_bin:$PATH"
export PC=1

install_home="$tmp/install-home"
mkdir -p "$install_home"
export HOME="$install_home"
export GMP_HOME="$install_home/.graph-memory-pro"
export DRY_RUN_RECORD="$tmp/install-commands"
bash "$repo/setup-graph-memory-pro.sh" \
  --dry-run --assume-deps --non-interactive --skip-gds --skip-autostart --no-restart >/dev/null
[[ ! -e "$HOME/.openclaw" ]] || fail "dry-run created ~/.openclaw"
[[ ! -e "$GMP_HOME" ]] || fail "dry-run created GMP_HOME"
[[ ! -e "$DRY_RUN_RECORD" ]] || fail "dry-run executed openclaw config init"

invalid_home="$tmp/invalid-home"
mkdir -p "$invalid_home/.openclaw"
printf 'not-json\n' > "$invalid_home/.openclaw/openclaw.json"
cp "$invalid_home/.openclaw/openclaw.json" "$tmp/invalid-before"
export HOME="$invalid_home"
export GMP_HOME="$invalid_home/.graph-memory-pro"
export DRY_RUN_RECORD="$tmp/invalid-commands"
bash "$repo/setup-graph-memory-pro.sh" \
  --dry-run --assume-deps --non-interactive --skip-gds --skip-autostart --no-restart >/dev/null
cmp -s "$tmp/invalid-before" "$HOME/.openclaw/openclaw.json" || fail "dry-run replaced invalid openclaw.json"

uninstall_home="$tmp/uninstall-home"
mkdir -p "$uninstall_home/.openclaw" "$uninstall_home/.graph-memory-pro/neo4j/bin"
printf '{"current":true}\n' > "$uninstall_home/.openclaw/openclaw.json"
printf '{"backup":true}\n' > "$uninstall_home/.openclaw/openclaw.json.backup.20260803_000000"
cp "$uninstall_home/.openclaw/openclaw.json" "$tmp/uninstall-before"
cat > "$uninstall_home/.graph-memory-pro/neo4j/bin/neo4j" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DRY_RUN_RECORD"
exit 0
SCRIPT
chmod +x "$uninstall_home/.graph-memory-pro/neo4j/bin/neo4j"
export HOME="$uninstall_home"
export GMP_HOME="$uninstall_home/.graph-memory-pro"
export DRY_RUN_RECORD="$tmp/uninstall-commands"
printf 'y\ny\n' | bash "$repo/setup-graph-memory-pro.sh" --uninstall --dry-run >/dev/null
cmp -s "$tmp/uninstall-before" "$HOME/.openclaw/openclaw.json" || fail "uninstall dry-run changed openclaw.json"
[[ ! -e "$DRY_RUN_RECORD" ]] || fail "uninstall dry-run stopped Neo4j"
[[ -d "$GMP_HOME" ]] || fail "uninstall dry-run deleted GMP_HOME"
if compgen -G "$HOME/.openclaw/openclaw.json.before-uninstall.*" >/dev/null; then
  fail "uninstall dry-run created a config backup"
fi

printf 'dry-run-clean\n'
