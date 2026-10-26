#!/bin/bash
# redui2.sh <oldcommit> <port> <tag>：旧提交 worktree 起本机实例，用当前仓库的新 ui_test 打它（UI 红）
W=/workspace/work/p1-rest/prod-$1; ST=/workspace/work/p1-rest/st-redui-$3
pkill -f "port $2" ; sleep 2; rm -rf $ST
bash /workspace/work/p1-1-fix/run_local.sh $W $2 $ST >/dev/null
for i in $(seq 1 60); do curl -s -o /dev/null -m 3 http://127.0.0.1:$2/manifest.webmanifest && break; sleep 2; done
bash /workspace/work/p1-rest/red_ui.sh $2 $3
