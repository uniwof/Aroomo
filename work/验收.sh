#!/bin/bash
# Aroomo 线上验收（P1-3 点子库 + P1-4 主持模式 + P1-5 主负责人代收 + P1-6 额度保险/发件箱）
# 注意：线上全测一轮会消耗大量 Durable Object 免费请求（10 万次/天，UTC 0 点重置）。先看 /api/usage，用量 >50% 时不要跑线上全测。
# 用法：bash /workspace/work/p1-rest/验收.sh            → 线上全测（test_live 含真实模型 + ui_test --round），约 8 分钟
#       bash /workspace/work/p1-rest/验收.sh local      → 本机 fresh wrangler dev --local 全测（--no-ai）
#       bash /workspace/work/p1-rest/验收.sh usage      → 只看线上今日用量（Worker / Durable Object 请求数），1 个请求
set -u
C=$(cd /workspace/projects-src/ai-groupchat && git rev-parse --short HEAD)
if [ "${1:-}" = "local" ]; then
  bash /workspace/work/p1-rest/fresh.sh /workspace/projects-src/ai-groupchat 8792 accept
  O=/workspace/work/p1-rest/out; grep -h "结果" $O/unit_accept.txt $O/test_live_accept.txt; grep "UI 结果" $O/ui_test_accept.txt
elif [ "${1:-}" = "usage" ]; then
  T=$(python3 -c "import json;print(json.load(open('/workspace/storage/secrets/ai-groupchat.json'))['ACCESS_TOKEN'])"); curl -s -m 20 -x http://127.0.0.1:8899 -H "Authorization: Bearer $T" https://chat.pcmanai.com/api/usage; echo
else
  cd /workspace/projects-src/ai-groupchat && [ -d /workspace/work/p1-rest/prod-$C ] || git worktree add -f /workspace/work/p1-rest/prod-$C $C
  bash /workspace/work/p1-rest/prodtest.sh $C accept
  O=/workspace/work/p1-rest/out/prod; grep "结果" $O/test_live_accept.txt; grep "UI 结果" $O/ui_test_accept.txt
fi
