import { beforeEach, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { searchFilters } from '../src/searchFilters';
import { resetEditors, settings } from './vscode';

beforeEach(resetEditors);
const filter = () => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Expected workspace folder');
  return searchFilters(folder);
};
const allows = (path: string) => filter().allows(vscode.Uri.parse(`file:///workspace/${path}`));

it('includes all eligible files when both settings are empty', () => {
  expect(allows('src/main.cpp')).toBe(true);
  expect(allows('.hidden/file')).toBe(true);
});

it('treats folder paths as recursive and exclusions as stronger than includes', () => {
  settings.set('telescopePicker.include', ['src', 'include']);
  settings.set('telescopePicker.exclude', ['src/generated', '**/private']);
  expect(allows('src/game/main.cpp')).toBe(true);
  expect(allows('include/types.hpp')).toBe(true);
  expect(allows('src/generated/main.cpp')).toBe(false);
  expect(allows('src/private/nested/main.cpp')).toBe(false);
  expect(allows('tests/main.cpp')).toBe(false);
  expect(allows('src-other/main.cpp')).toBe(false);
});

it('supports glob patterns, dot folders, Windows folder paths and trailing slashes', () => {
  settings.set('telescopePicker.include', ['**/*.{cpp,cppm}', 'include\\public\\']);
  settings.set('telescopePicker.exclude', ['**/.cache/**']);
  expect(allows('src/game.cppm')).toBe(true);
  expect(allows('main.cpp')).toBe(true);
  expect(allows('include/public/types.hpp')).toBe(true);
  expect(allows('src/game.ts')).toBe(false);
  expect(allows('src/.cache/game.cpp')).toBe(false);
});

it.each([null, {}, 'src', [42], [''], ['   '], ['../src'], ['/src'], ['C:\\src'], ['!src'], ['src/\0file'], ['[invalid']])(
  'reports invalid folder filters explicitly: %j', value => {
    settings.set('telescopePicker.include', value);
    expect(filter).toThrow(/telescopePicker.include/);
  }
);

it('reads resource-scoped settings separately for each workspace root', () => {
  settings.set('telescopePicker.include', ['src']);
  settings.set('file:///workspace|telescopePicker.include', ['include']);
  expect(allows('include/types.hpp')).toBe(true);
  expect(allows('src/main.cpp')).toBe(false);
});
it.skipIf(process.platform !== 'win32')('handles drive-letter casing differences from native Windows discovery', () => {
  settings.set('telescopePicker.include', ['src']);
  const filters = searchFilters({ uri: vscode.Uri.parse('file:///E:/workspace'), name: 'workspace', index: 0 });
  expect(filters.allows(vscode.Uri.parse('file:///e:/workspace/src/main.cpp'))).toBe(true);
});
