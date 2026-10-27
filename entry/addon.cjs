// One optional, locally installed executable add-on. No transport or remote credentials live here.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const FILES = ['index.cjs', 'manifest.json', 'remote.cjs', 'remote.html'];

function validatePackage(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Select an add-on directory');
  const names = fs.readdirSync(dir).sort();
  if (JSON.stringify(names) !== JSON.stringify(FILES)) throw new Error('Unexpected or missing add-on files');
  for (const name of FILES) {
    if (!fs.lstatSync(path.join(dir, name)).isFile()) throw new Error(`Add-on files must be regular files: ${name}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'remote' || manifest.apiVersion !== 1 || manifest.entry !== 'index.cjs'
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Unsupported add-on manifest (remote, API 1, index.cjs, x.y.z required)');
  }
  return manifest;
}

function createAddonManager({ home, host }) {
  const root = path.join(home, 'addons');
  const installed = path.join(root, 'remote');
  let active = null;
  let manifest = null;
  let busy = false;

  function dispose() {
    const previous = active;
    active = null;
    manifest = null;
    previous?.dispose();
  }

  async function activate(newInstall = false) {
    const info = validatePackage(installed);
    const canonical = fs.realpathSync(installed);
    const load = createRequire(path.join(canonical, 'index.cjs'));
    // Updates must not reuse the old package's module cache.
    for (const key of Object.keys(load.cache)) if (key.startsWith(canonical + path.sep)) delete load.cache[key];
    const module = load(path.join(canonical, 'index.cjs'));
    if (typeof module.createAddon !== 'function') throw new Error('Missing createAddon entry');
    const next = module.createAddon(host);
    if (!next || !['start', 'menuItems', 'dispose'].every((key) => typeof next[key] === 'function')) {
      next?.dispose?.();
      throw new Error('Invalid add-on lifecycle');
    }
    try { await next.start({ installed: newInstall }); }
    catch (e) { next.dispose(); throw e; }
    active = next;
    manifest = info;
  }

  async function install(source) {
    if (busy) throw new Error('An add-on operation is already in progress');
    validatePackage(source);
    const from = path.resolve(source);
    if (from === path.resolve(root) || from.startsWith(path.resolve(root) + path.sep)) throw new Error('Select the downloaded package, not its installed copy');
    busy = true;
    const settings = { ...host.settings.load() };
    let work;
    let movedOld = false;
    let movedNew = false;
    let completed = false;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      work = fs.mkdtempSync(path.join(root, '.install-'));
      const staged = path.join(work, 'new');
      const backup = path.join(work, 'previous');
      fs.cpSync(source, staged, { recursive: true });
      validatePackage(staged);
      dispose();
      if (fs.existsSync(installed)) { fs.renameSync(installed, backup); movedOld = true; }
      fs.renameSync(staged, installed);
      movedNew = true;
      await activate(true);
      completed = true;
      return manifest;
    } catch (error) {
      if (movedNew) { dispose(); fs.rmSync(installed, { recursive: true, force: true }); host.settings.save(settings); }
      if (movedOld) {
        fs.renameSync(path.join(work, 'previous'), installed);
        try { await activate(); } catch (restoreError) { error.message += `; previous package restored but could not start: ${restoreError.message}`; }
      }
      throw error;
    } finally {
      // A filesystem failure during rollback must not erase the only recoverable old package.
      if (work && (completed || !fs.existsSync(path.join(work, 'previous')))) fs.rmSync(work, { recursive: true, force: true });
      busy = false;
    }
  }

  return {
    install,
    load: async () => { if (fs.existsSync(installed)) await activate(); },
    uninstall: () => {
      if (busy) throw new Error('An add-on operation is already in progress');
      dispose();
      fs.rmSync(installed, { recursive: true, force: true });
    },
    dispose,
    menuItems: () => active?.menuItems() ?? [],
    info: () => manifest,
    present: () => fs.existsSync(installed),
  };
}

module.exports = { validatePackage, createAddonManager };
