#!/bin/bash
# backup_live.sh <tag>：把线上 ai-groupchat 脚本内容（multipart）下载到 storage 备份
T=$1; O=/workspace/storage/backups/aroomo-live/live-pre-$T.multipart
pgrep -f socks >/dev/null || { setsid bash /workspace/rb/socks/socks_start.sh --restart >/tmp/socks.log 2>&1 < /dev/null; sleep 3; }
bash /workspace/work/vltest/cfapi.sh https://api.cloudflare.com/client/v4/accounts/46166ff180d3b5542a1e79ca5ddd8d26/workers/scripts/ai-groupchat > $O
ls -la $O; grep -c "ChatStore" $O; cp $O /workspace/storage/backups/aroomo-p1-rest/ 
