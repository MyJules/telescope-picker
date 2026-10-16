import { posix } from 'node:path';
import picomatch from 'picomatch';
import * as vscode from 'vscode';
import { searchFilters, type SearchFilters } from './searchFilters';

interface Exclusion { pattern: string; matches(path: string): boolean; when?: string }
export interface SearchScope {
  folder: vscode.WorkspaceFolder;
  label: string;
  args: string[];
  exclusions: readonly Exclusion[];
  filters: SearchFilters;
}

function exclusions(folder: vscode.WorkspaceFolder): Exclusion[] {
  const values: Record<string, unknown> = {};
  for (const section of ['files', 'search']) {
    const value = vscode.workspace.getConfiguration(section, folder.uri).get<unknown>('exclude', {});
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`${section}.exclude must be an object.`);
    Object.assign(values, value);
  }
  return Object.entries(values).flatMap(([pattern, value]) => {
    if (value === false) return [];
    let when: string | undefined;
    if (value !== true) {
      if (typeof value !== 'object' || value === null || !('when' in value) || typeof value.when !== 'string')
        throw new Error(`Invalid search exclusion: ${pattern}`);
      when = value.when;
    }
    return [{
      pattern, when, matches: picomatch(pattern, { dot: true, nonegate: true, nocase: process.platform === 'win32' })
    }];
  });
}

export function searchScopes(): SearchScope[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.map(folder => {
    const rules = exclusions(folder);
    const filters = searchFilters(folder);
    const config = vscode.workspace.getConfiguration('search', folder.uri);
    const args = ['--hidden', '--no-require-git'];
    if (process.platform === 'win32') args.push('--glob-case-insensitive');
    if (!config.get('useIgnoreFiles', true)) args.push('--no-ignore');
    if (!config.get('useGlobalIgnoreFiles', false)) args.push('--no-ignore-global');
    if (!config.get('useParentIgnoreFiles', false)) args.push('--no-ignore-parent');
    if (config.get('followSymlinks', true)) args.push('--follow');
    for (const rule of rules) if (!rule.when) args.push('--glob', `!${rule.pattern}`);
    for (const pattern of filters.excludes) {
      args.push('--glob', `!${pattern}`);
      if (!pattern.endsWith('/**')) args.push('--glob', `!${pattern}/**`);
    }
    const duplicate = folders.filter(candidate => candidate.name === folder.name).length > 1;
    return {
      folder, args, exclusions: rules, filters,
      label: duplicate ? `${folder.name} (${folder.uri.toString(true)})` : folder.name
    };
  });
}

export async function excluded(uri: vscode.Uri, scope: SearchScope): Promise<boolean> {
  if (!scope.filters.allows(uri)) return true;
  const path = posix.relative(scope.folder.uri.path, uri.path);
  const parts = path.split('/');
  for (const rule of scope.exclusions) {
    for (let count = parts.length; count > 0; count--) {
      const candidate = parts.slice(0, count).join('/');
      if (!rule.matches(candidate)) continue;
      if (!rule.when) return true;
      const basename = posix.basename(candidate, posix.extname(candidate));
      const sibling = vscode.Uri.joinPath(scope.folder.uri, candidate, '..', rule.when.replaceAll('$(basename)', basename));
      try {
        await vscode.workspace.fs.stat(sibling);
        return true;
      } catch (reason) {
        if (!(reason instanceof vscode.FileSystemError) || reason.code !== 'FileNotFound') throw reason;
      }
    }
  }
  return false;
}
