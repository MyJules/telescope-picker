import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

interface Manifest {
  contributes: {
    commands: { command: string; title: string }[];
    keybindings: { command: string; key: string; mac?: string; when?: string }[];
  };
}

it('contributes separate overridable file and content shortcuts on Windows/Linux and macOS', async () => {
  const manifest: Manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [command, key, mac] of [
    ['telescopePicker.files', 'ctrl+alt+p', 'cmd+alt+p'],
    ['telescopePicker.searchContents', 'ctrl+alt+f', 'cmd+alt+f'],
    ['telescopePicker.searchCurrentFile', 'ctrl+alt+l', 'cmd+alt+l']
  ]) {
    expect(manifest.contributes.commands.some(item => item.command === command)).toBe(true);
    expect(manifest.contributes.keybindings.find(item => item.command === command))
      .toEqual({ command, key, mac, when: '!terminalFocus' });
  }
  expect(manifest.contributes.commands).toContainEqual({
    command: 'telescopePicker.configureShortcuts', title: 'Configure Keyboard Shortcuts', category: 'Telescope Picker'
  });
});
