# Graph Memory

<p align="center">
  <img src="docs/images/deepseek-harness-wordmark.svg" alt="DeepSeek Harness" width="310">
</p>

<p align="center">
  <strong>Stop model-visible history from growing while durable memory keeps learning.</strong><br>
  Graph Memory owns historical context natively in DeepSeek Harness, recalls only relevant source-backed memory, and retains its OpenClaw integration.
</p>

<p align="center">
  <img src="docs/images/brand/openclaw-wordmark.svg" alt="Compatible with OpenClaw" width="118"><br>
  <sub>One memory core · OpenClaw Context Engine entry maintained</sub>
</p>

<p align="center">
  <a href="https://www.dsh.so/artifact/graph-memory"><img src="https://www.dsh.so/badge/graph-memory.svg" alt="dsh.so security badge"></a>
  <a href="https://www.dsh.so/artifact/graph-memory"><img src="https://www.dsh.so/badge/install/graph-memory.svg" alt="dsh.so install badge"></a>
</p>

<p align="center">
  <a href="README_CN.md">中文</a> ·
  <a href="#core-advantages">Advantages</a> ·
  <a href="#graph-memory-architecture">Architecture</a> ·
  <a href="#install-on-deepseek-harness">DSH Install</a> ·
  <a href="#graph-memory-pro-as-a-dsh-plugin">Pro Plugin</a> ·
  <a href="docs/DSH_NATIVE_PLAN.md">Technical Report (Chinese)</a>
</p>

Compaction answers “how much of this conversation still fits?” Graph Memory answers “which past knowledge is worth recalling now?”

| What users need to know first | What Graph Memory does |
|---|---|
| Will the current conversation keep expanding? | Keeps the newest five completed user turns by default and replaces the older model surface with one archive marker. |
| Does old knowledge disappear? | No source event is deleted; the current query retrieves graph nodes and their exact source Q/A. |
| Does this require a DSH fork? | No. It uses the Cordis plugin lifecycle and public DSH context protocols. |

<p align="center">
  <img src="docs/images/dsh-context-takeover-chart.svg" alt="DSH 20-turn first-request context token comparison" width="96%">
</p>

> In a real 20-turn engineering workload, T20 first-request tokens fell from 56,998 to 16,769 (−70.58%), and message count fell from 171 to 24. Cumulative first-request tokens fell 51.61%. After including nondeterministic main-agent tool loops, Graph Memory maintenance, and embeddings, measured total tokens fell 3.47%. [Read the full methodology and caveats](docs/GRAPH_MEMORY_README_REPORT.html) · [Re-run the sanitized benchmark](benchmarks/dsh-context-takeover/README.md)

Reusable conversation knowledge becomes typed nodes:

- `TASK`: goals, execution, and outcomes;
- `SKILL`: validated reusable methods;
- `EVENT`: errors, fixes, decisions, changes, and facts.

Generic `RELATES` edges carry conversation-derived predicates for topic navigation, while compatibility edges such as `USED_SKILL` and `SOLVED_BY` preserve established agent-memory semantics. A new question retrieves a relevant local subgraph instead of replaying the complete history.

## Core advantages

### Native host integration

- Loaded by the DSH/Cordis plugin lifecycle, not simulated through an MCP side channel.
- Integrates Session, Tool, Agent Loop, Prompt Assembly, LLM, and Credentials seams.
- Disposes database, cache, and event listeners with its plugin fiber.
- Does not fork or modify DeepSeek Harness core.

Automatic recall does not require a tool call. `assistantTools` defaults to `none`, adding no model-facing schema; use `search` for explicit `gm_search` or `all` temporarily for administration.

### Durable cross-session memory

- Knowledge from Session A can be recalled automatically in Session B.
- Memory survives DSH restarts.
- Stable event IDs make resume and HMR ingestion idempotent.
- Source sessions and graph edges explain why a memory was recalled.

### Smaller, cleaner context

- Keeps the five newest completed user turns verbatim before the current prompt (`freshTurnCount`, default `5`).
- Uses DSH's public surface-replacement and token-meter shadow-price protocols to replace older model-facing history with one constant-size archive marker. This makes no compaction-model request; the durable source event log remains intact.
- Preserves exact source-message provenance and retrieves both archived same-session memory and cross-session memory for the current query.
- Semantic vector retrieval with FTS5 lexical fallback.
- Community detection and PageRank remain local maintenance/inspection tools; query-time ranking stays semantic.
- Only memories ranked for the current question enter the prompt; full source Q/A is attached atomically and the host/provider owns token accounting.
- Automatic recall and `gm_search` share one vector/FTS ranking path. `semanticScoreThreshold` is optional because cosine scales vary by embedding model; the default is provider-neutral Top-K.
- Query-time PageRank reranking is disabled: graph centrality no longer displaces the strongest semantic match. PageRank remains an offline graph-maintenance statistic.
- Recalled history is marked as untrusted reference material and cannot override current user instructions.

### Local-first and lightweight

- Community uses SQLite by default; no graph database deployment is required.
- Embeddings are optional. Without them, recall falls back to FTS5.
- Data remains in the user's local profile by default.
- OpenAI-compatible embeddings support DashScope, OpenAI, and local providers.

### Observable and verifiable

- `gm_status` reports store path, graph counts, vector coverage, mode, and dimensions.
- Model or dimension changes trigger re-embedding.
- Vectors with different dimensions are never silently compared.
- Critical knowledge can be recorded deterministically with `gm_record`.

### Scoped token benchmark

The original OpenClaw adapter was measured in a seven-turn workflow that installed, authenticated, and queried `bilibili-mcp`:

<p align="center">
  <img src="docs/images/token-comparison.png" alt="Seven-turn token comparison" width="82%">
</p>

| Turn | Without Graph Memory | With Graph Memory |
|---|---:|---:|
| R1 | 14,957 | 14,957 |
| R4 | 81,632 | 29,175 |
| R7 | **95,187** | **23,977** |

The measured reduction at R7 was approximately **75%** in that specific workflow. This is a scenario-level comparison, not a universal savings guarantee; the mechanism is replacing indiscriminate history replay with a relevant knowledge subgraph.

## Project evolution

The DSH integration does not discard the original project. Graph Memory is evolving from an OpenClaw memory plugin into a graph-memory core that different agent harnesses can load natively.

| Stage | Deliverable | Status |
|---|---|---|
| OpenClaw origin | Context Engine, cross-session graph memory, vector/FTS5 recall | Maintained |
| Community graph engine | SQLite, FTS5, vectors, graph ranking, provenance | Available |
| DeepSeek Harness | Cordis adapter, native tools, auto-recall, Credentials | Implemented and tested |
| Graph Memory Pro | Visual graph workbench, controlled drag-and-drop, optional Neo4j | Pro Lite read-only Host + Client implemented; 2D/3D and drag pending |

On March 15, 2026, the project owner presented Graph Memory's architecture at the CLAW program event held in Tsinghua Science Park. The following owner-supplied materials and the [Sina Finance event report](https://cj.sina.com.cn/articles/view/7984421895/1dbe89c0700101nnpq) document that development.

<p align="center">
  <img src="docs/images/history/tsinghua-sharing.jpg" alt="Graph Memory technical sharing" width="47%">
  <img src="docs/images/history/sina-report.jpg" alt="Sina Finance event coverage" width="28%">
</p>

- [Community cross-session memory demo](https://www.bilibili.com/video/BV1xUcZzfEaB/)
- [Graph Memory Pro technical presentation](https://www.bilibili.com/video/BV1KwwzzGEvD/)

The image below is the existing OpenClaw / ClawX-era Pro graph prototype. It demonstrates a previously explored interaction direction; it is not a shipped DSH frontend.

<p align="center">
  <img src="docs/images/graph-ui.png" alt="Existing Graph Memory Pro prototype" width="92%">
</p>

Names and venue information document project history only and do not imply endorsement by Tsinghua University, Sina Finance, DeepSeek, or OpenClaw.

## Graph Memory architecture

### Typed knowledge graph

```text
TASK   ──USED_SKILL──▶ SKILL
TASK   ──SOLVED_BY───▶ EVENT
SKILL  ──REQUIRES────▶ SKILL
EVENT  ──PATCHES─────▶ SKILL
SKILL  ──CONFLICTS_WITH──▶ SKILL
```

Nodes retain episodic user/assistant provenance. This preserves the context in which knowledge was created, not only a lossy summary.

### Query-first recall

```mermaid
flowchart LR
  Q[Current query] --> VECTOR[Vector ranking]
  Q --> FTS[FTS5 fallback]
  VECTOR --> TOPK[Relevant Top-K nodes]
  FTS --> TOPK
  TOPK --> EDGES[Edges among selected nodes]
  TOPK --> SOURCE[Exact source Q/A]
  EDGES --> CONTEXT[Atomic memory bundle]
  SOURCE --> CONTEXT
```

### Host data flow

```mermaid
flowchart LR
  USER[User message] --> SESSION[DSH Session Events]
  SESSION --> ADAPTER[Graph Memory Cordis Adapter]
  ADAPTER --> POLICY[Keep newest N user turns]
  POLICY --> ARCHIVE[Public surface replacement]
  ARCHIVE --> SURFACE[Bounded model surface]
  ADAPTER --> EXTRACT[Structured Extraction]
  EXTRACT --> GRAPH[(SQLite / FTS5 / Vectors)]

  USER --> RECALL[Semantic + Lexical Recall]
  GRAPH --> RECALL
  RECALL --> PROMPT[Graph + exact source Q/A]
  PROMPT --> LOOP[DSH Agent Loop]

  CREDS[DSH Credentials] --> ADAPTER
  TOOLS[gm_* Tools] --> ADAPTER
```

The code follows a host-neutral core plus host adapters:

```text
graph-memory/
├── dsh.ts                 # DeepSeek Harness / Cordis adapter
├── index.ts               # OpenClaw adapter
├── cordis.patch.yml       # DSH bundle entry
└── src/
    ├── extractor/         # conversation → TASK / SKILL / EVENT
    ├── recaller/          # query-first vector / FTS5 recall
    ├── graph/             # PageRank and communities
    ├── store/             # SQLite schema and queries
    ├── format/            # safe context assembly
    └── engine/            # LLM and embedding providers
```

## Native DeepSeek Harness status

| Capability | Status | Notes |
|---|---|---|
| Native Cordis loading | **Done** | No DSH fork required |
| Rolling context ownership | **Done** | Configurable newest N turns; older surface prefix becomes an archive marker |
| Cross-session auto-recall | **Done** | Injected before the first model request; waits for embedding initialization |
| Explicit record and search | **Done** | `gm_record`, `gm_search` |
| Vector backfill and migration | **Done** | Model, dimension, and fingerprint tracked |
| Visible plugin state | **Done** | Active in Plugin Inventory |
| Pro visual workbench | **Experimental** | Separate DSH Client Plugin with a read-only card snapshot |

Current beta: `1.6.0-beta.12`. The current candidate passes 123 automated tests across 20 files, both TypeScript builds, and npm dry-run packaging. A fresh-profile tarball install, expanded-config check, and real boot also passed on the latest official DSH `0.1.3-alpha.1` (`d347e70390`). A 20-turn GLM-5.2 run verified configurable five-turn context ownership, per-turn tool-trace projection, exact source provenance, query-first vector/FTS recall, failure quarantine, and cross-session recall without an explicit memory tool call. The first-request context total fell from 532,451 to 257,656 tokens (51.61%); T20 fell from 56,998 to 16,769 (70.58%). Nineteen of twenty structured extractions succeeded; the failed turn was quarantined rather than repaired or persisted. Full evidence and caveats are in [`docs/GRAPH_MEMORY_README_REPORT.html`](docs/GRAPH_MEMORY_README_REPORT.html).

<p align="center">
  <strong>Plugin enabled: graph-memory/dsh is active in the DSH plugin list</strong><br>
  <img src="docs/images/dsh/plugin-inventory-active.png" alt="Graph Memory active in the DSH plugin list" width="88%">
</p>

<p align="center">
  <strong>Cross-session semantic recall in a fresh Session</strong><br>
  <img src="docs/images/dsh/vector-cross-session-recall.png" alt="Cross-session vector recall in DSH" width="88%">
</p>

## Install on DeepSeek Harness

Prerequisite: Node.js `22.13+`. The current beta is not yet published to npm, but the repository ships its prebuilt runtime and can be installed without authorizing install scripts:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:adoresever/graph-memory
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

Alternatively, build and install a tarball from a checkout:

```bash
git clone https://github.com/adoresever/graph-memory.git
cd graph-memory
npm install
npm test
npm pack
npx @deepseek-ai/dsh plugin --profile web add /absolute/path/to/graph-memory-1.6.0-beta.12.tgz
```

After installation, verify that `graph-memory/dsh` is enabled under **Settings → Plugins → Plugin list**.

Default store:

```text
$DSH_HOME/graph-memory/graph-memory.db
```

Without `DSH_HOME`, this is normally `~/.dsh/graph-memory/graph-memory.db`.

## Optional vector retrieval

Do not send secrets in chat. Cordis stores only a credential reference; DSH `credentials` resolves the real value for each embedding operation.

DashScope example:

```bash
export GRAPH_MEMORY_EMBEDDING_API_KEY='replace-with-your-key'
export GRAPH_MEMORY_EMBEDDING_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
export GRAPH_MEMORY_EMBEDDING_MODEL='text-embedding-v4'
export GRAPH_MEMORY_EMBEDDING_DIMENSIONS='1024'
dsh web
```

Without embeddings, Graph Memory continues with FTS5 and does not block conversation.

![Vector status](docs/images/dsh/vector-status.png)

## Durable message retention (opt-in)

DSH context compaction and SQLite retention are intentionally separate. Compaction bounds the model surface; it does not delete provenance from `gm_messages`. The default policy is `keep: all`, so upgrading never removes existing data.

For large stores, configure `messageRetention` on `graph-memory/dsh` and roll it out in dry-run mode first:

```yaml
messageRetention:
  keep: referenced
  recentTurns: 20
  retentionDays: 30
  batchSize: 500
  dryRun: true
```

- `all`: preserve every durable event; this is the default.
- `referenced`: prune extracted, unreferenced rows; optional turn/day windows remain protected.
- `recent`: requires `recentTurns` or `retentionDays`, and also always preserves referenced or pending rows.

`recentTurns` counts real user turns per session and keeps their following assistant/tool events. When both windows are set, a row is eligible only after it falls outside both. Invalid timestamps are retained. Each maintenance tick uses one bounded transaction, re-checks `gm_node_sources`, and never runs `VACUUM` automatically.

Before enabling deletion, back up `$DSH_HOME/graph-memory/graph-memory.db`, keep `dryRun: true`, run `gm_maintain`, and inspect `gm_stats`. Change `dryRun` to `false` only after the candidate receipt matches the intended policy.

## DSH tools

| Tool | Purpose |
|---|---|
| `gm_status` | Plugin, store, extraction, recall, vector, and retention state |
| `gm_search` | Explicit long-term graph search |
| `gm_record` | Persist a TASK, SKILL, or EVENT |
| `gm_stats` | Graph, durable-message, and retention receipts/statistics |
| `gm_maintain` | Run one bounded graph + configured retention maintenance tick |
| `gm_retry_extraction` | Requeue quarantined extraction failures without deleting or truncating source messages |

Each completed DSH turn creates exactly one extraction job containing only its original user question and final visible assistant answer. Reasoning, tool calls, and tool results are excluded and no character/message splitting is performed. The adapter sets no default output-token cap and performs no automatic retries; incomplete or failed results remain `quarantined` until explicitly requeued with `gm_retry_extraction`.

Extraction is an auxiliary workload and can use a dedicated DSH model route. Set
`GRAPH_MEMORY_LLM_PROVIDER` and `GRAPH_MEMORY_LLM_MODEL`; that route takes
precedence over the foreground Agent route. Optionally set
`GRAPH_MEMORY_LLM_REASONING_EFFORT=off` when the selected DSH provider/model
declares that capability, and `GRAPH_MEMORY_LLM_MAX_TOKENS` when an explicit
response cap is desired. Unsupported reasoning controls fail visibly instead
of silently changing provider behavior.

Automatic recall does not require an explicit `gm_search` tool call. The plugin retrieves relevant memory during Prompt Assembly.

## Graph Memory Pro as a DSH plugin

**The old `desktop-2.0` Pro cannot be installed into DSH directly, but the new Pro Lite now has a minimal, separately installable DSH plugin loop.** The old branch remains an OpenClaw + Neo4j implementation. The new `dsh-pro/` package reads Community SQLite on the Host, exposes only bounded snapshots over Typed Remote, and registers a read-only entry in the DSH Web sidebar.

The reviewed `desktop-2.0` code includes Neo4j Driver, GDS, APOC, vector indexes, graph maintenance tools, and CRUD routes. Today it also:

- imports `openclaw/plugin-sdk` at the entry;
- registers OpenClaw Gateway HTTP routes;
- writes OpenClaw configuration and restarts its Gateway during installation;
- exposes Neo4j connection details through `/graph-memory-pro/neo4j-config`;
- contains no installable DSH Client Plugin.

The correct plugin architecture is:

```mermaid
flowchart LR
  CORE[Graph Memory Core] --> STORE[SQLite default / Neo4j optional]
  STORE --> HOST[DSH Host Plugin]
  HOST --> REMOTE[Typed Remote API]
  REMOTE --> CLIENT[DSH Client Plugin]
  CLIENT --> SPLIT[Conversation + Graph split view]
  CLIENT --> DROP[Controlled drag-to-context]
```

The first Pro plugin does not need mandatory Neo4j:

- **Pro Lite:** SQLite plus a 2D/3D DSH graph client;
- **Neo4j adapter:** optional storage plugin for large graphs, GDS, and advanced analytics;
- the browser receives bounded `GraphSnapshot` data, never database passwords or arbitrary Cypher access;
- drag operations submit node IDs and intent; the Host validates them and writes visible, reversible Session context.

Pro should therefore be an optional Graph Memory DSH plugin module, not a separate standalone product.

### Recommended package split

```text
graph-memory                          # Community: current native Host Plugin
graph-memory-pro-dsh                 # Pro Lite: local beta Host + Client Plugin
@adoresever/graph-memory-store-neo4j # Optional large-graph adapter, to be built
```

The first milestone should be **Pro Lite**: reuse the existing SQLite graph and add the DSH graph workbench, so users do not need Neo4j. Neo4j stays optional for larger graphs, GDS, and advanced analysis. **This is a planned architecture; the existing `desktop-2.0` Pro is still Neo4j-only and does not yet implement a switchable SQLite / Neo4j `GraphStore`.**

### Current local installation

The npm package `graph-memory@1.5.8` is still the OpenClaw release. The new Community beta can be installed from GitHub; `graph-memory-pro-dsh` still installs from a checkout:

```bash
dsh plugin --profile web add \
  git+https://github.com/adoresever/graph-memory.git

dsh plugin --profile web add \
  /absolute/path/to/graph-memory/dsh-pro

dsh web
```

Both plugins share `~/.dsh/graph-memory/graph-memory.db` by default. The current entry provides bounded SQLite `GraphSnapshot`, `gm_graph_snapshot`, `gm_graph_node`, a strict Typed Remote, and a read-only sidebar snapshot/search view. It does not yet provide a 2D/3D renderer, full split view, drag-to-context, or node editing.

### Four required integration layers

1. **Core contracts:** bounded SQLite `GraphSnapshot` and node detail are implemented; a Neo4j provider and unified writable contract remain.
2. **Host Plugin:** the Pro Lite Host service, two bounded tools, and read-only Typed Remote are implemented; write actions and finer permissions remain.
3. **Client Plugin:** the DSH sidebar entry, card snapshot, search, and refresh are implemented; 2D/3D graphs and split-view conversations remain.
4. **Controlled context actions:** drag-and-drop sends only a node ID and an intent; the Host validates it and writes visible, reversible Session Context.

The old Pro `/graph-memory-pro/neo4j-config` route returns connection details to the browser; the new implementation removes that security flaw. Pro Lite sends only a strictly validated, bounded `GraphSnapshot`, never a database path, Session ID, Bolt password, SQL, or unrestricted Cypher. Future write actions must preserve this Host boundary.

## OpenClaw compatibility

Existing OpenClaw users retain the original entry:

```bash
openclaw plugins install graph-memory
openclaw plugins enable graph-memory
openclaw gateway restart
```

The Context Engine slot must also be activated in `~/.openclaw/openclaw.json`; otherwise the package may appear installed without running the full ingestion and extraction pipeline:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "graph-memory"
    },
    "entries": {
      "graph-memory": {
        "enabled": true
      }
    }
  }
}
```

The Community memory core is host-neutral. DSH development does not require OpenClaw users to abandon their entry or data.

## Development

```bash
npm install
npm test
npm run build
npm pack
```

Release checks:

- tests and TypeScript build pass;
- tarball contains `dist/dsh.js` and `cordis.patch.yml`;
- no API keys, local databases, or environment files enter the repository;
- planned Pro features are never presented as shipped Community behavior.

## Current limitations

- Automatic extraction depends on auxiliary-model output stability. Use `gm_record` for critical beta knowledge.
- DSH does not yet expose `gm_update`; `gm_maintain` and `gm_retry_extraction` are native tools.
- Pro Lite currently has a read-only card client; 2D/3D, split view, and controlled drag-to-context are not implemented.
- npm registry publication is pending; install the current beta from a GitHub-built tarball.

## Privacy and security

- Memory remains in local SQLite by default.
- API keys come from host credentials or environment variables, not the database or Cordis patch.
- Recalled history is reference material; current user instructions always take precedence.
- Rotate any secret that has appeared in chat, logs, or screenshots.

## License

[MIT](LICENSE) © 2026 adoresever

See [docs/ATTRIBUTIONS.md](docs/ATTRIBUTIONS.md) for asset, logo, and trademark notes.
