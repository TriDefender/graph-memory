#!/usr/bin/env bash
set -euo pipefail

repo="$(pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export HOME="$tmp/home"
export GMP_HOME="$HOME/.graph-memory-pro"
export PC=1
mkdir -p "$HOME/.openclaw" "$GMP_HOME/staging" "$GMP_HOME/neo4j/data/databases/neo4j" "$GMP_HOME/neo4j/bin"
printf '{}\n' > "$HOME/.openclaw/openclaw.json"
printf 'existing graph data\n' > "$GMP_HOME/neo4j/data/databases/neo4j/sentinel"

cat > "$GMP_HOME/neo4j/bin/neo4j" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
chmod +x "$GMP_HOME/neo4j/bin/neo4j"

dist="$tmp/dist/neo4j-community-5.24.2"
mkdir -p "$dist/bin" "$dist/conf" "$dist/plugins" "$dist/data"
printf '# stock config\n' > "$dist/conf/neo4j.conf"
cat > "$dist/bin/neo4j" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
cat > "$dist/bin/neo4j-admin" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
chmod +x "$dist/bin/neo4j" "$dist/bin/neo4j-admin"
tar czf "$GMP_HOME/staging/neo4j.tar.gz" -C "$tmp/dist" neo4j-community-5.24.2
printf 'fake apoc jar\n' > "$GMP_HOME/staging/apoc-5.24.2-core.jar"

fake_bin="$tmp/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/npm" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
cat > "$fake_bin/sleep" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
chmod +x "$fake_bin/npm" "$fake_bin/sleep"
export PATH="$fake_bin:$PATH"

bash "$repo/setup-graph-memory-pro.sh" \
  --assume-deps \
  --non-interactive \
  --skip-gds \
  --skip-autostart \
  --neo4j-password graphmemory \
  --no-restart >/dev/null

if [[ ! -f "$GMP_HOME/neo4j/data/databases/neo4j/sentinel" ]]; then
  echo "existing Neo4j graph data was deleted during upgrade" >&2
  exit 1
fi
printf 'preserved\n'
