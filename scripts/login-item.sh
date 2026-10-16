#!/usr/bin/env bash
# 让入口（全局快捷键输入框）登录后自动常驻：在 ~/Library/LaunchAgents 写一个用户级 LaunchAgent。
# 用法: scripts/login-item.sh install | uninstall | status
# 只影响当前用户；uninstall 会删除这个 plist 并停止入口。
set -euo pipefail

LABEL="dev.jev.entry"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ELECTRON="${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG_DIR="${JEV_HOME:-${HOME}/.jev}"
DOMAIN="gui/$(id -u)"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# 入口要调用 claude / codex / osascript：把它们所在目录放进 PATH（launchd 默认 PATH 很短）
child_path() {
  local dirs=() d
  for bin in claude codex node; do
    if command -v "${bin}" >/dev/null 2>&1; then dirs+=("$(dirname "$(command -v "${bin}")")"); fi
  done
  dirs+=(/opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin)
  local out="" seen=":"
  for d in "${dirs[@]}"; do
    case "${seen}" in *":${d}:"*) ;; *) out="${out:+${out}:}${d}"; seen="${seen}${d}:" ;; esac
  done
  printf '%s' "${out}"
}

install() {
  [ -x "${ELECTRON}" ] || { echo "找不到 ${ELECTRON}，先在 ${ROOT} 运行 npm ci" >&2; exit 1; }
  command -v claude >/dev/null 2>&1 || echo "提示：PATH 里没有 claude，路由判断需要已登录的 Claude Code" >&2
  if pgrep -f "entry/main.cjs" >/dev/null 2>&1 && ! launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "提示：已有手动启动的入口在运行，先关掉它（同一快捷键只能被一个进程注册）" >&2
  fi
  mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"
  local p; p="$(child_path | xml_escape)"
  cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(printf '%s' "${ELECTRON}" | xml_escape)</string>
    <string>$(printf '%s' "${ROOT}/entry/main.cjs" | xml_escape)</string>
  </array>
  <key>WorkingDirectory</key><string>$(printf '%s' "${ROOT}" | xml_escape)</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${p}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(printf '%s' "${LOG_DIR}/entry.log" | xml_escape)</string>
  <key>StandardErrorPath</key><string>$(printf '%s' "${LOG_DIR}/entry.log" | xml_escape)</string>
</dict>
</plist>
PLIST
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
  echo "已安装：${PLIST}（登录后自动启动入口，日志 ${LOG_DIR}/entry.log）"
}

uninstall() {
  launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "${PLIST}"
  echo "已卸载：${PLIST}"
}

status() {
  if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    launchctl print "${DOMAIN}/${LABEL}" | grep -E "^\s*(state|pid|last exit code)" || true
  else
    echo "未安装"
  fi
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) echo "用法: $0 install | uninstall | status" >&2; exit 2 ;;
esac
