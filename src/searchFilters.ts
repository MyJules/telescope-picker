import { posix } from 'node:path';
import picomatch from 'picomatch';
import * as vscode from 'vscode';

export interface SearchFilters {
  includes: readonly string[];
  excludes: readonly string[];
  allows(uri: vscode.Uri): boolean;
}

export function searchFilters(folder: vscode.WorkspaceFolder): SearchFilters {
  const config = vscode.workspace.getConfiguration('telescopePicker', folder.uri);
  const patterns = (key: string): string[] => {
    const value = config.get<unknown>(key, []);
    if (!Array.isArray(value) || value.some(pattern => typeof pattern !== 'string'))
      throw new Error(`telescopePicker.${key} must be an array of folder paths or glob patterns.`);
    return value.map((pattern: string) => {
      const path = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
      if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.startsWith('!')
        || path.split('/').includes('..') || /[\r\n\0]/.test(path))
        throw new Error(`Invalid telescopePicker.${key} pattern: ${JSON.stringify(pattern)}. Use workspace-relative paths or globs.`);
      try {
        picomatch(path, { strictBrackets: true, nonegate: true });
      } catch (reason) {
        throw new Error(`Invalid telescopePicker.${key} pattern ${JSON.stringify(pattern)}: ${String(reason)}`);
      }
      return path;
    });
  };
  const includes = patterns('include');
  const excludes = patterns('exclude');
  const compile = (patterns: readonly string[]) => patterns.map(pattern =>
    picomatch(pattern, { dot: true, nonegate: true, nocase: process.platform === 'win32' }));
  const included = compile(includes);
  const excluded = compile(excludes);
  return {
    includes, excludes,
    allows(uri) {
      if (!included.length && !excluded.length) return true;
      const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
      const path = posix.relative(fold(folder.uri.path), fold(uri.path));
      if (uri.scheme !== folder.uri.scheme || path === '..' || path.startsWith('../') || posix.isAbsolute(path)) return false;
      const parts = path.split('/');
      const candidates = parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
      return !excluded.some(matches => candidates.some(candidate => matches(candidate)))
        && (!included.length || included.some(matches => candidates.some(candidate => matches(candidate))));
    }
  };
}
