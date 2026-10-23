#!/bin/bash
# 把 data/chapters.sql 导入 D1（919 章原文）
set -e
cd "$(dirname "$0")"
echo ">>> $(date '+%H:%M:%S') 导入 chapters"
wrangler d1 execute guaxiang --remote --file=data/chapters.sql --yes
echo ">>> $(date '+%H:%M:%S') 完成"
