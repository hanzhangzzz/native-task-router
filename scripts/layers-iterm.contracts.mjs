// iTerm Surface 离线契约（不需要 iTerm 在运行）：shell 转义往返、AppleScript 传参不被注入、粘贴包裹。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { shellQuote, buildCommand, pasteBody, osa } from '../src/layers/surfaces/iterm.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' ' + detail}`); };

const nasty = [
  '中文 空格', 'a"b', "a'b", "'", "''", 'a\\b', '\\', '$HOME', '`echo pwned`', '$(echo pwned)',
  'line1\nline2', '\n', 'tab\there', '; rm -rf /', '&& echo x', '*', '~', '!', '😀', '-n', '', ' ', 'a\\nb', '"; do shell script "echo pwned" --',
];

// 1. shellQuote / buildCommand 在真实 shell（sh、bash、zsh）里往返为同一批字面量参数
const printer = 'import sys,json;print(json.dumps(sys.argv[1:],ensure_ascii=False))';
for (const sh of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
  const cwd = "/tmp/jev te2 'q\" 中文";
  fs.mkdirSync(cwd, { recursive: true });
  const cmd = buildCommand(cwd, ['python3', '-c', printer, ...nasty]);
  const out = execFileSync(sh, ['-c', cmd], { encoding: 'utf8' });
  check(`${sh} argv 往返 (${nasty.length} 项)`, JSON.stringify(JSON.parse(out)) === JSON.stringify(nasty), out);
  const pwd = execFileSync(sh, ['-c', buildCommand(cwd, ['pwd', '-P'])], { encoding: 'utf8' }).trim();
  check(`${sh} cwd 含空格/引号/中文`, pwd === fs.realpathSync(cwd), pwd);
}
check('buildCommand 拒绝空 argv', (() => { try { buildCommand('/', []); return false; } catch { return true; } })());
check('shellQuote 对单引号用 \'\\\'\'', shellQuote("a'b") === `'a'\\''b'`);

// 2. AppleScript：变量走 argv，含引号/反斜杠/换行/AppleScript 片段的输入逐字节原样回来
for (const s of nasty.filter((x) => x !== '')) {
  const back = await osa('on run argv\nreturn item 1 of argv\nend run', [s]);
  // osascript 在输出末尾补一个换行，osa() 去掉一个；输入自身以换行结尾时需要特别比较
  const want = s;
  check(`osascript argv 往返 ${JSON.stringify(s).slice(0, 40)}`, back === want || back + '\n' === want, JSON.stringify(back));
}
const marker = '/tmp/jev-te2-pwned-marker';
fs.rmSync(marker, { force: true });
await osa('on run argv\nreturn item 1 of argv\nend run', [`" & (do shell script "touch ${marker}") & "`]);
check('注入尝试未执行 do shell script', !fs.existsSync(marker));

// 3. 静态：osa() 的脚本参数里只允许插入常量片段 FIND/ROW，不允许拼变量
const src = fs.readFileSync(new URL('../src/layers/surfaces/iterm.ts', import.meta.url), 'utf8');
const scripts = [...src.matchAll(/osa\(`([\s\S]*?)`/g)].map((m) => m[1]);
const interpolations = scripts.flatMap((s) => [...s.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]));
check(`脚本源码仅插入常量片段 (${scripts.length} 个脚本, 插值 ${JSON.stringify(interpolations)})`, scripts.length >= 5 && interpolations.every((x) => x === 'FIND' || x === 'ROW'));

// 4. 粘贴包裹
check('pasteBody 包裹 ESC[200~ … ESC[201~', pasteBody('hi') === '\u001b[200~hi\u001b[201~');
check('pasteBody 剔除正文里的 ESC（防提前结束粘贴）', pasteBody('a\u001b[201~rm') === '\u001b[200~a[201~rm\u001b[201~');
check('pasteBody 保留换行与 emoji', pasteBody('a\nb😀') === '\u001b[200~a\nb😀\u001b[201~');

console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
