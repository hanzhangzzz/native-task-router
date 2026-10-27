import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAddonManager, validatePackage } = require('../entry/addon.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntr-addon-contracts-'));
let pass = 0;
const check = (name, test) => { assert.ok(test, name); console.log(`PASS ${name}`); pass++; };
const rejects = async (name, fn) => { await assert.rejects(fn); check(name, true); };
const settings = { remoteMobile: true, hotkey: 'Example' };
const host = { settings: { load: () => ({ ...settings }), save: (patch) => Object.assign(settings, patch) }, events: [], enabled: false };
const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, 'remote'), { recursive: true });
const protectedFiles = ['remote/token', 'remote/config.json', 'entry-log.jsonl'].map((name) => {
  const file = path.join(home, name);
  fs.writeFileSync(file, `sample data: ${name}`);
  return [file, fs.readFileSync(file)];
});
function fixture(name, version, failure = '') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'remote', version, apiVersion: 1, entry: 'index.cjs' }));
  fs.writeFileSync(path.join(dir, 'remote.cjs'), '// fixture implementation');
  fs.writeFileSync(path.join(dir, 'remote.html'), '<!doctype html><p>Sample add-on</p>');
  fs.writeFileSync(path.join(dir, 'index.cjs'), `exports.createAddon = host => ({
    start({installed}) { host.events.push('start:${version}:' + installed); if(installed) host.settings.save({remoteMobile:false}); ${failure} host.enabled = !installed && host.settings.load().remoteMobile; },
    menuItems() { return [{ label: 'Sample ${version}', checked: host.enabled }]; },
    dispose() { host.events.push('stop:${version}'); host.enabled = false; }
  });`);
  return dir;
}

try {
  const manager = createAddonManager({ home, host });
  await manager.load();
  check('no add-on: no files created and no menu contribution', !fs.existsSync(path.join(home, 'addons')) && manager.menuItems().length === 0);
  const one = fixture('one.ntr-addon', '0.1.0');
  const two = fixture('two.ntr-addon', '0.2.0');
  const broken = fixture('broken.ntr-addon', '0.3.0', 'throw new Error("sample activation failure");');
  check('valid fixed package and API version accepted', validatePackage(one).version === '0.1.0');
  const bad = fixture('bad.ntr-addon', '0.4.0');
  const manifestFile = path.join(bad, 'manifest.json');
  const originalManifest = fs.readFileSync(manifestFile, 'utf8');
  for (const patch of [{ entry: '../outside.cjs' }, { apiVersion: 2 }, { version: 'latest' }, { id: 'other' }]) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(originalManifest), ...patch }));
    assert.throws(() => validatePackage(bad));
  }
  fs.writeFileSync(manifestFile, originalManifest);
  check('entry escape, wrong API, invalid version and other id rejected', true);
  fs.writeFileSync(path.join(bad, 'extra.cjs'), '// not allowed');
  assert.throws(() => validatePackage(bad));
  fs.unlinkSync(path.join(bad, 'extra.cjs'));
  check('unexpected files rejected', true);
  const entry = path.join(bad, 'index.cjs');
  fs.unlinkSync(entry);
  fs.symlinkSync(path.join(one, 'index.cjs'), entry);
  assert.throws(() => validatePackage(bad));
  check('symlink payload rejected', true);
  fs.symlinkSync(one, path.join(root, 'linked.ntr-addon'));
  assert.throws(() => validatePackage(path.join(root, 'linked.ntr-addon')));
  check('symlink root rejected', true);

  await manager.install(one);
  check('successful install contributes menu but does not enable the add-on', manager.info().version === '0.1.0' && !settings.remoteMobile && !host.enabled);
  check('installed package is a copy, not the source', fs.existsSync(path.join(one, 'index.cjs')) && fs.existsSync(path.join(home, 'addons', 'remote', 'index.cjs')));
  await rejects('installed copy cannot be reinstalled into itself', () => manager.install(path.join(home, 'addons', 'remote')));
  settings.remoteMobile = true;
  manager.dispose();
  await manager.load();
  check('subsequent launch restores the user-enabled state', host.enabled && manager.menuItems()[0].checked);
  await rejects('invalid package leaves the active old package untouched', () => manager.install(bad));
  check('validation failure preserves active state', host.enabled && manager.info().version === '0.1.0');
  const oldBytes = fs.readFileSync(path.join(home, 'addons', 'remote', 'index.cjs'));
  await rejects('activation failure is reported', () => manager.install(broken));
  check('failed update restores old files, settings and running state', manager.info().version === '0.1.0' && settings.remoteMobile && host.enabled && oldBytes.equals(fs.readFileSync(path.join(home, 'addons', 'remote', 'index.cjs'))));
  check('no staging or backup residue after rollback', fs.readdirSync(path.join(home, 'addons')).join(',') === 'remote');
  await manager.install(two);
  check('successful update loads new code, stops old code and waits for explicit enable', manager.info().version === '0.2.0' && manager.menuItems()[0].label === 'Sample 0.2.0' && !host.enabled && !settings.remoteMobile && host.events.includes('stop:0.1.0'));
  manager.uninstall();
  check('uninstall stops and removes only the installed package', !manager.present() && !host.enabled && manager.menuItems().length === 0);
  check('install, failure and uninstall preserve token, configuration and history bytes', protectedFiles.every(([file, bytes]) => bytes.equals(fs.readFileSync(file))));
  settings.remoteMobile = true;
  const emptyManager = createAddonManager({ home: path.join(root, 'empty-home'), host });
  await rejects('failed first installation is reported', () => emptyManager.install(broken));
  check('failed first install leaves no installed package or changed setting', !emptyManager.present() && settings.remoteMobile);
  const recoveryHome = path.join(root, 'recovery-home');
  const recovery = createAddonManager({ home: recoveryHome, host });
  await recovery.install(one);
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (path.basename(from) === 'previous') throw new Error('sample rollback filesystem failure'); return rename(from, to); };
    await rejects('rollback filesystem failure is reported', () => recovery.install(broken));
  } finally { fs.renameSync = rename; }
  const recoveryRoot = path.join(recoveryHome, 'addons');
  check('failed rollback keeps the recoverable old package instead of deleting it', fs.readdirSync(recoveryRoot).some((name) => fs.existsSync(path.join(recoveryRoot, name, 'previous', 'manifest.json'))));

  // Execute the actual desktop menu handlers with isolated dialogs and the real installer.
  const main = fs.readFileSync(new URL('../entry/main.cjs', import.meta.url), 'utf8');
  const handlers = main.slice(main.indexOf('async function installAddon()'), main.indexOf('// ---- 快捷键'));
  const uiManager = createAddonManager({ home: path.join(root, 'ui-home'), host });
  let consent = 0, pickerCanceled = false;
  const dialogs = [];
  const dialog = {
    showOpenDialog: async (options) => { dialogs.push(options); return { canceled: pickerCanceled, filePaths: [one] }; },
    showMessageBox: async (options) => { dialogs.push(options); return { response: consent }; },
  };
  const strings = { addonInstall: 'Install add-on', addonTrust: 'Executable code; trusted sources only', addonCancel: 'Cancel', addonConfirm: 'Install', addonInstalled: (v) => `Installed ${v}; disabled`, addonDelete: 'Keep user data', addonRemove: 'Uninstall', addonRemoved: 'Removed', addonFailed: 'Failed' };
  const ui = Function('dialog', 'addons', 't', 'validatePackage', 'refreshTray', `${handlers}; return { installAddon, uninstallAddon, addonItems };`)(dialog, uiManager, () => strings, validatePackage, () => {});
  await ui.installAddon();
  check('desktop installer requires explicit consent after directory selection', !uiManager.present() && dialogs[0].properties.includes('openDirectory') && dialogs[1].detail === strings.addonTrust && dialogs[1].defaultId === 0);
  consent = 1;
  await ui.installAddon();
  check('desktop install handler installs and reports disabled state', uiManager.info().version === '0.1.0' && dialogs.at(-1).message === 'Installed 0.1.0; disabled');
  consent = 0;
  await ui.uninstallAddon();
  check('desktop uninstall cancellation preserves package', uiManager.present());
  consent = 1;
  await ui.uninstallAddon();
  check('desktop uninstall handler removes the package', !uiManager.present() && dialogs.at(-1).message === 'Removed');
  pickerCanceled = true;
  await ui.installAddon();
  check('desktop picker cancellation has no installation side effect', !uiManager.present());
  console.log(`add-on contracts: ${pass} PASS / 0 FAIL`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
