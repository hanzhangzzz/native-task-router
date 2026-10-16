// iTerm Surface 真实运行验收（TE-2 ①–⑤）。只操作本脚本新建的专用测试窗口；日志落 .runtime/te2/。
// 用法: JEV_LIVE_ITERM=1 node scripts/layers-iterm.live.mjs [--focus]（不设则不运行：会在你正在用的 iTerm 里建测试窗口）   （--focus 会在最后把 iTerm 带到前台测一次 focus）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { iterm, osa } from '../src/layers/surfaces/iterm.ts';
import { requireLiveOptIn, openTestWindow } from './lib-iterm-live.mjs';

requireLiveOptIn('layers-iterm.live');

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const D = path.join(ROOT, '.runtime/te2');
fs.mkdirSync(D, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); };
const waitFor = async (fn, ms, step = 1000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } };

// 防误伤：所有写入/读取只允许落在本脚本自己创建的 session 上
const own = new Set();
const guarded = (viewId) => { if (!own.has(viewId)) throw new Error(`拒绝操作非本测试创建的视图 ${viewId}`); return viewId; };
const rawKey = async (viewId, s) => osa('on run argv\ntell application "iTerm"\nrepeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\nif (id of s) is (item 1 of argv) then tell s to write text (item 2 of argv)\nend repeat\nend repeat\nend repeat\nend tell\nend run', [guarded(viewId), s]);

const before = await iterm.listViews();
fs.writeFileSync(path.join(D, 'views-before.json'), JSON.stringify(before, null, 1));
console.log(`测试前视图 ${before.length} 个`);

const testWindow = await openTestWindow();
const wid = testWindow.wid;
const firstSession = (await osa(`tell application "iTerm" to return id of current session of current tab of window id ${wid}`));
own.add(firstSession);
async function open(cwd, argv) { const v = await iterm.openView(cwd, argv, { windowId: wid }); own.add(v.viewId); return v; }

try {
  // ① 新开 tab：cwd 与 argv 逐字节落盘
  {
    const cwd = path.join(D, "目录 with 'quote\" $x");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(D, 'argv-fixture.mjs'), `import fs from 'node:fs';fs.writeFileSync(process.argv[2], JSON.stringify({cwd: process.cwd(), argv: process.argv.slice(3)}));`);
    const out = path.join(D, 'argv-out.json');
    fs.rmSync(out, { force: true });
    const args = ['中文 空格', 'a"b', "a'b", '$HOME', '`echo pwned`', '$(echo pwned)', 'l1\nl2', '\\n', '😀 -n', '; touch ' + path.join(D, 'pwned')];
    const v = await open(cwd, ['node', path.join(D, 'argv-fixture.mjs'), out, ...args]);
    const got = await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8'), 15000);
    const j = got ? JSON.parse(got) : null;
    check('① cwd 逐字节一致', j?.cwd === fs.realpathSync(cwd), JSON.stringify(j?.cwd));
    check('① argv 逐项一致（含中文/空格/引号/$HOME 字面量/换行/反引号）', JSON.stringify(j?.argv) === JSON.stringify(args), JSON.stringify(j?.argv));
    check('① 未执行注入的命令', !fs.existsSync(path.join(D, 'pwned')));
    check('① openView 返回 tty', /^\/dev\/ttys\d+$/.test(v.tty ?? ''), String(v.tty));
    const alive = (await iterm.listViews()).some((x) => x.viewId === v.viewId);
    check('① 命令结束后 tab 仍在（停在 shell）', alive);
  }

  // ② write：原始字节夹具
  {
    fs.writeFileSync(path.join(D, 'rec.py'), `import os,sys,tty,select
tty.setraw(0)
out=open(sys.argv[1],'wb')
os.write(1,b'READY\\r\\n')
while True:
    r,_,_=select.select([0],[],[],4)
    if not r: break
    out.write(os.read(0,4096)); out.flush()
`);
    const cases = [
      ['多行+引号+反斜杠+中文+emoji', 'a "q" \'s\' \\ 中文 😀\nline2\n\nline4 $HOME `x` \\n'],
      ['单行', 'hello'],
      ['正文含 ESC[201~ 注入', 'x\u001b[201~rm -rf y'],
    ];
    for (const [name, text] of cases) {
      const out = path.join(D, 'raw.bin');
      fs.rmSync(out, { force: true });
      const v = await open(D, ['python3', path.join(D, 'rec.py'), out]);
      await waitFor(async () => (await iterm.screenTail(v.viewId, 3)).includes('READY'), 10000);
      await iterm.write(v.viewId, text);
      await waitFor(() => !(execFileSync('ps', ['-t', v.tty.replace('/dev/', ''), '-o', 'command=']).toString().includes('rec.py')), 12000, 700);
      const got = fs.readFileSync(out);
      const want = Buffer.from('\u001b[200~' + text.replaceAll('\u001b', '') + '\u001b[201~\r');
      check(`② ${name}: 字节恰为 ESC[200~ 正文 ESC[201~ \\r`, got.equals(want), `got=${got.toString('hex')} want=${want.toString('hex')}`);
      check(`② ${name}: 仅一个 \\r 且在末尾`, [...got].filter((b) => b === 13).length === 1 && got.at(-1) === 13);
    }
  }

  // ③ 真实 Claude TUI
  {
    const iso = path.join(D, 'claude-iso');
    fs.mkdirSync(iso, { recursive: true });
    const isoReal = fs.realpathSync(iso);
    const text = 'TE-2 write 契约测试，只回复 OK 两个字母。\n第二行 "引号" \'x\' \\ 😀\n第三行 $HOME';
    const v = await open(iso, ['claude', '--model', 'haiku']);
    const ready = await waitFor(async () => {
      const t = await iterm.screenTail(v.viewId, 40);
      if (/trust this folder|Do you trust|Yes, I trust/i.test(t)) { await rawKey(v.viewId, ''); await sleep(1500); return false; }
      return /\? for shortcuts|bypass permissions|esc to interrupt|❯/.test(t);
    }, 90000, 1000);
    console.log('claude 就绪:', !!ready);
    fs.writeFileSync(path.join(D, 'claude-screen-before.txt'), await iterm.screenTail(v.viewId, 40));
    const sess = () => fs.readdirSync(path.join(os.homedir(), '.claude/sessions')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/sessions', f), 'utf8')); } catch { return null; } }).find((j) => j && fs.existsSync(j.cwd ?? '') && fs.realpathSync(j.cwd) === isoReal);
    const info = await waitFor(sess, 15000);
    check('③ 找到测试 Claude 的 session 文件', !!info, 'no session file');
    const sid = info?.sessionId;
    const tr = () => { for (const d of fs.readdirSync(path.join(os.homedir(), '.claude/projects'))) { const f = path.join(os.homedir(), '.claude/projects', d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; } return null; };
    const userTexts = () => { const f = tr(); if (!f) return []; return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'user' && !e.isMeta).map((e) => typeof e.message?.content === 'string' ? e.message.content : (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')); };
    const n0 = userTexts().length;
    await iterm.write(v.viewId, text);
    await waitFor(() => userTexts().length > n0, 30000, 1000);
    await sleep(8000); // 再等一会儿，确认没有第二条
    const us = userTexts();
    fs.writeFileSync(path.join(D, 'claude-user-texts.json'), JSON.stringify(us, null, 1));
    check('③ transcript 恰好新增一条用户输入', us.length === n0 + 1, `n0=${n0} now=${us.length}`);
    check('③ 该条与写入正文一致', us.at(-1) === text, JSON.stringify(us.at(-1)));
    fs.writeFileSync(path.join(D, 'claude-screen-after.txt'), await iterm.screenTail(v.viewId, 40));
    await rawKey(v.viewId, '/exit');
    await waitFor(() => !execFileSync('ps', ['-t', v.tty.replace('/dev/', ''), '-o', 'command=']).toString().includes('claude'), 15000);
  }

  // ④ screenTail
  {
    const v = await open(D, ['echo', 'screentail-marker-中文']);
    await sleep(1500);
    const t = await iterm.screenTail(v.viewId, 5);
    check('④ screenTail 读到输出', t.includes('screentail-marker-中文'), JSON.stringify(t));
    check('④ screenTail 行数上限', (await iterm.screenTail(v.viewId, 2)).split('\n').length <= 2);
    let miss = false; try { await iterm.screenTail('NOPE', 3); } catch { miss = true; }
    check('④ 不存在的视图报错', miss);
    if (process.argv.includes('--focus')) {
      await iterm.focus(v.viewId);
      const front = await osa('tell application "iTerm" to return (id of current session of current tab of current window) & "|" & (frontmost as text)');
      check('④ focus 后当前 session 即目标且 iTerm 在前台', front.startsWith(v.viewId + '|true'), front);
    }
  }
} finally {
  // 清理：关闭测试窗口（不要往会话里输入 exit：会留下关不掉的 0 会话窗口对象，曾累积到让 iTerm 卡死）
  const closed = await testWindow.close();
  check('⑤ 测试窗口已关闭，iTerm 窗口对象回到测试前', closed.ok, closed.detail);
}

// ⑤ 前后对比
const after = await iterm.listViews();
fs.writeFileSync(path.join(D, 'views-after.json'), JSON.stringify(after, null, 1));
const ids = (a) => a.map((v) => v.viewId).sort().join(',');
check('⑤ 测试后视图 id 集合与测试前完全相同', ids(before) === ids(after), `before=${before.length} after=${after.length} extra=${after.filter((a) => !before.some((b) => b.viewId === a.viewId)).map((v) => v.viewId)}`);
check('⑤ 用户原有视图 tty 未变', before.every((b) => after.find((a) => a.viewId === b.viewId)?.tty === b.tty));
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
