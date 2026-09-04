# Graph Memory

<p align="center">
  <img src="docs/images/deepseek-harness-wordmark.svg" alt="DeepSeek Harness" width="310">
</p>

<p align="center">
  <strong>接管模型可见历史，让上下文停止膨胀，让记忆继续生长。</strong><br>
  Graph Memory 原生接入 DeepSeek Harness：最近轮次留在上下文，旧历史进入可检索图记忆；同时继续兼容 OpenClaw。
</p>

<p align="center">
  <img src="docs/images/brand/openclaw-wordmark.svg" alt="Compatible with OpenClaw" width="118"><br>
  <sub>同一记忆内核 · OpenClaw Context Engine 入口继续维护</sub>
</p>

<p align="center">
  <a href="https://www.dsh.so/zh/artifact/graph-memory"><img src="https://www.dsh.so/badge/graph-memory.svg" alt="dsh.so 安全徽章"></a>
  <a href="https://www.dsh.so/zh/artifact/graph-memory"><img src="https://www.dsh.so/badge/install/graph-memory.svg" alt="dsh.so 安装徽章"></a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#核心优势">核心优势</a> ·
  <a href="#图记忆架构">图架构</a> ·
  <a href="#安装到-deepseek-harness">DSH 安装</a> ·
  <a href="#graph-memory-pro如何作为-dsh-插件集成">Pro 插件</a> ·
  <a href="docs/DSH_NATIVE_PLAN.md">技术报告</a>
</p>

Graph Memory 不是聊天记录归档器，也不是把所有历史重新塞回上下文。它把对话中的任务、技能、事件和因果关系沉淀为类型化知识图谱，在新问题出现时只召回相关的局部子图。

| 用户最先需要知道的事 | Graph Memory 的做法 |
|---|---|
| 当前长对话会不会继续爆炸？ | 默认只保留最近 5 个已完成用户轮次；更早模型表面被固定归档标记替换。 |
| 旧事实会不会跟着丢失？ | 不会删除原始事件；按当前问题召回图节点及其精确来源问答。 |
| 是否要修改 DSH？ | 不需要。它通过 Cordis 插件生命周期和 DSH 公共上下文协议接入。 |

<p align="center">
  <img src="docs/images/dsh-context-takeover-chart.svg" alt="DSH 20 轮首请求上下文 Token 对比" width="96%">
</p>

> 真实 20 轮工程任务中，T20 首请求从 56,998 降至 16,769 Token（−70.58%），消息数从 171 降至 24。20 轮首请求累计下降 51.61%；计入主 Agent 的随机工具循环、Graph Memory 维护和 Embedding 后，总量下降 3.47%。[查看完整口径与限制](docs/GRAPH_MEMORY_README_REPORT.html) · [复跑脱敏基准](benchmarks/dsh-context-takeover/README.md)

## 核心优势

### 一套内核，两个原生宿主入口

- **DeepSeek Harness**：通过 Cordis 生命周期接入 Session、Tool、Agent Loop、Prompt Assembly、LLM 与 Credentials；不修改 DSH 核心源码。
- **OpenClaw**：保留原有 Context Engine 插件入口、配置方式和数据能力。
- **共享内核**：抽取、SQLite 存储、FTS5、向量检索、社区发现、PageRank 和上下文组装不绑定单一宿主。

### 把历史变成可复用知识

- 跨 Session 召回，宿主重启后仍然保留。
- `TASK`、`SKILL`、`EVENT` 三类节点表达目标、方法、结果、错误与决策。
- 通用 `RELATES` 边以对话中抽取的自然语言谓词连接主题概念；旧的 `USED_SKILL`、`SOLVED_BY` 等关系继续兼容已有 Agent 记忆。
- 节点关联原始会话证据，能够解释“这条记忆从哪里来、为什么被召回”。

### 只把相关知识送进上下文

- 默认保留前序最近 5 个已完成轮次的原始问题与最终可见回答，再加入当前问题；可通过 `freshTurnCount` 配置。
- 通过 DSH 公共 surface replacement 与 token-meter shadow-price 协议，把更早历史替换为固定大小的归档标记；不调用 DSH 压缩模型，持久化原始事件不删除。
- 知识节点与精确原消息来源建立关联；按当前问题同时召回同 Session 已归档记忆和跨 Session 记忆。
- 查询路径：向量按当前问题排序；Embedding 不可用时使用 FTS5。
- 只保留 Top-K 直接命中节点及它们之间已有的边，不用社区中心度改写相关性顺序。
- 只注入按本轮问题排序后的同会话旧记忆/跨会话记忆；原始问答作为不可截断的完整证据加载，Token 计量交给宿主和模型服务。
- 自动注入与 `gm_search` 共享同一套向量/FTS 排序。余弦分数会随 embedding 模型变化，因此 `semanticScoreThreshold` 只作为可选、需校准的统一阈值；默认按 Top-K 返回。
- 查询阶段不再用 PageRank 重排语义命中，避免图中心节点挤掉最相关记忆；PageRank 仅保留为离线图维护统计。
- 召回内容被标记为不可信参考材料，不能覆盖当前用户指令。

### 本地优先，向量能力可选

- Community 默认使用 SQLite，无需部署独立图数据库。
- 未配置 Embedding 时自动使用 FTS5，不阻断对话。
- 支持 OpenAI-compatible Embedding 接口，可接 DashScope、OpenAI 或本地服务。
- `gm_status` 显示数据库、节点、边、检索模式、向量覆盖率和维度。

### 限定场景下的 Token 实测

旧版 OpenClaw 入口曾在“安装 bilibili-mcp → 登录 → 查询”的 7 轮连续任务中进行对照测试：

<p align="center">
  <img src="docs/images/token-comparison.png" alt="7 轮任务 Token 对照" width="82%">
</p>

| 轮次 | 无 Graph Memory | 有 Graph Memory |
|---|---:|---:|
| R1 | 14,957 | 14,957 |
| R4 | 81,632 | 29,175 |
| R7 | **95,187** | **23,977** |

该场景第 7 轮减少约 **75%** Token。它是一个特定工作流的对照结果，不代表所有任务都有固定压缩比例；核心机制是用相关知识子图替代无差别历史回放。

## 项目发展

Graph Memory 的方向没有因为新宿主而推倒重来。项目正在从“OpenClaw 上的记忆插件”，发展为“可被不同 Agent Harness 原生加载的图记忆内核”。

| 阶段 | 交付内容 | 状态 |
|---|---|---|
| OpenClaw 起点 | Context Engine、跨会话图记忆、向量/FTS5 召回 | 保持兼容 |
| Community 图引擎 | SQLite、FTS5、向量、图排序、溯源 | 可使用 |
| DeepSeek Harness | Cordis 适配器、原生工具、自动召回、Credentials | 已完成并实测 |
| Graph Memory Pro | 可视化图工作台、受控拖拽、Neo4j 可选适配器 | Pro Lite 只读 Host + Client 已实现；2D/3D 与拖拽待实现 |

2026 年 3 月 15 日，项目负责人在清华科技园举办的 CLAW 蜕壳计划活动中分享了 Graph Memory 的架构思路。以下为项目负责人提供的现场材料与[新浪财经活动报道](https://cj.sina.com.cn/articles/view/7984421895/1dbe89c0700101nnpq)。

<p align="center">
  <img src="docs/images/history/tsinghua-sharing.jpg" alt="Graph Memory 技术分享现场" width="47%">
  <img src="docs/images/history/sina-report.jpg" alt="新浪财经活动报道截图" width="28%">
</p>

- [开源版跨会话记忆演示](https://www.bilibili.com/video/BV1xUcZzfEaB/)
- [Graph Memory Pro 技术分享](https://www.bilibili.com/video/BV1KwwzzGEvD/)

下图是既有 OpenClaw / ClawX 阶段的 Pro 图谱原型，用于说明已经验证过的图交互方向；它不是当前 DSH 版本已经交付的前端。

<p align="center">
  <img src="docs/images/graph-ui.png" alt="Graph Memory Pro 既有图谱原型" width="92%">
</p>

相关名称与现场信息仅用于项目履历记录，不表示清华大学、新浪财经、DeepSeek 或 OpenClaw 对本项目提供官方背书。

## 图记忆架构

### 类型化知识图谱

```text
TASK   ──USED_SKILL──▶ SKILL
TASK   ──SOLVED_BY───▶ EVENT
SKILL  ──REQUIRES────▶ SKILL
EVENT  ──PATCHES─────▶ SKILL
SKILL  ──CONFLICTS_WITH──▶ SKILL
```

- **TASK**：做过什么，包含目标、过程和结果。
- **SKILL**：经过验证、可以复用的方法或能力。
- **EVENT**：错误、修复、决策、变化和关键事实。
- **Episodic provenance**：图节点关联原始 user / assistant 片段，保留形成知识时的语境。

### 查询优先召回

```mermaid
flowchart LR
  Q[当前问题] --> VECTOR[向量排序]
  Q --> FTS[FTS5 降级]
  VECTOR --> TOPK[相关 Top-K 节点]
  FTS --> TOPK
  TOPK --> EDGES[选中节点之间的边]
  TOPK --> SOURCE[精确来源问答]
  EDGES --> CONTEXT[原子记忆包]
  SOURCE --> CONTEXT
```

同一张图会根据当前问题产生不同的向量排序。查询 Docker 时，Docker 相关记忆靠前；查询 Conda 时，环境管理相关记忆靠前。PageRank 和社区仍用于离线维护与观察，不再覆盖查询相关性。

### 宿主数据流

```mermaid
flowchart LR
  USER[用户消息] --> SESSION[宿主 Session Events]
  SESSION --> ADAPTER[Host Adapter]
  ADAPTER --> EXTRACT[结构化抽取]
  EXTRACT --> GRAPH[(SQLite / FTS5 / Vectors)]
  USER --> RECALL[语义 + 全文召回]
  GRAPH --> RECALL
  RECALL --> PROMPT[图谱 + 精确来源问答]
  PROMPT --> LOOP[Agent Loop]
  CREDS[Host Credentials] --> ADAPTER
  TOOLS[gm_* Tools] --> ADAPTER
```

```text
graph-memory/
├── dsh.ts                 # DeepSeek Harness / Cordis 适配器
├── index.ts               # OpenClaw 适配器
├── cordis.patch.yml       # DSH Bundle 安装入口
└── src/
    ├── extractor/         # 对话 → TASK / SKILL / EVENT
    ├── recaller/          # 查询优先的向量 / FTS5 召回
    ├── graph/             # 离线 PageRank 与社区检测
    ├── store/             # SQLite schema 与查询
    ├── format/            # 安全上下文组装
    └── engine/            # LLM / Embedding provider
```

## DeepSeek Harness 原生适配状态

| 能力 | 状态 | 说明 |
|---|---|---|
| Cordis 原生加载 | **已完成** | 使用插件生命周期，无需 fork DSH |
| 滚动上下文接管 | **已完成** | 最近 N 轮可配置，更早表面历史替换为 archive marker |
| 跨会话自动召回 | **已完成** | 首次模型请求前注入，并等待 Embedding 初始化完成 |
| 显式记录与搜索 | **已完成** | `gm_record`、`gm_search` |
| 向量回填与模型迁移 | **已完成** | 追踪模型、维度与 fingerprint |
| 插件状态可见 | **已完成** | 设置页 Plugin Inventory 显示 active |
| Pro 可视化工作台 | **实验版可用** | 独立 DSH Client Plugin，当前为只读卡片式快照 |

当前 beta：`1.6.0-beta.12`。当前候选通过 20 个测试文件中的 123 项自动化测试、两套 TypeScript 构建和 npm dry-run 打包；另在最新官方 DSH `0.1.3-alpha.1`（`d347e70390`）完成全新 profile 的 tarball 安装、配置展开和实际启动。GLM-5.2 的真实 20 轮运行验证了可配置最近 5 轮上下文接管、每轮工具轨迹投影、精确来源绑定、查询优先的向量/FTS 召回、失败隔离，以及无需显式记忆工具的跨会话召回。20 轮首请求上下文累计从 532,451 降至 257,656 Token（下降 51.61%），T20 从 56,998 降至 16,769（下降 70.58%）。20 次结构化抽取中 19 次成功；失败轮次被隔离，没有修补或写入坏数据。完整证据与限制见 [`docs/GRAPH_MEMORY_README_REPORT.html`](docs/GRAPH_MEMORY_README_REPORT.html)。

<p align="center">
  <strong>插件已启用：graph-memory/dsh 在 DSH 插件列表中处于 active</strong><br>
  <img src="docs/images/dsh/plugin-inventory-active.png" alt="DSH 插件列表中的 Graph Memory" width="88%">
</p>

<p align="center">
  <strong>跨会话语义召回：新 Session 召回上一 Session 的知识</strong><br>
  <img src="docs/images/dsh/vector-cross-session-recall.png" alt="DSH 跨会话向量召回" width="88%">
</p>

## 安装到 DeepSeek Harness

前置条件：Node.js `22.13+`。当前 beta 尚未发布到 npm，但仓库已经包含预构建运行产物，可以直接安装且不需要授权安装脚本：

```bash
npx @deepseek-ai/dsh plugin --profile web add github:adoresever/graph-memory
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

也可以从 checkout 构建并安装 tarball：

```bash
git clone https://github.com/adoresever/graph-memory.git
cd graph-memory
npm install
npm test
npm pack
npx @deepseek-ai/dsh plugin --profile web add /absolute/path/to/graph-memory-1.6.0-beta.12.tgz
```

安装后，在 **设置 → 插件 → 插件列表 → graph-memory/dsh** 中确认状态为“已启用”。默认数据库路径：

```text
$DSH_HOME/graph-memory/graph-memory.db
# 未设置 DSH_HOME 时通常为：
~/.dsh/graph-memory/graph-memory.db
```

### 配置向量检索

不要把 API key 发送到聊天框。DSH 配置只保存凭据引用，真实密钥由 Credentials 服务解析。DashScope 示例：

```bash
export GRAPH_MEMORY_EMBEDDING_API_KEY='replace-with-your-key'
export GRAPH_MEMORY_EMBEDDING_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
export GRAPH_MEMORY_EMBEDDING_MODEL='text-embedding-v4'
export GRAPH_MEMORY_EMBEDDING_DIMENSIONS='1024'
dsh web
```

未配置 Embedding 时会自动使用 FTS5。

<p align="center">
  <img src="docs/images/dsh/vector-status.png" alt="Graph Memory 向量状态" width="78%">
</p>

### 原始消息保留策略（显式启用）

DSH 上下文压缩与 SQLite 数据保留是两件事：压缩只限制模型表面上下文，不会自动删除 `gm_messages` 中的溯源证据。默认策略是 `keep: all`，因此升级不会删除任何现有数据。

数据库较大时，可在 `graph-memory/dsh` 配置中加入 `messageRetention`。第一次必须先使用 dry-run：

```yaml
messageRetention:
  keep: referenced
  recentTurns: 20
  retentionDays: 30
  batchSize: 500
  dryRun: true
```

- `all`：保留全部持久事件，默认值。
- `referenced`：只清理已经抽取且没有 `gm_node_sources` 引用的消息；可叠加最近轮次/天数保护窗口。
- `recent`：必须配置 `recentTurns` 或 `retentionDays`；仍然无条件保护来源引用和待抽取消息。

`recentTurns` 按每个 Session 的真实用户轮次计算，并保留后续 assistant/tool 事件。两个窗口同时存在时，只有同时超出两个窗口的消息才有资格清理；时间戳异常的消息会保守保留。每次维护只执行一个有上限的事务，删除前再次检查来源引用，不会自动执行 `VACUUM`。

启用真实删除前，请备份 `$DSH_HOME/graph-memory/graph-memory.db`，保持 `dryRun: true`，调用一次 `gm_maintain` 并检查 `gm_stats` 回执；候选范围符合预期后再改为 `false`。

### DSH 原生工具

默认 `assistantTools: none` 不增加任何模型工具 schema，自动召回不依赖工具调用。需要主动深搜时设置 `search` 暴露 `gm_search`；维护时可临时设置 `all` 暴露下表全部工具。

| 工具 | 作用 |
|---|---|
| `gm_status` | 查看插件、数据库、抽取、召回、向量和保留策略状态 |
| `gm_search` | 主动搜索长期知识图谱 |
| `gm_record` | 确定性记录 TASK、SKILL 或 EVENT |
| `gm_stats` | 查看图谱、原始消息和保留策略回执/统计 |
| `gm_maintain` | 执行一次有界图维护与已配置的消息保留批次 |
| `gm_retry_extraction` | 将隔离的抽取失败消息重新入队，不删除或截断原始对话 |

DSH 每个已完成轮次只产生一个抽取任务，输入严格为该轮的用户原始问题和最终可见回答。推理、工具调用和工具结果不会进入抽取模型，也不会按字符或消息数量拆分。适配器不设置默认输出 Token 上限、不自动重试；不完整或失败的结果进入 `quarantined`，由 `gm_retry_extraction` 显式恢复。

抽取是独立的后台负载，可以使用专用 DSH 模型路由。设置
`GRAPH_MEMORY_LLM_PROVIDER` 与 `GRAPH_MEMORY_LLM_MODEL` 后，该路由优先于前台
Agent 模型。所选 DSH provider/model 明确声明支持时，可设置
`GRAPH_MEMORY_LLM_REASONING_EFFORT=off`；需要显式响应上限时可设置
`GRAPH_MEMORY_LLM_MAX_TOKENS`。不支持的 reasoning 控制会明确失败，不会静默改变
provider 行为。

自动召回不要求模型主动调用 `gm_search`；适配器会在 Prompt Assembly 阶段检索并注入相关记忆。

## Graph Memory Pro：如何作为 DSH 插件集成

### 结论

**旧 `desktop-2.0` Pro 不能直接安装到 DSH，但新的 Pro Lite 已经作为独立 DSH 插件实现最小可用闭环。** 旧分支是 OpenClaw + Neo4j 实现，绑定 `openclaw/plugin-sdk`、OpenClaw Gateway Route 和旧 ClawX 交互方向。新实现位于 `dsh-pro/`：Host 读取 Community SQLite，Typed Remote 只提供受限快照，Client 在 DSH Web 侧边栏注册只读入口。Neo4j、GDS、APOC 和旧 CRUD 后端仍可在后续作为可选适配器迁移。

目标不是再做一个独立产品，而是把 Pro 作为 Graph Memory 的可选增强插件：

```mermaid
flowchart LR
  CORE[Graph Memory Core] --> STORE[GraphStore]
  STORE --> SQLITE[SQLite 默认]
  STORE --> NEO[Neo4j 可选]
  CORE --> HOST[DSH Host Plugin]
  HOST --> API[Typed Remote API]
  API --> CLIENT[DSH Client Plugin]
  CLIENT --> WORKBENCH[对话 / 图谱分屏]
  WORKBENCH --> DRAG[受控拖拽到上下文]
```

### 推荐包结构

```text
graph-memory                         # Community：当前原生 Host Plugin
graph-memory-pro-dsh                # Pro Lite：Host + Client Plugin（本地 beta）
@adoresever/graph-memory-store-neo4j # 可选大图存储适配器（待实现）
```

第一版优先做 **Pro Lite**：继续读取现有 SQLite 图数据，只增加 DSH 图谱工作台。这样用户不需要安装 Neo4j。Neo4j 作为可选适配器，面向更大图谱、GDS 与复杂分析。**这是规划中的目标架构；现有 `desktop-2.0` Pro 仍是 Neo4j-only，尚未实现 SQLite / Neo4j 可切换的 `GraphStore`。**

### 当前本地安装方式

当前 npm 上的 `graph-memory@1.5.8` 仍是 OpenClaw 包，新的 Community beta 与 `graph-memory-pro-dsh` 尚未发布到 npm。Community 可以直接从 GitHub 安装，Pro Lite 仍从 checkout 安装：

```bash
dsh plugin --profile web add \
  git+https://github.com/adoresever/graph-memory.git

dsh plugin --profile web add \
  /absolute/path/to/graph-memory/dsh-pro

dsh web
```

两个插件默认共用 `~/.dsh/graph-memory/graph-memory.db`。当前入口提供受限 SQLite `GraphSnapshot`、`gm_graph_snapshot`、`gm_graph_node`、Typed Remote，以及侧边栏只读快照/搜索界面；尚无 2D/3D renderer、完整分屏、拖拽写入和节点编辑。

### 必须改造的四层

1. **Core contract**：SQLite `GraphSnapshot` 与受限节点详情已经落地；Neo4j provider 和统一可写契约待实现。
2. **Host Plugin**：Pro Lite Host、两个受限工具和只读 Typed Remote 已落地；可写动作与更细权限策略待实现。
3. **Client Plugin**：DSH 侧栏入口、卡片式快照、搜索与刷新已落地；2D/3D 图谱和对话分屏待实现。
4. **受控上下文操作**：拖拽只提交节点 ID 与动作意图；Host 校验后把内容写入可见、可撤销的 Session Context。

旧 Pro 的 `/graph-memory-pro/neo4j-config` 会把连接信息返回浏览器，这是已经在新实现中消除的安全问题。当前 Pro Lite 的浏览器只获取经过严格校验和裁剪的 `GraphSnapshot`，不会接收数据库路径、Session ID、Bolt 密码、SQL 或任意 Cypher。后续可写动作也必须保持这条 Host 权限边界。

## OpenClaw 兼容

OpenClaw 用户继续使用原入口：

```bash
openclaw plugins install graph-memory
openclaw plugins enable graph-memory
openclaw gateway restart
```

还必须在 `~/.openclaw/openclaw.json` 激活 Context Engine，否则插件可能显示已安装，但不会进入完整的消息摄取与抽取管线：

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

现有 Context Engine 配置和数据能力继续保留。DSH 是新增的原生宿主入口，不要求 OpenClaw 用户迁移或放弃现有工作流。

## 开发与验证

```bash
npm install
npm test
npm run build
npm pack
```

发布前必须确认：测试与 TypeScript 构建通过；tarball 包含 `dist/dsh.js` 与 `cordis.patch.yml`；仓库不存在 API key、本地数据库和环境文件；文档不把 Pro 路线图写成已完成功能。

## 当前限制

- 自动抽取依赖辅助模型输出稳定性；关键知识在 beta 阶段建议使用 `gm_record`。
- DSH 版暂未提供 `gm_update`；`gm_maintain` 与 `gm_retry_extraction` 已作为原生工具提供。
- Pro Lite 目前只有只读卡片式 Client；2D/3D、分屏和受控拖拽尚未实现。
- npm registry 发布尚未完成，当前使用 GitHub 源码 tarball 安装。

## 隐私与安全

- 数据默认保存在本机 SQLite。
- API key 通过宿主凭据或环境变量注入，不写入数据库和 Cordis patch。
- 召回历史只作为参考；当前用户指令始终拥有更高优先级。
- 曾出现在聊天、日志或截图中的密钥应立即轮换。

## 许可证

[MIT](LICENSE) © 2026 adoresever

素材来源、Logo 与商标说明见 [docs/ATTRIBUTIONS.md](docs/ATTRIBUTIONS.md)。
