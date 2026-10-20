#!/usr/bin/env bash
# 发完 GitHub Release 后同步 Homebrew cask：从该 Release 的 SHA256SUMS.txt 取 dmg 哈希，
# 改写 tap 检出里的 version / sha256，以发布身份提交并推送。无变化时不提交（可重复执行）。
# 用法: scripts/release-cask.sh <version>     例: scripts/release-cask.sh 0.4.0
# 前置: 已 `brew tap hanzhangzzz/tap`，gh 已登录且对 tap 仓库有写权限。
# 之后: 跑 `scripts/verify-install.sh <version>`，在隔离的 Homebrew 里按陌生人路径验证这次发布。
set -euo pipefail

VERSION="${1:-}"; VERSION="${VERSION#v}"
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "用法: $0 <version>，例如 0.4.0" >&2; exit 2; }

REPO="hanzhangzzz/native-task-router"
DMG="Native-Task-Router-${VERSION}-arm64.dmg"
TAP="$(brew --repository hanzhangzzz/tap)"
CASK="${TAP}/Casks/native-task-router.rb"
[ -f "${CASK}" ] || { echo "找不到 ${CASK}；先运行 brew tap hanzhangzzz/tap" >&2; exit 1; }

# tap 检出必须干净且与远端 main 一致，避免把本机遗留改动一起推上去
[ -z "$(git -C "${TAP}" status --porcelain)" ] || { echo "tap 检出有未提交改动：${TAP}" >&2; exit 1; }
git -C "${TAP}" fetch -q origin main
git -C "${TAP}" checkout -q main
git -C "${TAP}" merge -q --ff-only origin/main

SHA="$(gh release download "v${VERSION}" -R "${REPO}" -p SHA256SUMS.txt -O - | awk -v f="${DMG}" '$2 == f { print $1 }')"
[[ "${SHA}" =~ ^[0-9a-f]{64}$ ]] || { echo "v${VERSION} 的 SHA256SUMS.txt 里没有 ${DMG} 的哈希" >&2; exit 1; }

sed -i '' -E \
  -e "s/^  version \"[^\"]*\"$/  version \"${VERSION}\"/" \
  -e "s/^  sha256 \"[^\"]*\"$/  sha256 \"${SHA}\"/" \
  "${CASK}"
grep -q "^  version \"${VERSION}\"$" "${CASK}" && grep -q "^  sha256 \"${SHA}\"$" "${CASK}" \
  || { echo "改写 cask 失败，检查 ${CASK} 的 version/sha256 行格式" >&2; git -C "${TAP}" checkout -q -- "${CASK}"; exit 1; }

if git -C "${TAP}" diff --quiet; then
  echo "cask 已是 ${VERSION}（${SHA}），无需提交；下一步: scripts/verify-install.sh ${VERSION}"
  exit 0
fi

git -C "${TAP}" add Casks/native-task-router.rb
git -C "${TAP}" -c user.name=huajuan404 -c user.email=258429709+huajuan404@users.noreply.github.com \
  commit -q -m "chore: native-task-router ${VERSION}"
git -C "${TAP}" push -q origin main
echo "cask 已更新到 ${VERSION}：$(git -C "${TAP}" rev-parse --short HEAD)；下一步: scripts/verify-install.sh ${VERSION}"
