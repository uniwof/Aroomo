#!/bin/bash
# prodtest.sh <commit> <tag>：线上全测（test_live 含真实模型 + ui_test --round），用该提交的干净 worktree 里的测试脚本
O=/workspace/work/p1-rest/out/prod; mkdir -p $O; W=/workspace/work/p1-rest/prod-$1; cd $W || exit 1
export AGC_MCP_PYTHON=/workspace/work/p1-1-review/mcpenv/bin/python
if ! (python3 -c "import socket;socket.create_connection(('127.0.0.1',8899),1)" 2>/dev/null); then nohup setsid python3 localproxy.py >/tmp/lp.log 2>&1 </dev/null & sleep 2; fi
python3 test_live.py > $O/test_live_$2.txt 2>&1; echo "exit=$?" >> $O/test_live_$2.txt
AGC_SHOTS=/workspace/work/p1-rest/shots/prod-$2 python3 ui_test.py --round > $O/ui_test_$2.txt 2>&1; echo "exit=$?" >> $O/ui_test_$2.txt
touch $O/$2.done
