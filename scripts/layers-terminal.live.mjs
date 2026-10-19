// Terminal Surface 真实运行验收 ①–④。只操作本脚本用 `do script` 新开的窗口，全程不 activate Terminal；
// 日志落 .runtime/te-terminal/。收尾：等自己窗口里的命令都退出（tab 不再 busy）后逐个 close 这些窗口，
// 核对 Terminal 的窗口集合回到测试前；测试前 Terminal 没在运行且测完没有窗口时退出 Terminal。
// 实测（2026-10-19）：close 后窗口对象不会立刻消失，而是变成不可见、0 个 tab 的残留（Terminal 留着供
// "撤销关闭窗口"），所以"窗口集合"只算至少有一个 tab 的窗口。
// 用法: NTR_LIVE_TERMINAL=1 node scripts/layers-terminal.live.mjs（不设则不运行：会在 Terminal 里开测试窗口）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { osa } from '../src/layers/surfaces/iterm.ts';
import { selectView, terminal, terminalRunning } from '../src/layers/surfaces/terminal.ts';

if (process.env.NTR_LIVE_TERMINAL !== '1') {
  console.error('NOT_RUN layers-terminal.live: 会在 Terminal 里新开测试窗口并运行命令。确认要跑时设置 NTR_LIVE_TERMINAL=1。');
  process.exit(2);
}

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const D = path.join(ROOT, '.runtime/te-terminal');
fs.mkdirSync(D, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + detail}`); };
const waitFor = async (fn, ms, step = 500) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } };

const frontApp = () => osa('tell application "System Events" to return bundle identifier of first application process whose frontmost is true');
const windowIds = async () => ((await terminalRunning()) ? (await osa('tell application "Terminal"\nset acc to {}\nrepeat with w in windows\nif (count of tabs of w) > 0 then set end of acc to (id of w) as text\nend repeat\nreturn acc\nend tell')).split(',').map((s) => s.trim()).filter(Boolean) : []);
const windowOf = (tty) => osa('on run argv\ntell application "Terminal"\nrepeat with w in windows\nrepeat with t in tabs of w\nif (tty of t) is (item 1 of argv) then return (id of w) as text\nend repeat\nend repeat\nend tell\nreturn ""\nend run', [tty]);
const busy = (wid) => osa('on run argv\ntell application "Terminal" to return (busy of every tab of window id ((item 1 of argv) as integer)) as text\nend run', [wid]);

const wasRunning = await terminalRunning();
const baseline = await windowIds();
const front0 = await frontApp();
console.log(`测试前 Terminal ${wasRunning ? `在运行，${baseline.length} 个窗口` : '未运行'}；前台应用 ${front0}`);

// 防误伤：所有读写只允许落在本脚本自己开的 tab 上
const ownTtys = new Set();
const ownWins = new Set();
const own = (viewId) => { if (!ownTtys.has(viewId)) throw new Error(`拒绝操作非本测试创建的视图 ${viewId}`); return viewId; };
async function open(cwd, argv) {
  const v = await terminal.openView(cwd, argv);
  ownTtys.add(v.viewId);
  const wid = await windowOf(v.tty);
  if (wid) ownWins.add(wid);
  return { ...v, wid };
}
const frontOk = async (step) => { const f = await frontApp(); check(`${step}: 未把 Terminal 带到前台（前台 ${f}）`, f !== 'com.apple.Terminal' || front0 === 'com.apple.Terminal'); };

let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  const notes = [];
  for (const wid of ownWins) {
    if (!(await windowIds()).includes(wid)) continue;
    await waitFor(async () => !(await busy(wid).catch(() => 'gone')).includes('true'), 15000);
    await osa('on run argv\ntell application "Terminal" to close window id ((item 1 of argv) as integer)\nend run', [wid]).catch((e) => notes.push(`close ${wid}: ${e.message}`));
    if (!(await waitFor(async () => !(await windowIds()).includes(wid), 5000))) {
      notes.push(`close 窗口 ${wid} 未生效（可能弹了确认框），改用 do script "exit"`);
      await osa('on run argv\ntell application "Terminal" to do script "exit" in selected tab of window id ((item 1 of argv) as integer)\nend run', [wid]).catch(() => {});
      await waitFor(async () => !(await windowIds()).includes(wid), 8000);
    }
  }
  const after = await windowIds();
  const same = after.length === baseline.length && after.every((id) => baseline.includes(id));
  check('收尾: 本测试的窗口全部关闭，Terminal 窗口集合回到测试前', same, `before=[${baseline}] after=[${after}] ${notes.join('；')}`);
  if (notes.length) console.log('收尾记录:', notes.join('；'));
  if (!wasRunning && after.length === 0 && (await terminalRunning())) {
    await osa('tell application "Terminal" to quit');
    check('收尾: 测试前 Terminal 未运行，已退出', !!(await waitFor(async () => !(await terminalRunning()), 8000)));
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => void cleanup().finally(() => process.exit(130)));

try {
  // ① 新开窗口：cwd 与 argv 逐字节落盘
  {
    const cwd = path.join(D, "目录 with 'quote\" $x");
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(D, 'argv-fixture.mjs'), `import fs from 'node:fs';fs.writeFileSync(process.argv[2], JSON.stringify({cwd: process.cwd(), argv: process.argv.slice(3)}));`);
    const out = path.join(D, 'argv-out.json');
    fs.rmSync(out, { force: true });
    fs.rmSync(path.join(D, 'pwned'), { force: true });
    const args = ['中文 空格', 'a"b', "a'b", '$HOME', '`echo pwned`', '$(echo pwned)', 'l1\nl2', '\\n', '😀 -n', '; touch ' + path.join(D, 'pwned')];
    const n0 = (await windowIds()).length;
    const v = await open(cwd, ['node', path.join(D, 'argv-fixture.mjs'), out, ...args]);
    const got = await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8'), 15000);
    const j = got ? JSON.parse(got) : null;
    check('① cwd 逐字节一致', j?.cwd === fs.realpathSync(cwd), JSON.stringify(j?.cwd));
    check('① argv 逐项一致（含中文/空格/引号/$HOME 字面量/换行/反引号）', JSON.stringify(j?.argv) === JSON.stringify(args), JSON.stringify(j?.argv));
    check('① 未执行注入的命令', !fs.existsSync(path.join(D, 'pwned')));
    check('① openView 返回 tty，viewId 即 tty', /^\/dev\/ttys\d+$/.test(v.tty ?? '') && v.viewId === v.tty, JSON.stringify(v));
    check('① 新开的是一个新窗口（不在测试前的窗口里）', !!v.wid && !baseline.includes(v.wid) && (await windowIds()).length === n0 + 1, `wid=${v.wid}`);
    await frontOk('①');
  }

  // ② write：原始字节夹具（raw 模式录下 tty 收到的每个字节）
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
      ['CRLF 与制表符', 'a\r\nb\tc'],
    ];
    for (const [name, text] of cases) {
      const out = path.join(D, 'raw.bin');
      fs.rmSync(out, { force: true });
      const v = await open(D, ['python3', path.join(D, 'rec.py'), out]);
      const ready = await waitFor(async () => (await terminal.screenTail(own(v.viewId), 3)).includes('READY'), 10000);
      check(`② ${name}: 录制夹具就绪`, !!ready);
      await terminal.write(own(v.viewId), text);
      await waitFor(() => !execFileSync('ps', ['-t', v.tty.replace('/dev/', ''), '-o', 'command=']).toString().includes('rec.py'), 12000, 700);
      const got = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
      const want = Buffer.from('\u001b[200~' + text.replaceAll('\u001b', '') + '\u001b[201~\r');
      check(`② ${name}: 字节恰为 ESC[200~ 正文 ESC[201~ \\r`, got.equals(want), `got=${got.toString('hex')} want=${want.toString('hex')}`);
      check(`② ${name}: 正文之外只多一个 \\r 且在末尾`, got.at(-1) === 13 && got.length === want.length);
    }
    await frontOk('②');
  }

  // ③ screenTail
  let marked;
  {
    marked = await open(D, ['echo', 'screentail-marker-中文']);
    const t = await waitFor(async () => { const s = await terminal.screenTail(own(marked.viewId), 5); return s.includes('screentail-marker-中文') && s; }, 8000);
    check('③ screenTail 读到刚输出的标记', !!t, JSON.stringify(await terminal.screenTail(own(marked.viewId), 5)));
    check('③ screenTail 行数上限', (await terminal.screenTail(own(marked.viewId), 2)).split('\n').length <= 2);
    let miss = false; try { await terminal.screenTail('/dev/ttys-nope', 3); } catch { miss = true; }
    check('③ 不存在的视图报错', miss);
    await frontOk('③');
  }

  // ④ listViews 按 tty 找到 tab；selectView（focus 去掉 activate 的部分）选中它并把窗口放到最前
  {
    const views = await terminal.listViews();
    fs.writeFileSync(path.join(D, 'views.json'), JSON.stringify(views.filter((v) => ownTtys.has(v.viewId)), null, 1));
    check('④ listViews 列出本测试的每个 tab（viewId=tty，surface=terminal）', [...ownTtys].every((tty) => views.some((v) => v.viewId === tty && v.tty === tty && v.surface === 'terminal')), `own=${[...ownTtys]}`);
    const hit = views.filter((v) => v.tty === marked.tty);
    check('④ 按 tty 恰好找到一个 tab', hit.length === 1);
    await selectView(own(marked.viewId));
    const st = await osa('on run argv\ntell application "Terminal"\nset w to window id ((item 1 of argv) as integer)\nreturn ((selected of selected tab of w) as text) & "|" & (tty of selected tab of w) & "|" & ((id of front window) as text)\nend tell\nend run', [marked.wid]);
    check('④ selectView 后该 tab 被选中、其窗口是 Terminal 最前窗口', st === `true|${marked.tty}|${marked.wid}`, st);
    let miss = false; try { await selectView('/dev/ttys-nope'); } catch { miss = true; }
    check('④ selectView 不存在的视图报错', miss);
    await frontOk('④');
  }
} catch (e) {
  check('脚本异常', false, e.stack ?? String(e));
} finally {
  await cleanup();
}
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
