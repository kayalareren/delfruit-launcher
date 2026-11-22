const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ electronPlatformName }) => {
  if (electronPlatformName !== 'win32') return;
  const appDir = path.resolve(__dirname, '..', '..');
  const framework = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const output = path.join(appDir, 'work', 'native', 'GameControls.exe');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compile = spawnSync(path.join(framework, 'csc.exe'), [
    '/nologo', '/target:winexe', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    `/out:${output}`, path.join(appDir, 'src', 'native', 'GameControls.cs')
  ], { cwd: framework, encoding: 'utf8', windowsHide: true });
  if (compile.status !== 0) throw new Error(compile.error?.message ?? compile.stdout + compile.stderr);
};
