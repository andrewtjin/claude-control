// The status page shell and the hash-based CSP that lets exactly its own blocks run.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildStatusPage, loadStatusPage } from './statusPage.js';

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

describe('buildStatusPage', () => {
  it('hashes the single style and script blocks into the CSP', () => {
    const style = 'body { color: red; }';
    const script = 'console.log("hi");';
    const html = `<html><head><style>${style}</style></head><body><script>${script}</script></body></html>`;
    const page = buildStatusPage(html);
    expect(page.html).toBe(html);
    expect(page.csp).toContain(`style-src 'sha256-${hash(style)}'`);
    expect(page.csp).toContain(`script-src 'sha256-${hash(script)}'`);
    expect(page.csp).toContain("default-src 'none'");
    expect(page.csp).toContain("connect-src 'self'");
    expect(page.csp).toContain("frame-ancestors 'none'");
  });

  it('hashes a block with attributes on its opening tag', () => {
    const page = buildStatusPage('<style media="all">a{}</style><script type="module">1</script>');
    expect(page.csp).toContain(`style-src 'sha256-${hash('a{}')}'`);
    expect(page.csp).toContain(`script-src 'sha256-${hash('1')}'`);
  });

  it('refuses a page with more than one script block, since the CSP could not cover both', () => {
    expect(() => buildStatusPage('<style></style><script>1</script><script>2</script>')).toThrow(
      /exactly one <script> block, found 2/,
    );
  });

  it('refuses a page with no style block', () => {
    expect(() => buildStatusPage('<script>1</script>')).toThrow(
      /exactly one <style> block, found 0/,
    );
  });
});

describe('loadStatusPage', () => {
  it('loads the shipped page, which fetches the report endpoint and mounts every section', () => {
    const page = loadStatusPage();
    expect(page.html).toContain("fetch('/api/status'");
    for (const id of ['banner', 'components', 'incidents', 'footer', 'tip', 'daemons']) {
      expect(page.html).toContain(`id="${id}"`);
    }
    expect(page.csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(page.csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  });

  it('the shipped page carries no inline style attributes or event handlers the CSP would block', () => {
    const { html } = loadStatusPage();
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it('fails loudly when the page is missing rather than serving a 404 later', () => {
    expect(() => loadStatusPage('/definitely/not/here/index.html')).toThrow();
  });
});
