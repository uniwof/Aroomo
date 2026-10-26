#!/bin/bash
# rollback.sh <commit>  —— 把线上 ai-groupchat 回滚到某个提交（默认 003dee5）；沿用 P1-1 部署方式
C=${1:-003dee5}; W=/workspace/work/p1-rest/prod-$C
cd /workspace/projects-src/ai-groupchat && [ -d $W ] || git worktree add -f $W $C
setsid bash /workspace/rb/socks/socks_start.sh --restart >/tmp/socks.log 2>&1 < /dev/null; sleep 3
cd $W && AGC_SRC=$W python3 /workspace/work/p1-rest/deploy_prod.py upload
