import { randomBytes } from 'node:crypto';

export function pickerHtml(resources: { script: string; style: string; cspSource: string }): string {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${resources.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${resources.style}">
  <title>Telescope Picker</title>
</head>
<body>
  <main class="picker" aria-label="Workspace file picker">
    <header><h1>Files</h1><span id="workspace"></span><button id="toggle-preview" aria-pressed="true">Preview (Alt+P)</button></header>
    <label class="search-label" for="query">Find a file</label>
    <input id="query" type="text" role="combobox" aria-autocomplete="list" aria-controls="results"
      aria-expanded="true" aria-describedby="help" autocomplete="off" spellcheck="false" maxlength="1024" placeholder="Search filenames and paths...">
    <div class="columns">
      <section class="result-pane" aria-label="Results">
        <p id="result-state" role="status">Loading workspace files...</p>
        <ul id="results" role="listbox" aria-label="Workspace files"></ul>
      </section>
      <section id="preview-pane" aria-label="Code preview">
        <h2 id="preview-title">Preview</h2>
        <p id="preview-note" role="status">Select a file to preview it.</p>
        <div id="preview-scroll" tabindex="0" role="region" aria-label="Read-only code preview">
          <pre id="line-numbers" aria-hidden="true"></pre><pre><code id="preview-code"></code></pre>
        </div>
      </section>
    </div>
    <footer><span id="count" role="status" aria-live="polite"></span>
      <span id="help">Enter Open · Ctrl/Cmd+Enter Split · Esc Close · Alt+P Preview · Alt+↑/↓ Scroll preview</span></footer>
    <p id="error" role="alert" hidden></p>
  </main>
  <script nonce="${nonce}" src="${resources.script}"></script>
</body>
</html>`;
}
