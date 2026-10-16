import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL('./test/vscode.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], clearMocks: true, restoreMocks: true }
});
