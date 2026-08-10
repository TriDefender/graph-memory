import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // 单 fork 串行：4 个集成测试文件共享同一 Neo4j 实例，
    // 并发跑 initSchema() 会导致 DDL 锁冲突（ForsetiClient deadlock）
    // 与 "equivalent index already exists" 错误
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
