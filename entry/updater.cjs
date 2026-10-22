// 菜单栏一键升级：查 GitHub 最新 Release → 下载 dmg 并核对 SHA256SUMS.txt → 挂载 → 新 app 必须满足当前 app 的签名要求
// （同一张自签名证书，换证书或被篡改的包装不上）→ 本进程退出后原地替换并重新打开。
// 不用 electron-updater：它要额外发布 zip + latest-mac.yml，且 Squirrel.Mac 对自签名证书的支持未经验证；这里复用每个 Release 已有的 dmg 与哈希。
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPO = 'hanzhangzzz/native-task-router';
const APP_NAME = 'Native Task Router.app';

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} ${args[0]}: ${(stderr || err.message).trim()}`)) : resolve(`${stdout}${stderr}`)));
});

/** a 比 b 新（x.y.z 逐段比较） */
function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** 最新 Release：版本、是否比 current 新、dmg 与哈希文件下载地址、Release 页面 */
async function latest(fetchImpl, current) {
  const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'native-task-router' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  const j = await r.json();
  const version = String(j.tag_name || '').replace(/^v/, '');
  const dmgName = `Native-Task-Router-${version}-arm64.dmg`;
  const asset = (name) => (j.assets || []).find((a) => a.name === name)?.browser_download_url ?? null;
  const dmg = asset(dmgName), sums = asset('SHA256SUMS.txt');
  return { version, newer: !!(dmg && sums) && isNewer(version, current), page: j.html_url, dmgName, dmg, sums };
}

/** 运行中的 .app 能否原地替换：所在目录可写，且不是 macOS 隔离运行（App Translocation）的只读副本 */
function canReplace(appPath) {
  if (!appPath.endsWith('.app') || appPath.includes('/AppTranslocation/')) return false;
  try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); return true; } catch { return false; }
}

/** 下载、核对哈希与签名，把新 app 放到与 appPath 同目录的暂存位置（同一卷，替换是一次改名）。返回暂存路径。 */
async function stage(rel, appPath, fetchImpl) {
  if (!canReplace(appPath)) throw new Error(`${appPath} 不可写`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-update-'));
  const mnt = path.join(work, 'mnt');
  let mounted = false;
  try {
    const sr = await fetchImpl(rel.sums);
    if (!sr.ok) throw new Error(`SHA256SUMS.txt ${sr.status}`);
    const want = (await sr.text()).split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === rel.dmgName)?.[0];
    if (!want) throw new Error(`SHA256SUMS.txt 里没有 ${rel.dmgName}`);

    const dr = await fetchImpl(rel.dmg);
    if (!dr.ok || !dr.body) throw new Error(`${rel.dmgName} ${dr.status}`);
    const dmg = path.join(work, rel.dmgName);
    const hash = crypto.createHash('sha256');
    await pipeline(Readable.fromWeb(dr.body), async function* (src) { for await (const c of src) { hash.update(c); yield c; } }, fs.createWriteStream(dmg));
    const got = hash.digest('hex');
    if (got !== want) throw new Error(`dmg 哈希不符：${got} ≠ ${want}`);

    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg]);
    mounted = true;
    const src = path.join(mnt, APP_NAME);
    // 当前 app 的签名要求（identifier + 证书叶哈希）；新 app 必须满足它
    const req = /designated => (.+)/.exec(await run('codesign', ['-d', '-r-', appPath]))?.[1];
    if (!req) throw new Error('读不到当前 app 的签名要求');
    await run('codesign', ['--verify', '--deep', '--strict', `-R=${req}`, src]).catch(() => { throw new Error('新版本的签名与当前版本不是同一证书，拒绝安装'); });
    const v = (await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(src, 'Contents', 'Info.plist')])).trim();
    if (v !== rel.version) throw new Error(`dmg 里的版本是 ${v}，不是 ${rel.version}`);

    const staged = path.join(path.dirname(appPath), `.${path.basename(appPath)}.update`);
    fs.rmSync(staged, { recursive: true, force: true });
    await run('ditto', [src, staged]);
    return staged;
  } finally {
    if (mounted) await run('hdiutil', ['detach', mnt, '-force']).catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 起一个脱离本进程的 shell：等 pid 退出 → 旧 app 改名、新 app 改名到位、删旧 app（换失败则还原）→ 按需重新打开 */
function swapAfterExit(pid, appPath, staged, relaunch) {
  const script = [
    'pid=$1; app=$2; new=$3; relaunch=$4; bak="$new.old"',
    'i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done',
    'rm -rf "$bak"',
    'if mv "$app" "$bak"; then if mv "$new" "$app"; then rm -rf "$bak"; else mv "$bak" "$app"; fi; fi',
    '[ "$relaunch" = 1 ] && open "$app"',
  ].join('\n');
  spawn('/bin/sh', ['-c', script, 'ntr-update', String(pid), appPath, staged, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { isNewer, latest, canReplace, stage, swapAfterExit };
