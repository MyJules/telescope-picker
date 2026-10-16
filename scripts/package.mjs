import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { rgPath } from '@vscode/ripgrep';

const target = `${process.platform}-${process.arch}`;
const supported = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
if (!supported.includes(target)) throw new Error(`Unsupported package target: ${target}. Supported: ${supported.join(', ')}`);
if (process.argv.length > 2) throw new Error('Build on the target OS/architecture; cross-target arguments are not supported.');
const backend = spawnSync(rgPath, ['--version'], { encoding: 'utf8' });
if (backend.error) throw backend.error;
if (backend.status !== 0) throw new Error(`Packaged ripgrep cannot run on ${target}: ${backend.stderr}`);
console.log(`Packaging ${target}: ${backend.stdout.split('\n')[0]}`);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const directory = resolve('releases', manifest.version);
await mkdir(directory, { recursive: true });
const result = spawnSync(process.execPath, [
  resolve('node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--allow-missing-repository',
  '--target', target, '--out', resolve(directory, `${manifest.name}-${target}-${manifest.version}.vsix`)
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
