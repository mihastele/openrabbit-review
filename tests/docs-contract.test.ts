import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const DOCS = [
  'README.md',
  'docs/features.md',
  'docs/configuration.md',
  'docs/operations.md',
  'docs/security.md',
  'docs/troubleshooting.md',
  'docs/hosting/raspberry-pi.md',
  'docs/integrations/github.md',
  'docs/integrations/codeberg.md',
  'docs/integrations/gitlab.md',
  'docs/integrations/bitbucket.md',
];

function links(markdown: string, file: string): string[] {
  const result: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const clean = target.split('#')[0];
    result.push(path.resolve(path.dirname(file), clean));
  }
  return result;
}

describe('Documentation contract', () => {
  it('documents every supported deployment and provider', () => {
    for (const file of DOCS) {
      assert.equal(fs.existsSync(file), true, `missing ${file}`);
    }
  });

  it('keeps documented environment variables in .env.example', () => {
    const env = fs.readFileSync('.env.example', 'utf8');
    const docs = DOCS.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const required = [
      'OPENRABBIT_ADMIN_TOKEN',
      'OPENRABBIT_PUBLIC_URL',
      'OPENRABBIT_ASYNC_WEBHOOKS',
      'GITHUB_TOKEN',
      'GITHUB_WEBHOOK_SECRET',
      'FORGEJO_TOKEN',
      'FORGEJO_WEBHOOK_SECRET',
      'FORGEJO_WEB_URL',
      'CLOUDFLARE_TUNNEL_TOKEN',
    ];
    for (const key of required) {
      assert.match(env, new RegExp(`^${key}=`, 'm'), `.env.example missing ${key}`);
      assert.match(docs, new RegExp(key), `docs missing ${key}`);
    }
  });

  it('keeps provider webhook paths aligned with the server', () => {
    const server = fs.readFileSync('src/server/app.ts', 'utf8');
    for (const endpoint of ['github', 'forgejo', 'gitlab', 'bitbucket']) {
      assert.match(server, new RegExp(`/api/webhooks/${endpoint}`));
    }
    assert.match(server, /\/api\/webhooks\/codeberg/);
  });

  it('has no broken relative documentation links', () => {
    for (const file of DOCS) {
      for (const target of links(fs.readFileSync(file, 'utf8'), file)) {
        assert.equal(fs.existsSync(target), true, `${file} -> missing ${target}`);
      }
    }
  });
});
