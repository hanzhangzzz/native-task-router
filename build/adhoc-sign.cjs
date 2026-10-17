// electron-builder afterPack：没有 Developer ID 证书时，对整个 .app 做完整的 ad-hoc 签名。
// 不签的话 Electron 原有签名在改过 Info.plist 后失效，Apple 芯片上会拒绝启动。
// 这不是公证：下载后首次打开仍需在"系统设置 → 隐私与安全性"里点"仍要打开"。
const { execFileSync } = require('node:child_process');
const path = require('node:path');
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
