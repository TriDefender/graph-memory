#!/usr/bin/env python3
"""
graph-memory-pro 迁移回滚脚本

回滚 v1.x → v2.0 迁移：
  1) 还原 openclaw.json（从 .backup.* 或 graph-memory-pro 写入前的备份）
  2) 重新启用旧 graph-memory 插件（禁用 graph-memory-pro）
  3) 验证旧 SQLite DB 仍可用（不删除，仅校验）

Neo4j 中的数据不会被删除（保留以备再次迁移）。
若要完全清理 Neo4j 数据：手动运行
  ~/.graph-memory-pro/neo4j/bin/cypher-shell -u neo4j -p '...' \
    "MATCH (n) DETACH DELETE n"

用法:
  python3 rollback.py                          # 交互式
  python3 rollback.py --config ~/.openclaw/openclaw.json
  python3 rollback.py --config ...json --old-plugin graph-memory
  python3 rollback.py --dry-run                # 只展示
"""

import json
import os
import shutil
import sqlite3
import sys
from pathlib import Path


def find_latest_backup(config_path):
    backups = sorted(Path(config_path).parent.glob(f"{Path(config_path).name}.backup.*"),
                     key=lambda p: p.stat().st_mtime, reverse=True)
    return backups[0] if backups else None


def restore_config(config_path, dry_run=False):
    if not os.path.exists(config_path):
        print(f"[ERR] 配置文件不存在 / config not found: {config_path}")
        return False

    backup = find_latest_backup(config_path)
    if not backup:
        print(f"[ERR] 找不到 {config_path} 的备份 / no backup found")
        print(f"      尝试手动编辑：禁用 graph-memory-pro，启用 graph-memory")
        return False

    print(f"[1/3] 还原配置 / Restore config from backup:")
    print(f"  备份 / backup: {backup}")
    print(f"  当前 / current: {config_path}")

    if dry_run:
        print(f"  [DRY] 将执行: cp {backup} {config_path}")
        return True

    # 时间戳备份当前（graph-memory-pro 配置）
    ts = Path(config_path).name + ".before-rollback"
    pre_backup = Path(config_path).parent / f"{ts}.{os.path.getmtime(config_path):.0f}"
    shutil.copy2(config_path, pre_backup)
    print(f"  当前配置已另存 / pre-rollback snapshot: {pre_backup}")

    shutil.copy2(backup, config_path)
    print(f"  已还原 / restored")
    return True


def disable_new_enable_old(config_path, new_id="graph-memory-pro", old_id="graph-memory", dry_run=False):
    if not os.path.exists(config_path):
        return False

    print(f"\n[2/3] 调整插件启用状态 / Toggle plugin enable flags:")
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    entries = cfg.get("plugins", {}).get("entries", {})
    slots = cfg.get("plugins", {}).get("slots", {})

    changed = []
    if new_id in entries:
        old_val = entries[new_id].get("enabled", True)
        entries[new_id]["enabled"] = False
        changed.append(f"{new_id}.enabled: {old_val} -> False")
    if old_id in entries:
        old_val = entries[old_id].get("enabled", False)
        entries[old_id]["enabled"] = True
        changed.append(f"{old_id}.enabled: {old_val} -> True")

    if slots.get("contextEngine") == new_id:
        old_slot = slots["contextEngine"]
        slots["contextEngine"] = old_id
        changed.append(f"slots.contextEngine: {old_slot} -> {old_id}")

    if not changed:
        print("  无需调整 / nothing to change")
        return True

    for c in changed:
        print(f"  {c}")

    if dry_run:
        print("  [DRY] 将写入配置文件 / would write config")
        return True

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print(f"  已写入 / written: {config_path}")
    return True


def verify_sqlite(sqlite_path, dry_run=False):
    print(f"\n[3/3] 校验旧 SQLite DB / Verify legacy SQLite DB:")
    if not sqlite_path:
        # 自动探测默认位置
        candidates = [
            os.path.expanduser("~/.openclaw/graph-memory.db"),
            os.path.expanduser("~/.openclaw/extensions/graph-memory/graph-memory.db"),
        ]
        sqlite_path = next((p for p in candidates if os.path.exists(p)), None)
    if not sqlite_path or not os.path.exists(sqlite_path):
        print(f"  跳过：找不到 SQLite DB / skip: SQLite DB not found")
        return True

    print(f"  路径 / path: {sqlite_path}")
    if dry_run:
        print("  [DRY] 将校验 / would verify")
        return True

    try:
        conn = sqlite3.connect(f"file:{sqlite_path}?mode=ro", uri=True)
        for table in ["gm_nodes", "gm_edges", "gm_communities", "gm_messages"]:
            try:
                c = conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
                print(f"  {table}: {c} rows")
            except sqlite3.OperationalError:
                print(f"  {table}: (not found / 已迁移或不存在)")
        conn.close()
        print(f"  SQLite DB 可读 / readable")
        return True
    except Exception as e:
        print(f"  [ERR] SQLite 校验失败 / verify failed: {e}")
        return False


def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    args = [a for a in args if not a.startswith("--")]

    config_path = os.path.expanduser(args[0]) if args else os.path.expanduser("~/.openclaw/openclaw.json")
    old_plugin = "graph-memory"

    print("=" * 60)
    print("  graph-memory-pro 迁移回滚 / Migration rollback")
    print("=" * 60)
    print(f"  配置 / config: {config_path}")
    print(f"  旧插件 / old plugin: {old_plugin}")
    if dry_run:
        print("  ⚡ DRY-RUN 模式 / mode")
    print("")

    ok = True
    ok &= restore_config(config_path, dry_run)
    ok &= disable_new_enable_old(config_path, "graph-memory-pro", old_plugin, dry_run)
    ok &= verify_sqlite(None, dry_run)

    print("\n" + "=" * 60)
    if ok:
        print("  ✅ 回滚完成 / Rollback done")
        print("  重启 OpenClaw gateway 生效 / restart to take effect:")
        print("    openclaw gateway restart")
        print("")
        print("  注意 / note: Neo4j 数据未清理 / Neo4j data retained")
        print("  若要彻底清理 / to wipe Neo4j:")
        print(f"    ~/.graph-memory-pro/neo4j/bin/cypher-shell -u neo4j -p '...' \\")
        print('      "MATCH (n) DETACH DELETE n"')
    else:
        print("  ⚠️  回滚未完全成功 / rollback incomplete（查看上方日志 / see logs above）")
        sys.exit(1)


if __name__ == "__main__":
    main()
