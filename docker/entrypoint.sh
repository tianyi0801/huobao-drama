#!/bin/sh
# 容器入口：内置模板（prompts / skills / comfyui）的同步交给后端在工作目录内完成。
# 规则：模板版本变化时以内置为准覆盖同名 prompt / skill（用户新建目录保留），
# 覆盖前备份到 /app/data/workspace/.backup/，升级结果由前端启动后提示一次。
# 这里只保证数据目录存在，然后启动后端。
set -e

mkdir -p /app/data/workspace

cd /app/backend
exec node_modules/.bin/tsx src/index.ts
