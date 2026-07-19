import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpCatalogHtml, wantsMarkdownCatalog } from '../../src/routers/McpCatalogHtml.js';

describe('McpCatalogHtml', () => {
  const renderer = new McpCatalogHtml();

  it('wraps markdown in HTML with github markdown styles', () => {
    const html = renderer.render('# Title\n\nHello **world**.');
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /class="markdown-body"/);
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<strong>world<\/strong>/);
    assert.match(html, /github-markdown|markdown-body/);
    assert.match(html, /\/catalog\.md/);
  });

  it('syntax-highlights json code fences', () => {
    const html = renderer.render('```json\n{"a": 1}\n```');
    assert.match(html, /hljs-code-block/);
    assert.match(html, /language-json/);
  });

  it('wantsMarkdownCatalog respects path and Accept', () => {
    assert.equal(wantsMarkdownCatalog({ headers: {} }, '/catalog.md'), true);
    assert.equal(wantsMarkdownCatalog({ headers: { accept: 'text/html' } }, '/'), false);
    assert.equal(wantsMarkdownCatalog({ headers: { accept: 'text/markdown' } }, '/'), true);
    assert.equal(wantsMarkdownCatalog({ headers: { accept: '*/*' } }, '/'), false);
  });
});
