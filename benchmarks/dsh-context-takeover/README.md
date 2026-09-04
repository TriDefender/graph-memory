# DSH context-takeover benchmark

<p align="center">
  <img src="../../docs/images/dsh-context-takeover-chart.svg" alt="Native DSH and Graph Memory context growth across 20 turns" width="100%">
</p>

This public benchmark measures two different questions separately:

1. **Context ownership:** how many tokens and messages reach the first main-model request of each turn?
2. **Real bill:** how many tokens are used by every main-model request, Graph Memory extraction, and embeddings?

The 20-turn scenario is a synthetic continuous-development task. It deliberately changes previously established facts so that a memory system must preserve the newest value and mark old values as revoked.

## Published V72 result

| Metric | DSH baseline | DSH + Graph Memory | Change |
|---|---:|---:|---:|
| First-request tokens, T01–T20 | 532,451 | 257,656 | **−51.61%** |
| First-request tokens, T20 | 56,998 | 16,769 | **−70.58%** |
| First-request messages, T20 | 171 | 24 | **−85.96%** |
| Main-agent tokens, all requests | 2,487,776 | 2,283,572 | −8.21% |
| All LLM tokens, including GM extraction | 2,487,776 | 2,386,292 | −4.08% |
| All measured tokens, including embeddings | 2,487,776 | 2,401,512 | −3.47% |

The baseline made 77 main-model requests; the Graph Memory arm made 123 main-model requests plus 20 extraction requests. Because tool loops are model-nondeterministic, first-request context is the direct context-takeover metric. The all-request totals remain visible to avoid overstating bill savings.

Memory checks from the same candidate:

- 20/20 scenario turns completed and their project tests passed.
- 19/20 structured graph extractions succeeded; one non-tool response failed closed.
- T20 model surface contained 24 messages instead of 171.
- A fresh session recalled the final owner, port, rollback window, incident, batch, repair command, and revoked values without an explicit memory tool call.

The complete, de-identified aggregates are in [`results/v72-summary.json`](results/v72-summary.json).

<p align="center">
  <img src="../../docs/images/dsh/vector-cross-session-recall.png" alt="Cross-session source-backed recall in a fresh DSH session" width="88%">
</p>

## Files

- `scenario-20.json` — the synthetic workload.
- `scripts/run-scenario.mjs` — runs one configured DSH arm without embedding credentials in source.
- `scripts/dsh-usage-tap.mjs` — a DSH plugin that records request usage and request kind.
- `scripts/summarize.mjs` — recalculates the public comparison from two JSONL ledgers.
- `results/v72-summary.json` — published aggregate and per-turn first-request data.

Raw conversations, local profile databases, provider responses, API keys, absolute paths, and user session data are intentionally excluded.

## Recalculate a result

Export two JSONL ledgers from equivalent baseline and Graph Memory runs, then execute:

```bash
node benchmarks/dsh-context-takeover/scripts/summarize.mjs \
  path/to/baseline-usage.jsonl \
  path/to/graph-memory-usage.jsonl
```

The runner adds a non-semantic `[BENCHMARK_TURN=Txx]` marker so the usage tap can group tool-loop requests without guessing turn boundaries. It stores response hashes and byte counts, not response bodies. Configure the tap in a local DSH patch:

```yaml
- insert:
    - id: benchmark-dsh-usage-tap
      name: /absolute/path/to/benchmarks/dsh-context-takeover/scripts/dsh-usage-tap.mjs
```

Provider URL, model name, and credentials belong in local environment/configuration. Do not commit them. The original run used a private OpenAI-compatible relay for `GLM-5.2` and a separate OpenAI-compatible embedding provider; the public results do not depend on publishing either credential.

Run one arm against an already configured DSH home and workspace:

```bash
export BENCHMARK_DSH_REPO=/path/to/deepseek-harness
export BENCHMARK_DSH_HOME=/path/to/disposable-dsh-home
export BENCHMARK_WORKSPACE=/path/to/disposable-fixture
export BENCHMARK_PATCHES=/path/to/usage-tap.yml:/path/to/graph-memory.yml
export BENCHMARK_PROVIDER=your-provider-id
export BENCHMARK_MODEL=your-model-id
export BENCHMARK_RUN_ID=gm-run-01
node benchmarks/dsh-context-takeover/scripts/run-scenario.mjs
```

Use separate fresh homes and workspaces for baseline and Graph Memory arms. The local DSH settings file should reference credentials through environment-variable names. `BENCHMARK_PATCHES` uses the operating system path delimiter (`:` on Linux/macOS, `;` on Windows).

## Interpretation

This is an engineering workload, not LoCoMo or LongMemEval. It proves that the DSH adapter bounds model-visible history and that a fresh session can recover selected old facts. It does not claim universal savings, a benchmark-wide recall score, or perfect extraction reliability.
