import * as vscode from 'vscode';
import associations from '../resources/file-icons.json';

const rules = [...associations].reverse();
const foldedRules = rules.map(rule => ({ ...rule, pattern: rule.pattern.toLowerCase() }));

function matches(name: string, rule: typeof rules[number]): boolean {
  if (rule.kind === 'name') return name === rule.pattern;
  return rule.kind === 'suffix' ? name.endsWith(rule.pattern) : name.includes(rule.pattern);
}

export function fileIcon(path: string): vscode.ThemeIcon {
  const name = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  const folded = name.toLowerCase();
  const rule = rules.find(rule => matches(name, rule)) ?? foldedRules.find(rule => matches(folded, rule));
  const kind = (rule?.icon ?? 'default').replaceAll('_', '-').toLowerCase();
  return new vscode.ThemeIcon(`telescope-picker-file-${kind}`);
}
