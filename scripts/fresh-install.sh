#!/usr/bin/env bash
# 从零安装自检：把当前提交克隆到临时目录，按 README「快速开始」的顺序执行，每一步断言真的成功。
# 会用本机已登录的 claude 做一次真实路由判断（只判断、不送达，不开 iTerm 标签页）。
# 用法: scripts/fresh-install.sh [--keep]   （--keep 保留临时克隆便于排查）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jev-fresh-XXXXXX")"
CLONE="${TMP}/jev-task-router"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1"; }
cleanup() { [ "${1:-}" = "--keep" ] && echo "保留 ${TMP}" || rm -rf "${TMP}"; }
trap 'cleanup "${KEEP:-}"' EXIT
[ "${1:-}" = "--keep" ] && KEEP=--keep

# 1. 只含已提交内容的干净克隆
if git clone -q --no-hardlinks "${ROOT}" "${CLONE}" && git -C "${CLONE}" checkout -q "$(git -C "${ROOT}" rev-parse HEAD)"; then
  ok "克隆 $(git -C "${CLONE}" rev-parse --short HEAD)"
else
  bad "克隆失败"; exit 1
fi
cd "${CLONE}" || exit 1

# 2. 前置条件
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "${NODE_MAJOR}" -ge 24 ] && ok "Node $(node -v)（要求 ≥ 24）" || bad "Node 版本过低：$(node -v 2>/dev/null)"
command -v claude >/dev/null 2>&1 && ok "claude 在 PATH 中" || bad "PATH 里没有 claude"

# 3. 安装
if npm ci --no-audit --no-fund >"${TMP}/npm-ci.log" 2>&1; then ok "npm ci"; else bad "npm ci（见 ${TMP}/npm-ci.log）"; tail -20 "${TMP}/npm-ci.log"; exit 1; fi
[ -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ] && ok "Electron 已下载" || bad "Electron 二进制缺失"

# 4. 离线检查
if npm test >"${TMP}/test.log" 2>&1; then ok "npm test（类型检查 + 全部离线契约）"; else bad "npm test（见 ${TMP}/test.log）"; tail -20 "${TMP}/test.log"; fi

# 5. 能读到本机原生会话
N="$(node src/layers/cli.ts sessions --limit 1 2>&1 >/dev/null | grep -oE '[0-9]+' | head -1)"
[ -n "${N}" ] && [ "${N}" -gt 0 ] && ok "jev sessions 读到 ${N} 个交互会话" || bad "jev sessions 没有读到会话"

# 6. 一次真实路由判断（只判断不送达）
OUT="$(node src/layers/cli.ts route --json "帮我写一个统计 nginx 日志里每小时 5xx 数量的小脚本" 2>"${TMP}/route.err")"
KIND="$(printf '%s' "${OUT}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).kind)}catch{console.log("")}})')"
case "${KIND}" in
  continue|new|clarify) ok "jev route 给出决策：${KIND}（$(tail -1 "${TMP}/route.err")）" ;;
  *) bad "jev route 没有给出决策：$(head -c 300 "${TMP}/route.err")" ;;
esac

echo
echo "${PASS} PASS / ${FAIL} FAIL"
[ "${FAIL}" -eq 0 ]
