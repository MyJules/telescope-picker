import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const source = join('node_modules', 'seti-ui');
const font = await readFile(join(source, 'styles', '_fonts', 'seti.less'), 'utf8');
const characters = new Map([...font.matchAll(/@([\w-]+):\s*'\\([\dA-Fa-f]+)'/g)]
  .map(match => [match[1], `\\${match[2]}`]));
const mapping = (await readFile(join(source, 'styles', 'components', 'icons', 'mapping.less'), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const matches = [...mapping.matchAll(/\.icon-(set|partial)\(\s*(["'])(.*?)\2,\s*(["'])([\w-]+)\4,\s*@[\w-]+\s*\);/g)];
if (!characters.has('default') || matches.length !== [...mapping.matchAll(/\.icon-(?:set|partial)\(/g)].length)
  throw new Error('Unsupported Seti font or association format.');

const rules = matches.map(match => ({
  kind: match[1] === 'set' ? 'suffix' : 'contains', pattern: match[3], icon: match[5]
}));
for (const pattern of ['.cppm', '.cxxm', '.ccm', '.ixx', '.mxx']) rules.push({ kind: 'suffix', pattern, icon: 'cpp' });
rules.push(
  { kind: 'suffix', pattern: '.cmake', icon: 'makefile' },
  { kind: 'suffix', pattern: '.jsonc', icon: 'json' },
  { kind: 'name', pattern: 'package.json', icon: 'npm' },
  { kind: 'name', pattern: 'package-lock.json', icon: 'npm' }
);
const icons = {};
for (const name of new Set(['default', ...rules.map(rule => rule.icon)])) {
  const character = characters.get(name);
  if (!character) throw new Error(`Missing Seti glyph: ${name}`);
  const id = `telescope-picker-file-${name.replaceAll('_', '-').toLowerCase()}`;
  if (icons[id]) throw new Error(`Duplicate contributed icon: ${id}`);
  icons[id] = {
    description: `Seti ${name.replaceAll('_', ' ')} file icon`,
    default: { fontPath: './resources/seti.woff', fontCharacter: character }
  };
}
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
manifest.contributes.icons = icons;
await mkdir('resources', { recursive: true });
await Promise.all([
  copyFile(join(source, 'styles', '_fonts', 'seti', 'seti.woff'), join('resources', 'seti.woff')),
  copyFile(join(source, 'LICENSE.md'), join('resources', 'seti-LICENSE.txt')),
  writeFile(join('resources', 'file-icons.json'), JSON.stringify(rules, null, 2) + '\n'),
  writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n')
]);
console.log(`Generated ${rules.length} file associations and ${Object.keys(icons).length} Seti icon contributions.`);
