import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(process.execPath, [
  resolve('node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--allow-missing-repository',
  '--target', `${process.platform}-${process.arch}`
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
