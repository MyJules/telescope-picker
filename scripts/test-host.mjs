import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
await runTests({
  version: process.env.VSCODE_TEST_VERSION ?? '1.108.0',
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  extensionDevelopmentPath: [
    process.env.TELESCOPE_TEST_EXTENSION_PATH ?? root,
    process.env.TELESCOPE_TEST_ICON_THEME_PATH ?? path.join(root, 'test', 'icon-theme')
  ],
  extensionTestsPath: path.join(root, 'dist', 'test', 'host.js'),
  launchArgs: [
    path.join(root, 'test', 'fixtures', 'picker.code-workspace'),
    '--disable-extensions', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', path.join(root, '.vscode-test', 'user-data'),
    '--extensions-dir', path.join(root, '.vscode-test', 'extensions')
  ]
});
