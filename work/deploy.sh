#!/bin/bash
# deploy.sh <commit>：把某个提交（干净 worktree）部署到线上 ai-groupchat；回滚 = 部署旧提交
C=${1:-003dee5}; W=/workspace/work/p1-rest/prod-$C
cd /workspace/projects-src/ai-groupchat && [ -d $W ] || git worktree add -f $W $C
setsid bash /workspace/rb/socks/socks_start.sh --restart >/tmp/socks.log 2>&1 < /dev/null; sleep 3
cd $W && AGC_SRC=$W python3 /workspace/work/p1-rest/deploy_prod.py upload
