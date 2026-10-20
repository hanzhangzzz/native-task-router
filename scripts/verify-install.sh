#!/usr/bin/env bash
# 干净环境安装验证：模拟陌生人按 README「Download」从公开渠道装某个已发布版本，逐项核对后全部清理。
#   - 隔离 Homebrew：临时目录里克隆最新稳定版 Homebrew/brew，HOME / 缓存 / 临时 / 日志全在临时目录；
#     不读本机 Homebrew、不读本机 brew 信任列表与环境变量，dmg 一定从 GitHub Release 重新下载。
#   - 核对：dmg SHA-256 = Release 的 SHA256SUMS.txt = cask；Info.plist 版本；codesign 与签名身份；
#     quarantine 与 spctl（自签名预期不通过，只记录不判失败）。
#   - 功能冒烟：临时 HOME 下造示例 Claude / Codex 会话，以 Node 模式（ELECTRON_RUN_AS_NODE=1）跑安装包里的 CLI，
#     `sessions` 与只判断不送达的 `route "继续"`（无内容短句走确定性快路径，不调模型；PATH 里也没有 claude）。
#     不启动 GUI、不注册热键、不开终端标签页，不碰本机 ~/.ntr、~/.claude、~/.codex。
#   - 不运行 brew uninstall（本机正在运行的同名 app 不受影响），直接删除整个临时目录；中途失败同样清理。
# 用法: scripts/verify-install.sh <version> [--keep]     例: scripts/verify-install.sh 0.6.1
# 依赖: macOS（Apple 芯片）、git、curl、网络可访问 GitHub。退出码 0 = 没有 FAIL。
set -uo pipefail

VERSION="${1:-}"; VERSION="${VERSION#v}"
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "用法: $0 <version> [--keep]，例如 0.6.1" >&2; exit 2; }
KEEP="${2:-}"

REPO="hanzhangzzz/native-task-router"
TAP="hanzhangzzz/tap"
CASK="${TAP}/native-task-router"
DMG="Native-Task-Router-${VERSION}-arm64.dmg"
APP_NAME="Native Task Router.app"
EXPECT_AUTHORITY="Native Task Router Self-Signed"

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ntr-verify-XXXXXX")"
ROOT="$(cd "${ROOT}" && pwd -P)"
H="${ROOT}/home"                 # 陌生人的 HOME：brew 信任列表、示例会话、NTR_HOME 都在这里
BREW="${ROOT}/homebrew"          # 隔离的 Homebrew（prefix = repository）
APPDIR="${ROOT}/apps.noindex"    # .noindex：不让 Spotlight 索引临时装出来的 app
LOG="${ROOT}/logs"
mkdir -p "${H}" "${APPDIR}" "${LOG}" "${ROOT}/cache" "${ROOT}/tmp"
APP="${APPDIR}/${APP_NAME}"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

# 报告固定写到启动时的标准输出（fd 3）：信号可能在带重定向的命令执行中到达，trap 里的普通 echo 会写进日志文件
exec 3>&1
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS $1" >&3; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $1" >&3; }
info() { echo "INFO $1" >&3; }

CLEANED=0
cleanup() {
  [ "${CLEANED}" = 1 ] && return; CLEANED=1
  if [ "${KEEP}" = "--keep" ]; then info "保留临时目录 ${ROOT}"; return; fi
  case "${ROOT}" in */ntr-verify-??????) ;; *) bad "临时目录路径异常，未删除：${ROOT}"; return ;; esac
  pkill -f "${ROOT}/" 2>/dev/null; sleep 0.3
  # brew 装好的 app 会被登记进 LaunchServices；先注销，免得删目录后留下指向不存在路径的同 bundle id 记录
  [ -d "${APP}" ] && "${LSREGISTER}" -u "${APP}" 2>/dev/null
  chmod -R u+w "${ROOT}" 2>/dev/null; rm -rf "${ROOT}"
  local left ls_left; left="$(pgrep -f "${ROOT}/" || true)"
  ls_left="$("${LSREGISTER}" -dump 2>/dev/null | grep -c "${ROOT}/" || true)"
  if [ ! -e "${ROOT}" ] && [ -z "${left}" ] && [ "${ls_left}" = 0 ]; then ok "清理：临时 Homebrew / appdir / HOME 已删除，无残留进程，LaunchServices 无残留登记"
  else bad "清理：残留 $([ -e "${ROOT}" ] && echo "目录 ${ROOT} ")$([ -n "${left}" ] && echo "进程 ${left} ")$([ "${ls_left}" != 0 ] && echo "LaunchServices 登记 ${ls_left} 条")"; fi
}
summary() { printf '\n%s PASS / %s FAIL\n' "${PASS}" "${FAIL}" >&3; }
trap 'cleanup; summary' EXIT
trap 'bad "中断：未完成全部检查，清理中"; exit 130' INT TERM

# 干净环境：只放陌生人也会有的变量；代理按本机设置透传（网络通路不是被测对象）
PASSTHRU=()
for v in http_proxy https_proxy all_proxy no_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY; do
  [ -n "${!v:-}" ] && PASSTHRU+=("${v}=${!v}")
done
clean() {
  env -i HOME="${H}" USER="${USER:-$(id -un)}" LOGNAME="${USER:-$(id -un)}" SHELL=/bin/zsh TERM=dumb LANG=en_US.UTF-8 \
    TMPDIR="${ROOT}/tmp/" PATH="${BREW}/bin:/usr/bin:/bin:/usr/sbin:/sbin" ${PASSTHRU[@]+"${PASSTHRU[@]}"} "$@"
}
brewc() {
  clean HOMEBREW_CACHE="${ROOT}/cache" HOMEBREW_TEMP="${ROOT}/tmp" HOMEBREW_LOGS="${LOG}/brew" \
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
    "${BREW}/bin/brew" "$@"
}
# 安装包自带的 Node（与入口调用 CLI 的方式相同）；PATH 里没有 claude / codex
BIN="${APP}/Contents/MacOS/Native Task Router"
CLI="${APP}/Contents/Resources/app/src/layers/cli.ts"
appnode() { clean NTR_HOME="${H}/.ntr" ELECTRON_RUN_AS_NODE=1 "${BIN}" "$@"; }

echo "== Native Task Router ${VERSION} 干净环境安装验证 · $(date -u +%Y-%m-%dT%H:%M:%SZ)"
info "本机 macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)) · $(uname -m)"

# ---------- 1. 隔离 Homebrew ----------
BREW_TAG="$(clean git ls-remote --tags --refs --sort=-version:refname https://github.com/Homebrew/brew 2>"${LOG}/ls-remote.err" | awk -F/ 'NR==1{print $3}')"
if [ -n "${BREW_TAG}" ] && clean git -c advice.detachedHead=false clone -q --depth 1 --branch "${BREW_TAG}" https://github.com/Homebrew/brew "${BREW}" >"${LOG}/clone.log" 2>&1; then
  ok "隔离 Homebrew：克隆 Homebrew/brew ${BREW_TAG} 到临时目录"
else
  bad "克隆 Homebrew/brew 失败：$(tail -3 "${LOG}/ls-remote.err" "${LOG}/clone.log" 2>/dev/null)"; exit 1
fi
if brewc trust "${TAP}" >"${LOG}/trust.log" 2>&1; then ok "brew trust ${TAP}"
else bad "brew trust ${TAP}：$(tail -5 "${LOG}/trust.log")"; exit 1; fi

# ---------- 2. 从 GitHub Release 安装 ----------
[ -e "${ROOT}/cache/downloads" ] && { bad "安装前缓存里已有下载：$(ls "${ROOT}/cache/downloads")"; exit 1; }
if brewc install --cask "${CASK}" --appdir="${APPDIR}" >"${LOG}/install.log" 2>&1; then
  ok "brew install --cask ${CASK} --appdir=<临时目录>"
else
  bad "brew install 失败：$(tail -15 "${LOG}/install.log")"; exit 1
fi
# Homebrew 7 的下载进度界面不打印 URL；缓存文件名前缀是下载 URL 的 SHA-256，据此确认来源。缓存目录是本次新建的空目录。
URL="https://github.com/${REPO}/releases/download/v${VERSION}/${DMG}"
CACHED="$(find "${ROOT}/cache/downloads" -type f -name "*--${DMG}" 2>/dev/null | head -1)"
URL_SHA="$(printf '%s' "${URL}" | shasum -a 256 | awk '{print $1}')"
if [ -n "${CACHED}" ] && [ "$(basename "${CACHED}")" = "${URL_SHA}--${DMG}" ]; then
  ok "dmg 从 GitHub Release 新下载到空缓存：${URL}"
else
  bad "缓存里没有从 ${URL} 下载的 dmg：$(ls "${ROOT}/cache/downloads" 2>/dev/null | head -3)"
fi
CASK_VER="$(brewc info --cask --json=v2 "${CASK}" 2>/dev/null | grep -oE '"version": *"[^"]*"' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
[ "${CASK_VER}" = "${VERSION}" ] && ok "tap 里的 cask 版本 ${CASK_VER}" || bad "tap 里的 cask 版本是 ${CASK_VER:-未知}，不是 ${VERSION}（发版后是否跑了 release-cask.sh？）"

# ---------- 3. 哈希 ----------
SUMS="$(clean curl -fsSL "https://github.com/${REPO}/releases/download/v${VERSION}/SHA256SUMS.txt" 2>/dev/null)"
RELEASE_SHA="$(printf '%s\n' "${SUMS}" | awk -v f="${DMG}" '$2 == f || $2 == "*"f { print $1 }')"
CASK_SHA="$(grep -oE '^  sha256 "[0-9a-f]{64}"' "$(brewc --repository "${TAP}")/Casks/native-task-router.rb" 2>/dev/null | grep -oE '[0-9a-f]{64}')"
if [ -n "${CACHED}" ]; then
  DMG_SHA="$(shasum -a 256 "${CACHED}" | awk '{print $1}')"
  info "下载的 dmg：$(stat -f %z "${CACHED}") 字节，SHA-256 ${DMG_SHA}"
  [ -n "${RELEASE_SHA}" ] && [ "${DMG_SHA}" = "${RELEASE_SHA}" ] && ok "dmg SHA-256 与 Release 的 SHA256SUMS.txt 一致" \
    || bad "dmg SHA-256 与 Release 的 SHA256SUMS.txt 不一致（Release: ${RELEASE_SHA:-取不到}）"
  [ "${DMG_SHA}" = "${CASK_SHA}" ] && ok "dmg SHA-256 与 cask 的 sha256 一致" || bad "dmg SHA-256 与 cask 的 sha256 不一致（cask: ${CASK_SHA:-取不到}）"
else
  bad "Homebrew 缓存里找不到 ${DMG}"
fi

# ---------- 4. 安装产物 ----------
if [ ! -d "${APP}" ]; then bad "appdir 里没有 ${APP_NAME}"; exit 1; fi
APP_VER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${APP}/Contents/Info.plist" 2>/dev/null)"
[ "${APP_VER}" = "${VERSION}" ] && ok "Info.plist CFBundleShortVersionString = ${APP_VER}" || bad "Info.plist 版本是 ${APP_VER:-读不到}，不是 ${VERSION}"

if codesign --verify --deep --strict "${APP}" >"${LOG}/codesign.log" 2>&1; then ok "codesign --verify --deep --strict"
else bad "codesign --verify --deep --strict：$(tail -3 "${LOG}/codesign.log")"; fi
AUTHORITY="$(codesign -dvv "${APP}" 2>&1 | awk -F= '/^Authority=/{print $2; exit}')"
[ "${AUTHORITY}" = "${EXPECT_AUTHORITY}" ] && ok "签名身份 Authority=${AUTHORITY}" || bad "签名身份是 ${AUTHORITY:-无（ad-hoc？）}，应为 ${EXPECT_AUTHORITY}"

QUAR="$(xattr -p com.apple.quarantine "${APP}" 2>/dev/null)"
if [ -n "${QUAR}" ]; then info "quarantine：app 带 com.apple.quarantine（${QUAR}）→ 首次从 Finder/登录项打开会被 Gatekeeper 拦下，需要「仍要打开」或 xattr -dr"
else info "quarantine：app 不带 com.apple.quarantine → Gatekeeper 首次打开不会因隔离属性拦截"; fi
SPCTL="$(spctl --assess --type execute -vv "${APP}" 2>&1 | tr '\n' ' ')"
info "spctl --assess --type execute：${SPCTL}（自签名未公证，预期 rejected；不计为失败）"

# ---------- 5. 功能冒烟（Node 模式跑安装包里的 CLI） ----------
# 冒烟只验证安装包本身能工作；去掉临时副本上的隔离属性（等同 README 的 xattr -dr 那一步），避免直接执行被隔离的二进制触发系统弹窗
[ -n "${QUAR}" ] && xattr -dr com.apple.quarantine "${APP}" && info "冒烟前已去掉临时副本的 quarantine（README 的 xattr -dr 步骤）"

now()  { date -u -v-"$1"M +%Y-%m-%dT%H:%M:%S.000Z; }
C1=11111111-1111-4111-8111-111111111111; C2=22222222-2222-4222-8222-222222222222
X1=33333333-3333-4333-8333-333333333333; X2=44444444-4444-4444-8444-444444444444
claude_session() { # <id> <cwd> <minutes-ago> <prompt> <reply>
  local dir="${H}/.claude/projects/$(printf '%s' "$2" | tr '/.' '--')"; mkdir -p "${dir}"
  printf '%s\n' \
    "{\"type\":\"user\",\"sessionId\":\"$1\",\"cwd\":\"$2\",\"entrypoint\":\"cli\",\"timestamp\":\"$(now "$(($3+1))")\",\"message\":{\"role\":\"user\",\"content\":\"$4\"}}" \
    "{\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"$5\"}]},\"type\":\"assistant\",\"sessionId\":\"$1\",\"cwd\":\"$2\",\"timestamp\":\"$(now "$3")\"}" \
    >"${dir}/$1.jsonl"
}
codex_session() { # <id> <cwd> <minutes-ago> <prompt> <reply>
  local dir="${H}/.codex/sessions/$(date -u +%Y/%m/%d)"; mkdir -p "${dir}"
  printf '%s\n' \
    "{\"timestamp\":\"$(now "$(($3+1))")\",\"type\":\"session_meta\",\"payload\":{\"id\":\"$1\",\"timestamp\":\"$(now "$(($3+1))")\",\"cwd\":\"$2\",\"originator\":\"codex_cli_rs\",\"source\":\"cli\"}}" \
    "{\"timestamp\":\"$(now "$(($3+1))")\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"$4\"}]}}" \
    "{\"timestamp\":\"$(now "$3")\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"$5\"}],\"phase\":\"final_answer\"}}" \
    >"${dir}/rollout-$(date -u +%Y-%m-%dT%H-%M-%S)-$1.jsonl"
}
claude_session "${C1}" /Users/demo/code/shop-api 5  "给订单列表接口加分页参数" "已在 GET /orders 加上 page 与 size。"
claude_session "${C2}" /Users/demo/code/web      30 "把首页的按钮改成圆角" "已把 .btn 的 border-radius 改为 8px。"
codex_session  "${X1}" /Users/demo/code/billing  60 "发票导出支持 CSV" "已新增 export --format csv。"
codex_session  "${X2}" /Users/demo/code/billing  90 "修复退款金额四舍五入" "改用整数分计算，已补测试。"
# 第二个 Codex 会话压成 .jsonl.zst（codex-cli 0.163 起会这样压旧会话），用安装包自带 Node 的 zlib 压缩
X2F="$(find "${H}/.codex/sessions" -name "*${X2}.jsonl")"
if appnode -e 'const z=require("zlib"),fs=require("fs");const f=process.argv[1];fs.writeFileSync(f+".zst",z.zstdCompressSync(fs.readFileSync(f)));fs.unlinkSync(f)' "${X2F}" 2>"${LOG}/zst.err"; then
  info "示例历史：Claude 2 个会话（shop-api、web），Codex 2 个会话（billing，其中 1 个为 .jsonl.zst）"
else
  bad "安装包的 Node 模式无法运行（ELECTRON_RUN_AS_NODE）：$(head -3 "${LOG}/zst.err")"; exit 1
fi

# json 字段检查也用安装包自带的 Node，不依赖本机 node
SESS_OUT="$(appnode "${CLI}" sessions --limit 10 2>"${LOG}/sessions.err")"; SESS_RC=$?
SESS_CHECK="$(printf '%s' "${SESS_OUT}" | appnode -e '
  const want = process.argv.slice(1).sort();
  const got = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).sessionId).sort();
  console.log(JSON.stringify(got) === JSON.stringify(want) ? "ok" : "got " + JSON.stringify(got));
' "${C1}" "${C2}" "${X1}" "${X2}" 2>&1)"
[ "${SESS_RC}" = 0 ] && [ "${SESS_CHECK}" = ok ] && ok "ntr sessions 恰好索引到 4 个示例会话（含 .jsonl.zst）：$(tail -1 "${LOG}/sessions.err")" \
  || bad "ntr sessions（退出码 ${SESS_RC}）：${SESS_CHECK} $(tail -3 "${LOG}/sessions.err")"

ROUTE_OUT="$(appnode "${CLI}" route --json "继续" 2>"${LOG}/route.err")"; ROUTE_RC=$?
ROUTE_CHECK="$(printf '%s' "${ROUTE_OUT}" | appnode -e '
  const ids = new Set(process.argv.slice(1));
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const opts = (d.options || []).map((o) => o.provider + ":" + o.sessionId);
  const fine = d.kind === "clarify" && d.via === "fast" && d.model === null && opts.length === 3 && (d.options || []).every((o) => ids.has(o.sessionId));
  console.log(fine ? "ok " + opts.join(" ") : "unexpected " + JSON.stringify(d).slice(0, 300));
' "${C1}" "${C2}" "${X1}" "${X2}" 2>&1)"
case "${ROUTE_RC}:${ROUTE_CHECK}" in
  0:ok*) ok "ntr route \"继续\"（只判断不送达）：快路径、未调模型、给出 3 个示例会话候选 ${ROUTE_CHECK#ok }" ;;
  *) bad "ntr route（退出码 ${ROUTE_RC}）：${ROUTE_CHECK} $(tail -3 "${LOG}/route.err")" ;;
esac
[ ! -e "${H}/.ntr/entry-log.jsonl" ] && ok "route 没有写入口日志（只判断不送达）" || bad "route 写了入口日志 ${H}/.ntr/entry-log.jsonl"

# ---------- 6. 清理并汇总（EXIT trap 打印计数） ----------
cleanup
[ "${FAIL}" -eq 0 ]
