# graph-memory-pro

Neo4j-backed knowledge graph context engine for OpenClaw. It extracts `TASK`, `SKILL`, and `EVENT` triples from conversations, recalls related knowledge across sessions, and maintains the graph with GDS PageRank, community detection, and vector deduplication.

This repository is the Linux-portable counterpart of the Windows `v2.0.0` release. It uses Neo4j rather than the SQLite implementation from graph-memory v1.x.

## Features

- Neo4j labels: `Task`, `Skill`, `Event`, `Community`, and `GmMessage`
- Typed relationships: `USED_SKILL`, `SOLVED_BY`, `REQUIRES`, `PATCHES`, `CONFLICTS_WITH`
- GDS Personalized PageRank for recall and global PageRank for maintenance
- Neo4j vector indexes for semantic recall and duplicate detection
- APOC-backed dynamic relationship creation and node merge
- Community-level recall with LLM-generated summaries
- Gateway-authenticated CRUD API at `/graph-memory-pro/api/`

## Requirements

- OpenClaw
- Node.js 20+
- Java 17+ when using the bundled Linux setup
- Neo4j 5.24.2 with APOC 5.24.2
- GDS 2.12.0 is strongly recommended for PageRank; without it, ranking falls back to a basic order

## Release Line

This branch is the **v2.0 desktop-2.0 release line** (Neo4j backend), separate from the v1.x mainline (SQLite). The supported SQLite-to-Neo4j migration workflow is documented in [`migrate/Migrate.md`](migrate/Migrate.md).

## Linux Quick Start

Run the setup script from this repository on Linux:

```bash
bash setup-graph-memory-pro.sh
```

The script installs a user-local Neo4j distribution in `~/.graph-memory-pro/neo4j`, configures APOC and GDS, installs or registers this local plugin, writes `~/.openclaw/openclaw.json`, and restarts the gateway when possible.

Useful modes:

```bash
bash setup-graph-memory-pro.sh --dry-run
bash setup-graph-memory-pro.sh --skip-neo4j --neo4j-uri bolt://localhost:7687 --neo4j-password 'your-password'
bash setup-graph-memory-pro.sh --skip-autostart      # 不配置开机自启
bash setup-graph-memory-pro.sh --assume-deps         # 跳过 curl/tar/jq/java 依赖检查
bash setup-graph-memory-pro.sh --uninstall           # 还原配置 + 清理自启 + 停止 Neo4j
```

Neo4j binds to `127.0.0.1` and uses Bolt port `7687` by default.

### Boot autostart (no sudo)

The installer configures Neo4j to start at boot with a 3-tier no-sudo fallback:

1. **systemd --user unit** (`~/.config/systemd/user/graph-memory-pro-neo4j.service`) — preferred, adds `systemctl --user` management. Best-effort `loginctl enable-linger` for boot-time start.
2. **cron `@reboot`** — always configured as a backup so Neo4j starts even when linger is unavailable.
3. **shell rc hook** (`~/.bashrc` / `~/.zshrc` idempotent `pgrep` guard) — last resort when systemd and cron are both unavailable.

`--uninstall` cleans up all three. Only Java and jq system installs may need `sudo` (the script suggests `sdkman!` and a static `jq` binary as no-sudo alternatives).

## Manual Configuration

Install the local plugin, then make it the OpenClaw context engine:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "graph-memory-pro"
    },
    "entries": {
      "graph-memory-pro": {
        "enabled": true,
        "config": {
          "neo4j": {
            "uri": "bolt://localhost:7687",
            "user": "neo4j",
            "password": "your-neo4j-password"
          },
          "llm": {
            "provider": "openai",
            "apiKey": "your-llm-api-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "gpt-4o-mini"
          },
          "embedding": {
            "apiKey": "your-embedding-api-key",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-v4",
            "dimensions": 1024
          }
        }
      }
    }
  }
}
```

Anthropic direct (Claude) — drop `baseURL`, switch `provider`:

```json
"llm": {
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-3-5-sonnet-20241022"
}
```

`embedding` is optional. When present, `dimensions` must match the Neo4j vector index dimension. For a fresh database, the plugin creates matching indexes during startup. If you change dimensions later, recreate the vector indexes or the Neo4j database.

## Data Flow

```text
conversation messages -> GmMessage nodes -> LLM triple extraction
  -> Task / Skill / Event nodes + typed relationships
  -> embeddings -> vector recall + community expansion + GDS PPR
  -> XML context injection

session end -> dedup -> global PageRank -> communities -> summaries
```

## Verify

Start OpenClaw with verbose logging:

```bash
openclaw gateway --verbose
```

Expected messages include:

```text
[graph-memory-pro] Neo4j schema initialized
[graph-memory-pro] ready | neo4j=bolt://localhost:7687
```

Inspect the graph with the bundled Cypher shell:

```bash
~/.graph-memory-pro/neo4j/bin/cypher-shell -u neo4j -p 'your-password' \
  "MATCH (n:Task|Skill|Event) RETURN n.type, n.name, n.pagerank ORDER BY n.pagerank DESC LIMIT 10"
```

## Agent Tools

| Tool | Description |
| --- | --- |
| `gm_search` | Recall graph knowledge for a query |
| `gm_record` | Add a knowledge node manually |
| `gm_update` | Update an existing node's description and/or content by exact name (throws if not found) |
| `gm_stats` | Show node, relationship, community, and PageRank statistics |
| `gm_maintain` | Run deduplication, PageRank, and community maintenance |

## Development

```bash
npm install
npm run build     # tsc --noEmit
npm test          # unit tests only (no Neo4j required)
```

### Integration tests

Storage / Cypher / graph-algorithm changes are covered by integration tests that need a live Neo4j with APOC and GDS:

```bash
# 本地跑：先启动 Neo4j 5.24.2 + APOC + GDS，然后
NEO4J_INTEGRATION=1 npm test
```

CI runs them via a Docker Neo4j service container — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

`npm run build` performs TypeScript typechecking only. Add integration tests under `test/integration.*.test.ts` whenever you change storage or Cypher behavior; unit tests cover pure logic only.

## License

MIT
