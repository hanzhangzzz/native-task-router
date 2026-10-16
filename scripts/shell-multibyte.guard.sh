#!/usr/bin/env bash
# 防复发门禁：macOS bash 3.2 会把紧跟 $VAR 的多字节字符吞进变量名，
# 导致 "未绑定的变量" 或静默取空。本项目已四次踩坑，故固化为可复跑检查。
# 用法：bash scripts/shell-multibyte.guard.sh
set -u
cd "$(dirname "$0")/.."
BAD=$(python3 - <<'PY'
import re, glob
bad=[]
for p in sorted(glob.glob('scripts/*.sh')):
    for n,line in enumerate(open(p,encoding='utf-8'),1):
        for m in re.finditer(r'\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])', line):
            bad.append(f'{p}:{n}: ${m.group(1)} 紧跟多字节字符，应写作 ${{{m.group(1)}}}')
print('\n'.join(bad))
PY
)
if [ -n "$BAD" ]; then
  printf '%s\n' "$BAD"
  echo "FAIL shell-multibyte-guard: 上述 \$VAR 需改为 \${VAR}"
  exit 1
fi
for f in scripts/*.sh; do bash -n "$f" || { echo "FAIL syntax: $f"; exit 1; }; done
echo "PASS shell-multibyte-guard: 无裸 \$VAR 紧跟多字节字符，且全部脚本语法正确"
exit 0
