import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const loader = JSON.parse(await readFile('node_modules/@vscode/ripgrep/package.json', 'utf8'));
const targets = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const destination = resolve('releases', manifest.version);
const temporary = await mkdtemp(join(tmpdir(), 'telescope-packages-'));
function run(executable, args, cwd, capture = false) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout;
}
async function verifyArchive(path, target) {
  const zip = await readFile(path);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid VSIX ZIP directory');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let entry = 0; entry < count; entry++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid VSIX ZIP entry');
    const length = zip.readUInt16LE(offset + 28);
    const name = zip.toString('utf8', offset + 46, offset + 46 + length);
    entries.push(name);
    if (name === `extension/node_modules/@vscode/ripgrep-${target}/bin/rg`) {
      // Windows chmod cannot set Unix execute bits; VS Code restores these ZIP attributes on install.
      zip.writeUInt16LE((3 << 8) | 20, offset + 4);
      zip.writeUInt32LE(0o100755 * 65536, offset + 38);
    }
    offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  const binaries = entries.filter(name => /\/bin\/rg(?:\.exe)?$/.test(name));
  const expected = `extension/node_modules/@vscode/ripgrep-${target}/bin/${target.startsWith('win32-') ? 'rg.exe' : 'rg'}`;
  if (binaries.length !== 1 || binaries[0] !== expected
    || !entries.includes('extension/node_modules/@vscode/ripgrep/lib/index.js')
    || !entries.includes('extension/dist/fileRankingWorker.js')
    || !entries.includes('extension/dist/extension.js') || !entries.includes('extension/media/icon.png'))
    throw new Error(`VSIX runtime contents are incorrect for ${target}`);
  await writeFile(path, zip);
}
try {
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit'], root);
  run(process.execPath, [resolve('esbuild.mjs')], root);
  await mkdir(destination, { recursive: true });
  const checksums = [];
  for (const target of targets) {
    const stage = join(temporary, target);
    const download = join(temporary, `${target}-download`);
    await mkdir(stage);
    await mkdir(download);
    const dependency = `@vscode/ripgrep-${target}`;
    const version = loader.optionalDependencies[dependency];
    if (!version) throw new Error(`No official ripgrep package for ${target}`);
    // npm's CLI is a JS file; invoking it via Node avoids Windows shell quoting.
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run this script with npm run package:all.');
    run(process.execPath, [npm, 'pack', `${dependency}@${version}`, '--ignore-scripts', '--pack-destination', download], root);
    const archives = (await readdir(download)).filter(name => name.endsWith('.tgz'));
    if (archives.length !== 1) throw new Error(`Expected exactly one ${dependency} archive`);
    run('tar', ['-xf', join(download, archives[0]), '-C', download], root);
    const binaryPackage = join(stage, 'node_modules', '@vscode', `ripgrep-${target}`);
    await mkdir(join(stage, 'node_modules', '@vscode'), { recursive: true });
    await cp(join(download, 'package'), binaryPackage, { recursive: true });
    const binaryName = target.startsWith('win32-') ? 'rg.exe' : 'rg';
    const binary = join(binaryPackage, 'bin', binaryName);
    const bytes = await readFile(binary);
    const magic = bytes.subarray(0, 4).toString('hex');
    if (target.startsWith('win32-') ? bytes.toString('ascii', 0, 2) !== 'MZ'
      : target.startsWith('linux-') ? magic !== '7f454c46' : magic !== 'cffaedfe')
      throw new Error(`Invalid executable format for ${target}`);
    const arm = target.endsWith('arm64');
    const machine = target.startsWith('win32-') ? bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4)
      : target.startsWith('linux-') ? bytes.readUInt16LE(18) : bytes.readUInt32LE(4);
    const expectedMachine = target.startsWith('win32-') ? arm ? 0xaa64 : 0x8664
      : target.startsWith('linux-') ? arm ? 183 : 62 : arm ? 0x0100000c : 0x01000007;
    if (machine !== expectedMachine) throw new Error(`Wrong binary architecture for ${target}`);
    if (!target.startsWith('win32-')) await chmod(binary, 0o755);
    await cp(resolve('node_modules', '@vscode', 'ripgrep'), join(stage, 'node_modules', '@vscode', 'ripgrep'), { recursive: true });
    const stagedLoader = { ...loader, optionalDependencies: { [dependency]: version } };
    await writeFile(join(stage, 'node_modules', '@vscode', 'ripgrep', 'package.json'), JSON.stringify(stagedLoader, null, 2));
    for (const file of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'media'])
      await cp(resolve(file), join(stage, file), { recursive: true });
    await mkdir(join(stage, 'dist'));
    await cp(resolve('dist', 'extension.js'), join(stage, 'dist', 'extension.js'));
    await cp(resolve('dist', 'fileRankingWorker.js'), join(stage, 'dist', 'fileRankingWorker.js'));
    const { scripts, devDependencies, ...runtime } = manifest;
    await writeFile(join(stage, 'package.json'), JSON.stringify({
      ...runtime, dependencies: { '@vscode/ripgrep': loader.version }
    }, null, 2));
    const filename = `${manifest.name}-${target}-${manifest.version}.vsix`;
    run(process.execPath, [resolve('node_modules', '@vscode', 'vsce', 'vsce'),
      'package', '--target', target, '--out', join(destination, filename)], stage);
    await verifyArchive(join(destination, filename), target);
    const hash = createHash('sha256').update(await readFile(join(destination, filename))).digest('hex');
    checksums.push(`${hash}  ${filename}`);
  }
  await writeFile(join(destination, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  console.log(`All six platform packages saved to ${destination}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
