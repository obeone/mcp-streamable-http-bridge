import fs from 'node:fs';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import jsonLang from 'highlight.js/lib/languages/json';
import bashLang from 'highlight.js/lib/languages/bash';

const require = createRequire(import.meta.url);

hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bashLang);

/** @type {string | undefined} */
let markdownCss;
/** @type {string | undefined} */
let hljsLightCss;
/** @type {string | undefined} */
let hljsDarkCss;

function loadAssets() {
  if (markdownCss !== undefined) return;
  markdownCss = fs.readFileSync(require.resolve('github-markdown-css/github-markdown.css'), 'utf8');
  hljsLightCss = fs.readFileSync(require.resolve('highlight.js/styles/github.min.css'), 'utf8');
  hljsDarkCss = fs.readFileSync(require.resolve('highlight.js/styles/github-dark.min.css'), 'utf8');
}

marked.use({
  gfm: true,
  breaks: false,
});

marked.use({
  renderer: {
    /**
     * @param {{ text: string; lang?: string }} token
     */
    code({ text, lang }) {
      const language = lang?.trim().toLowerCase() ?? '';
      if (language && hljs.getLanguage(language)) {
        const highlighted = hljs.highlight(text, { language }).value;
        return `<pre class="hljs-code-block"><code class="hljs language-${language}">${highlighted}</code></pre>`;
      }
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      return `<pre><code>${escaped}</code></pre>`;
    },
  },
});

const PAGE_CSS = `
  html {
    color-scheme: light dark;
  }
  body {
    margin: 0;
    min-height: 100vh;
    background-color: var(--page-bg, #ffffff);
  }
  @media (prefers-color-scheme: dark) {
    body {
      --page-bg: #0d1117;
    }
  }
  @media (prefers-color-scheme: light) {
    body {
      --page-bg: #ffffff;
    }
  }
  .catalog-shell {
    box-sizing: border-box;
    min-width: 200px;
    max-width: 980px;
    margin: 0 auto;
    padding: 48px 48px 64px;
  }
  @media (max-width: 767px) {
    .catalog-shell {
      padding: 20px 16px 40px;
    }
  }
  .markdown-body {
    box-sizing: border-box;
    min-width: 200px;
  }
  .markdown-body table {
    display: table;
    width: 100%;
    overflow: auto;
  }
  .markdown-body pre.hljs-code-block {
    padding: 16px;
    overflow: auto;
    font-size: 13px;
    line-height: 1.55;
    border-radius: 8px;
    border: 1px solid var(--borderColor-default, #d0d7de);
    background-color: var(--bgColor-muted, #f6f8fa) !important;
  }
  .markdown-body pre.hljs-code-block code.hljs {
    padding: 0;
    background: transparent !important;
    font-family: var(--fontStack-monospace, ui-monospace, monospace);
    font-size: inherit;
  }
  .catalog-footer {
    margin-top: 2.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--borderColor-default, #d0d7de);
    font-size: 14px;
    color: var(--fgColor-muted, #59636e);
  }
  .catalog-footer a {
    color: var(--fgColor-accent, #0969da);
  }
`;

export class McpCatalogHtml {
  /**
   * @param {string} markdown
   * @returns {string}
   */
  render(markdown) {
    loadAssets();
    const content = marked.parse(markdown, { async: false });
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP server catalog</title>
  <style>${markdownCss}</style>
  <style media="(prefers-color-scheme: light)">${hljsLightCss}</style>
  <style media="(prefers-color-scheme: dark)">${hljsDarkCss}</style>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <main class="catalog-shell">
    <article class="markdown-body">${content}</article>
    <p class="catalog-footer">Raw catalog: <a href="/catalog.md">/catalog.md</a></p>
  </main>
</body>
</html>`;
  }
}

/**
 * @param {import('../types.js').IncomingMessage} req
 * @param {string} url path without query
 */
export function wantsMarkdownCatalog(req, url) {
  if (url === '/catalog.md') return true;
  const accept = (req.headers.accept ?? '').toLowerCase();
  return accept.includes('text/markdown');
}
