// electron-builder afterPack：没有 Apple Developer ID 证书。
// 本机钥匙串里有自签名代码签名身份（默认 "Native Task Router Self-Signed"，NTR_SIGN_IDENTITY 可改）就用它签：
// macOS 按"bundle ID + 这张证书"认 app，升级版本后隐私授权（控制 iTerm 等）仍然有效，别的程序没有私钥冒充不了。
// 没有就退回 ad-hoc：按二进制哈希认 app，每个新版本都要重新授权。不签的话 Electron 原有签名在改过 Info.plist 后失效，Apple 芯片上会拒绝启动。
// 两者都不是公证：下载后首次打开仍需在"系统设置 → 隐私与安全性"里点"仍要打开"。
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const IDENTITY = process.env.NTR_SIGN_IDENTITY || 'Native Task Router Self-Signed';
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  let identities = '';
  try { identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }); } catch { /* 没有钥匙串工具时按 ad-hoc */ }
  const sign = identities.includes(`"${IDENTITY}"`) ? IDENTITY : '-';
  console.log(`  • codesign identity: ${sign === '-' ? 'ad-hoc' : sign}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', sign, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
