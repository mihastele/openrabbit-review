import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'site');
const REPO = 'https://github.com/mihastele/openrabbit-review';

const NAV = [
  {
    group: 'Start here',
    items: [
      {
        href: 'getting-started.html',
        source: 'docs/getting-started.md',
        label: 'Getting started',
        short: 'Install and first review',
        description:
          'Install OpenRabbit on a Raspberry Pi or any Docker host, open the dashboard, and run a real review.',
        eyebrow: 'Start here',
      },
      {
        href: 'dashboard.html',
        source: 'docs/dashboard.md',
        label: 'Dashboard guide',
        short: 'The four screens',
        description:
          'A practical tour of Home, Review, Activity, Settings, and the review artifact itself.',
        eyebrow: 'Start here',
      },
      {
        href: 'cli.html',
        source: 'docs/cli.md',
        label: 'CLI and CI',
        short: 'Local and pipeline review',
        description:
          'Review local diffs and live pull requests, write SARIF, and fail a pipeline on a severity threshold.',
        eyebrow: 'Start here',
      },
    ],
  },
  {
    group: 'The product',
    items: [
      {
        href: 'features.html',
        source: 'docs/features.md',
        label: 'Features',
        short: 'Everything in the box',
        description:
          'Every review capability: sticky walkthroughs, inline findings, chat, rules, scanners, reports, and local repositories.',
        eyebrow: 'Product',
      },
      {
        href: 'configuration.html',
        source: 'docs/configuration.md',
        label: 'Configuration',
        short: 'Profiles, YAML, rules',
        description:
          'Profiles, path filters, custom rules, review engines, scanner switches, and the environment variables that matter.',
        eyebrow: 'Product',
      },
      {
        href: 'security.html',
        source: 'docs/security.md',
        label: 'Security model',
        short: 'Trust boundaries',
        description:
          'Authentication, webhook verification, secret handling, data boundaries, and the hardening checklist.',
        eyebrow: 'Product',
      },
    ],
  },
  {
    group: 'Run it',
    items: [
      {
        href: 'hosting/raspberry-pi.html',
        source: 'docs/hosting/raspberry-pi.md',
        label: 'Raspberry Pi',
        short: 'The home server',
        description:
          'The opinionated single-user deployment for 64-bit Raspberry Pi OS, including a public webhook path.',
        eyebrow: 'Deploy',
      },
      {
        href: 'operations.html',
        source: 'docs/operations.md',
        label: 'Operations',
        short: 'Backups and upgrades',
        description:
          'Health checks, logs, backups, upgrades, retention, and recovery for a service that lives on your own hardware.',
        eyebrow: 'Deploy',
      },
      {
        href: 'troubleshooting.html',
        source: 'docs/troubleshooting.md',
        label: 'Troubleshooting',
        short: 'When review stops',
        description:
          'Work from symptom to cause across auth, webhooks, provider permissions, scanners, clones, and model calls.',
        eyebrow: 'Deploy',
      },
    ],
  },
  {
    group: 'Integrations',
    items: [
      {
        href: 'integrations/github.html',
        source: 'docs/integrations/github.md',
        label: 'GitHub',
        short: 'github.com + Enterprise',
        description:
          'Fine-grained token permissions, pull-request webhooks, test delivery, and the expected review behavior.',
        eyebrow: 'Integration',
        provider: 'GH',
      },
      {
        href: 'integrations/codeberg.html',
        source: 'docs/integrations/codeberg.md',
        label: 'Codeberg / Forgejo',
        short: 'Codeberg, Forgejo, Gitea',
        description:
          'One configurable Forgejo adapter for Codeberg, self-hosted Forgejo, and compatible Gitea instances.',
        eyebrow: 'Integration',
        provider: 'CB',
      },
      {
        href: 'integrations/gitlab.html',
        source: 'docs/integrations/gitlab.md',
        label: 'GitLab',
        short: 'gitlab.com + self-hosted',
        description:
          'Merge-request tokens, webhook events, self-hosted API URLs, and the review flow.',
        eyebrow: 'Integration',
        provider: 'GL',
      },
      {
        href: 'integrations/bitbucket.html',
        source: 'docs/integrations/bitbucket.md',
        label: 'Bitbucket',
        short: 'Bitbucket Cloud',
        description:
          'Workspace access tokens, pull-request webhooks, and automatic walkthrough comments.',
        eyebrow: 'Integration',
        provider: 'BB',
      },
    ],
  },
];

const ORDERED = NAV.flatMap((group) => group.items);
const BRAND_MARK = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path d="M10.2 15.1c-2.6-4.5-1.8-9.2.8-10.1 2.4-.8 4.7 2.2 5 6.2.4-4 2.6-7 5-6.2 2.6.9 3.4 5.6.8 10.1 2.7 2.1 4.2 5.2 3.2 8.2-1.1 3.6-5.4 5.6-9 5.6s-7.9-2-9-5.6c-1-3 .5-6.1 3.2-8.2Z" fill="currentColor"/>
  <circle cx="13" cy="19" r="1.3" fill="#0a0b0d"/>
  <circle cx="20" cy="19" r="1.3" fill="#0a0b0d"/>
  <path d="M15.1 22.8c.5.6 1.3.6 1.8 0" fill="none" stroke="#0a0b0d" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;

const ICON = {
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.7 8.7 0 1 0 11.2 11.2Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-4-4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrowUp: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4m-4 4 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.2-.8.1-.8.1-.8 1.3.1 2 1.4 2 1.4 1.2 2 3.1 1.4 3.8 1.1.1-.9.5-1.4.9-1.7-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.3-.1-.3-.5-1.6.1-3.3 0 0 1-.3 3.4 1.2a11.7 11.7 0 0 1 6.2 0c2.4-1.5 3.4-1.2 3.4-1.2.6 1.7.2 3 .1 3.3.8.9 1.2 2 1.2 3.3 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.9.6A11.5 11.5 0 0 0 12 .7Z"/></svg>',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function slugify(value) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/gi, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function prefixFor(href) {
  const depth = href.split('/').length - 1;
  return '../'.repeat(depth);
}

function renderLinks(markdown) {
  return markdown.replace(
    /\]\(([^)\s]+)\.md(#[^)\s]+)?\)/g,
    (_, target, anchor = '') => `](${target}.html${anchor})`
  );
}

function enrichArticle(html) {
  let result = html.replace(
    /<h([23])>(.*?)<\/h\1>/gs,
    (_, level, content) => {
      const id = slugify(content);
      return `<h${level} id="${id}">${content}<a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(
        content.replace(/<[^>]+>/g, '')
      )}">#</a></h${level}>`;
    }
  );
  result = result.replace(/<table>/g, '<div class="table-wrap"><table>');
  result = result.replace(/<\/table>/g, '</table></div>');
  result = result.replace(
    /<a href="(https?:[^"]+)">/g,
    '<a href="$1" target="_blank" rel="noreferrer">'
  );
  return result;
}

function tableOfContents(html) {
  const items = [];
  for (const match of html.matchAll(/<h([23]) id="([^"]+)">(.*?)<\/h\1>/gs)) {
    const text = match[3]
      .replace(/<a class="heading-anchor"[\s\S]*?<\/a>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    items.push({ level: Number(match[1]), id: match[2], text });
  }
  return items;
}

function wordCount(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`\-[\]()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function header(prefix, options = {}) {
  const productHref = `${prefix}index.html`;
  return `<header class="site-header">
  <a class="brand" href="${productHref}" aria-label="OpenRabbit documentation home">
    <span class="brand-mark">${BRAND_MARK}</span>
    <span class="brand-word">OpenRabbit</span>
    <span class="brand-badge">docs</span>
  </a>
  <nav class="header-nav" aria-label="Primary">
    <a href="${productHref}#features">Product</a>
    <a href="${productHref}#workflow">Workflow</a>
    <a href="${productHref}#integrations">Integrations</a>
    <a href="${prefix}index.html#docs">All docs</a>
  </nav>
  <div class="header-tools">
    <button class="search-trigger" type="button" data-search-open aria-label="Search documentation">
      ${ICON.search}<span>Search docs</span><kbd>⌘K</kbd>
    </button>
    <button class="icon-button theme-toggle" type="button" data-theme-toggle aria-label="Toggle color theme">
      <span class="theme-icon-dark">${ICON.sun}</span><span class="theme-icon-light">${ICON.moon}</span>
    </button>
    <a class="icon-button github-button" href="${REPO}" target="_blank" rel="noreferrer" aria-label="OpenRabbit on GitHub">${ICON.github}</a>
    <button class="icon-button menu-toggle" type="button" data-sidebar-toggle aria-label="Open documentation navigation" aria-expanded="false">${ICON.menu}</button>
  </div>
</header>`;
}

function sidebar(prefix, current) {
  const groups = NAV.map(
    (group) => `<section class="nav-group">
      <p class="nav-label">${group.group}</p>
      ${group.items
        .map(
          (item) => `<a class="nav-item${item.href === current ? ' active' : ''}" href="${prefix}${item.href}"${
            item.href === current ? ' aria-current="page"' : ''
          }>
            <span>${item.label}</span>
            <small>${item.short}</small>
          </a>`
        )
        .join('\n')}
    </section>`
  ).join('\n');

  return `<aside class="sidebar" data-sidebar aria-label="Documentation navigation">
  <div class="sidebar-inner">
    <div class="sidebar-mobile-head">
      <span class="nav-label">Documentation</span>
      <button class="icon-button" type="button" data-sidebar-close aria-label="Close navigation">×</button>
    </div>
    <a class="sidebar-home${current === '' ? ' active' : ''}" href="${prefix}index.html">
      <span class="sidebar-home-mark">${BRAND_MARK}</span>
      <span><strong>Field manual</strong><small>OpenRabbit v1.0</small></span>
    </a>
    ${groups}
    <div class="sidebar-status">
      <span class="status-pulse"></span>
      <div><strong>Self-hosted by design</strong><small>Your code. Your history. Your hardware.</small></div>
    </div>
    <div class="sidebar-links">
      <a href="${REPO}" target="_blank" rel="noreferrer">${ICON.github} Source</a>
      <a href="${REPO}/issues" target="_blank" rel="noreferrer">Issues</a>
    </div>
  </div>
</aside>
<div class="sidebar-scrim" data-sidebar-close></div>`;
}

function docPage({ item, body, headings, index }) {
  const prefix = prefixFor(item.href);
  const toc = headings
    .filter((heading) => heading.level === 2)
    .map(
      (heading) =>
        `<a class="toc-link" href="#${heading.id}" data-toc-link="${heading.id}">${escapeHtml(
          heading.text
        )}</a>`
    )
    .join('\n');
  const previous = ORDERED[index - 1];
  const next = ORDERED[index + 1];
  const readTime = Math.max(2, Math.round(wordCount(body) / 220));
  const sourceUrl = `${REPO}/blob/main/${item.source}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(item.description)}">
  <meta name="theme-color" content="#0a0b0d">
  <meta property="og:title" content="${escapeHtml(item.label)} · OpenRabbit docs">
  <meta property="og:description" content="${escapeHtml(item.description)}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary">
  <title>${escapeHtml(item.label)} · OpenRabbit docs</title>
  <link rel="icon" href="${prefix}assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${prefix}assets/docs.css">
</head>
<body class="docs-page" data-root="${prefix}" data-page="${item.href}">
  <div class="page-progress" data-page-progress></div>
  ${header(prefix)}
  <div class="docs-layout">
    ${sidebar(prefix, item.href)}
    <main class="doc-main" id="main-content">
      <div class="breadcrumbs">
        <a href="${prefix}index.html">Docs</a><span>/</span>
        <span>${escapeHtml(item.eyebrow)}</span><span>/</span>
        <span>${escapeHtml(item.label)}</span>
      </div>
      <header class="doc-hero">
        <div class="eyebrow">${escapeHtml(item.eyebrow)} <span class="eyebrow-rule"></span> ${readTime} min read</div>
        <h1>${escapeHtml(item.label)}</h1>
        <p>${escapeHtml(item.description)}</p>
        <div class="doc-meta">
          <span><i class="meta-dot"></i> OpenRabbit v1.0</span>
          <a href="${sourceUrl}" target="_blank" rel="noreferrer">Edit this page ${ICON.arrow}</a>
        </div>
      </header>
      <div class="article-grid">
        <article class="doc-content">
          ${body}
          <footer class="doc-footer">
            <a class="edit-card" href="${sourceUrl}" target="_blank" rel="noreferrer">
              <span class="edit-index">${String(index + 1).padStart(2, '0')}</span>
              <span><strong>Found something to improve?</strong><small>Edit ${item.source} on GitHub</small></span>
              ${ICON.arrow}
            </a>
            <nav class="page-pagination" aria-label="Documentation pagination">
              ${
                previous
                  ? `<a class="pagination-link previous" href="${prefix}${previous.href}"><small>Previous</small><strong>${escapeHtml(
                      previous.label
                    )}</strong></a>`
                  : '<span></span>'
              }
              ${
                next
                  ? `<a class="pagination-link next" href="${prefix}${next.href}"><small>Next</small><strong>${escapeHtml(
                      next.label
                    )}</strong>${ICON.arrow}</a>`
                  : ''
              }
            </nav>
          </footer>
        </article>
        <aside class="toc" aria-label="On this page">
          <p>On this page</p>
          ${toc}
          <a class="toc-top" href="#main-content">${ICON.arrowUp} Back to top</a>
        </aside>
      </div>
    </main>
  </div>
  <footer class="site-footer">
    <div class="footer-brand"><span class="brand-mark small">${BRAND_MARK}</span><span>OpenRabbit</span></div>
    <p>Self-hosted pull-request review, walkthroughs, chat, and security scanning.</p>
    <div class="footer-links"><a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a><a href="${REPO}/blob/main/README.md" target="_blank" rel="noreferrer">README</a><a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License</a></div>
  </footer>
  <script src="${prefix}search-index.js"></script>
  <script src="${prefix}assets/docs.js"></script>
</body>
</html>`;
}

function buildPages() {
  const search = [];
  ORDERED.forEach((item, index) => {
    const source = fs.readFileSync(path.join(ROOT, item.source), 'utf8');
    const markdown = source.replace(/^#\s+.*\n+/, '');
    const parsed = marked.parse(renderLinks(markdown), { gfm: true, breaks: false });
    const body = enrichArticle(parsed);
    const headings = tableOfContents(body);
    const output = path.join(OUT, item.href);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, docPage({ item, body, headings, index }));
    search.push({
      href: item.href,
      title: item.label,
      group: item.eyebrow,
      description: item.description,
      headings: headings.map((heading) => heading.text),
    });
  });
  return search;
}

function copyStatic(search) {
  const source = path.join(ROOT, 'site-src');
  fs.cpSync(path.join(source, 'assets'), path.join(OUT, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(source, 'index.html'), path.join(OUT, 'index.html'));
  fs.writeFileSync(
    path.join(OUT, 'search-index.js'),
    `window.OPENRABBIT_SEARCH = ${JSON.stringify(search, null, 2)};\n`
  );
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'site-src', 'index.html'))) {
    throw new Error('Missing site-src/index.html');
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const search = buildPages();
  copyStatic(search);
  console.log(`Built ${ORDERED.length + 1} pages into ${path.relative(ROOT, OUT)}/`);
}

main();
