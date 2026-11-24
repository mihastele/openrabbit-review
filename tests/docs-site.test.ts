import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const PAGES = [
  'index.html',
  'getting-started.html',
  'features.html',
  'dashboard.html',
  'cli.html',
  'configuration.html',
  'security.html',
  'operations.html',
  'troubleshooting.html',
  'hosting/raspberry-pi.html',
  'integrations/github.html',
  'integrations/codeberg.html',
  'integrations/gitlab.html',
  'integrations/bitbucket.html',
];

const ASSETS = [
  'assets/docs.css',
  'assets/docs.js',
  'assets/favicon.svg',
  'search-index.js',
  '.nojekyll',
];

function htmlFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...htmlFiles(target));
    else if (entry.name.endsWith('.html')) result.push(target);
  }
  return result;
}

function internalLinks(file: string): string[] {
  const html = fs.readFileSync(file, 'utf8');
  const result: string[] = [];
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    result.push(target.split('#')[0].split('?')[0]);
  }
  return result;
}

describe('Documentation site contract', () => {
  it('builds every documentation page and shared asset', () => {
    for (const file of PAGES) {
      assert.equal(fs.existsSync(path.join('site', file)), true, `missing site/${file}`);
    }
    for (const file of ASSETS) {
      assert.equal(fs.existsSync(path.join('site', file)), true, `missing site/${file}`);
    }
  });

  it('ships a GitHub Pages deployment workflow', () => {
    const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
    assert.match(workflow, /actions\/configure-pages/);
    assert.match(workflow, /actions\/upload-pages-artifact/);
    assert.match(workflow, /actions\/deploy-pages/);
    assert.match(workflow, /path:\s*site/);
  });

  it('gives every generated page a complete shell', () => {
    for (const file of PAGES) {
      const html = fs.readFileSync(path.join('site', file), 'utf8');
      assert.match(html, /<html lang="en">/, `${file} missing lang`);
      assert.match(html, /<meta name="viewport"/, `${file} missing viewport`);
      assert.match(html, /OpenRabbit/, `${file} missing product name`);
      assert.match(html, /class="site-header"/, `${file} missing header`);
      assert.match(html, /class="sidebar(?:[ "])/, `${file} missing docs navigation`);
      assert.match(html, /assets\/docs\.css/, `${file} missing stylesheet`);
      assert.match(html, /assets\/docs\.js/, `${file} missing script`);
    }
  });

  it('has no broken internal links', () => {
    for (const file of htmlFiles('site')) {
      for (const target of internalLinks(file)) {
        if (!target) continue;
        const resolved = path.resolve(path.dirname(file), target);
        assert.equal(fs.existsSync(resolved), true, `${file} -> missing ${target}`);
      }
    }
  });

  it('makes the landing page a navigable feature tour', () => {
    const html = fs.readFileSync('site/index.html', 'utf8');
    for (const anchor of ['features', 'workflow', 'integrations', 'docs']) {
      assert.match(html, new RegExp(`id="${anchor}"`), `missing #${anchor}`);
    }
    for (const feature of [
      'Sticky walkthrough',
      'Inline findings',
      'Security scans',
      'Repository memory',
      'Codeberg',
      'Raspberry Pi',
    ]) {
      assert.match(html, new RegExp(feature, 'i'), `missing ${feature}`);
    }
  });

  it('indexes every page for client-side search', () => {
    const index = fs.readFileSync('site/search-index.js', 'utf8');
    for (const file of PAGES.filter((page) => page !== 'index.html')) {
      assert.match(index, new RegExp(file.replace('.', '\\.')), `missing ${file}`);
    }
  });

  it('keeps the docs source and site build wired into npm', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(typeof pkg.scripts?.['docs:build'], 'string');
    assert.equal(typeof pkg.devDependencies?.marked, 'string');
    assert.match(pkg.scripts?.test ?? '', /docs:build/);

    for (const source of [
      'docs/getting-started.md',
      'docs/dashboard.md',
      'docs/cli.md',
    ]) {
      assert.equal(fs.existsSync(source), true, `missing ${source}`);
    }
  });
});
