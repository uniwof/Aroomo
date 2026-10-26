#!/bin/bash
# fresh.sh <repo> <port> <tag>：杀掉该端口的 wrangler，全新 state 启动，跑 seq.sh
REPO=$1; PORT=$2; TAG=$3; ST=/workspace/work/p1-rest/st-$TAG
pkill -f "wrangler dev --local --ip 127.0.0.1 --port $PORT" ; pkill -f "workerd.*$PORT"; sleep 2
rm -rf $ST $ST.log
bash /workspace/work/p1-1-fix/run_local.sh $REPO $PORT $ST >/dev/null
bash /workspace/work/p1-rest/seq.sh $PORT $TAG $REPO
