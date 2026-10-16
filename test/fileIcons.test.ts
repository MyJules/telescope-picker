import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { fileIcon } from '../src/fileIcons';
import associations from '../resources/file-icons.json';
import manifest from '../package.json';

it.each([
  ['src/main.cpp', 'cpp'], ['src/game/Game.cppm', 'cpp'], ['include/types.hpp', 'cpp'],
  ['module.ixx', 'cpp'], ['main.c', 'c'], ['CMakeLists.txt', 'makefile'],
  ['cmake/project.cmake', 'makefile'], ['main.ts', 'typescript'], ['tsconfig.json', 'tsconfig'],
  ['src/App.tsx', 'react'], ['package.json', 'npm'], ['package-lock.json', 'npm'],
  ['settings.json', 'json'], ['settings.jsonc', 'json'], ['README.md', 'info'], ['notes.md', 'markdown'],
  ['Dockerfile', 'docker'], ['test.py', 'python'], ['script.ps1', 'powershell'],
  ['C:\\app\\Game.cppm', 'cpp'], ['src/MAIN.TS', 'typescript'],
  ['unknown.extension-not-known', 'default'], ['folder.cpp/unknown', 'default']
])('chooses the %s file-type glyph', (path, kind) => {
  expect(fileIcon(path).id).toBe(`telescope-picker-file-${kind}`);
});

it('registers every generated association and the fallback against the packaged font', async () => {
  const icons = new Map(Object.entries(manifest.contributes.icons));
  expect(icons.has(fileIcon('unknown').id)).toBe(true);
  for (const association of associations) {
    const id = `telescope-picker-file-${association.icon.replaceAll('_', '-').toLowerCase()}`;
    expect(icons.has(id), id).toBe(true);
  }
  for (const icon of icons.values()) {
    expect(icon.default.fontPath).toBe('./resources/seti.woff');
    expect(icon.default.fontCharacter).toMatch(/^\\[\dA-Fa-f]+$/);
  }
  const font = await readFile(new URL('../resources/seti.woff', import.meta.url));
  expect(font.subarray(0, 4).toString()).toBe('wOFF');
  expect(font.readUInt32BE(8)).toBe(font.length);
  const license = await readFile(new URL('../resources/seti-LICENSE.txt', import.meta.url), 'utf8');
  expect(license).toContain('Jesse Weed');
});
