import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';
import {
  handleForgejoWebhookEvent,
  mapForgejoComment,
  mapForgejoPullRequest,
  parseForgejoTarget,
  resolveForgejoGitUsername,
  verifyForgejoWebhookSignature,
} from '../src/integrations/forgejo.js';
import { createOpenRabbitServer } from '../src/server/app.js';
import { SAMPLE_DIFF_TEMPLATES } from '../src/storage/review-store.js';

function config() {
  const value = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
  value.llm.provider = 'heuristic';
  value.reviewer = 'hybrid';
  return value;
}

const basePayload = () => ({
  action: 'opened',
  number: 7,
  repository: {
    full_name: 'acme/auth',
    html_url: 'https://codeberg.org/acme/auth',
    clone_url: 'https://codeberg.org/acme/auth.git',
  },
  pull_request: {
    number: 7,
    title: 'feat: add token rotation',
    user: { login: 'alex' },
    base: { ref: 'main' },
    head: { ref: 'feat/auth', sha: 'a1b2c3d4' },
    draft: false,
  },
  simulated_diff: SAMPLE_DIFF_TEMPLATES[0].diff,
});

describe('Codeberg / Forgejo integration', () => {
  const originalEnv = { ...process.env };
  const servers: Array<{ close: () => Promise<void> }> = [];
  const dirs: string[] = [];

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.FORGEJO_TOKEN;
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
    process.env = { ...originalEnv };
  });

  it('resolves the authenticated Forgejo user for private Git auth', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ login: 'alice' }), { status: 200 });
    assert.equal(
      await resolveForgejoGitUsername('token', fakeFetch as typeof fetch),
      'alice'
    );
  });

  it('verifies Forgejo HMAC signatures', () => {
    const body = JSON.stringify({ action: 'opened' });
    const secret = 'forgejo-secret';
    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');

    assert.equal(verifyForgejoWebhookSignature(body, digest, secret), true);
    assert.equal(verifyForgejoWebhookSignature(body, `sha256=${digest}`, secret), true);
    assert.equal(verifyForgejoWebhookSignature(body, 'bad', secret), false);
    assert.equal(verifyForgejoWebhookSignature(body, undefined, secret), false);
  });

  it('maps pull request metadata and ignores unsupported actions', () => {
    const mapped = mapForgejoPullRequest(basePayload() as any);
    assert.equal(mapped?.owner, 'acme');
    assert.equal(mapped?.repo, 'auth');
    assert.equal(mapped?.pullNumber, 7);
    assert.equal(mapped?.commitSha, 'a1b2c3d4');
    assert.equal(mapped?.baseBranch, 'main');
    assert.equal(mapped?.headBranch, 'feat/auth');

    assert.equal(
      mapForgejoPullRequest({ ...basePayload(), action: 'closed' } as any),
      null
    );
  });

  it('maps PR comments only when they belong to a pull request', () => {
    const payload = {
      action: 'created',
      is_pull: true,
      comment: { id: 99, body: '@openrabbit explain' },
      issue: { number: 7, title: 'feat: auth' },
      repository: { full_name: 'acme/auth' },
    };
    assert.equal(mapForgejoComment(payload as any)?.commentId, 99);
    assert.equal(
      mapForgejoComment({ ...payload, is_pull: false } as any),
      null
    );
  });

  it('reviews simulated pull_request events without network writes', async () => {
    const result = await handleForgejoWebhookEvent(
      'pull_request',
      basePayload(),
      config()
    );
    assert.equal(result.handled, true);
    assert.equal(result.reviewResult?.source, 'forgejo');
    assert.equal(result.reviewResult?.prNumber, 7);
    assert.ok((result.reviewResult?.findings.length || 0) > 0);
    assert.equal(result.postedToForgejo, false);
  });

  it('handles synchronized events and ignores closed pull requests', async () => {
    const synchronized = await handleForgejoWebhookEvent(
      'pull_request',
      { ...basePayload(), action: 'synchronized' },
      config()
    );
    assert.equal(synchronized.handled, true);

    const closed = await handleForgejoWebhookEvent(
      'pull_request',
      { ...basePayload(), action: 'closed' },
      config()
    );
    assert.equal(closed.handled, false);
  });

  it('answers @openrabbit PR timeline comments', async () => {
    const result = await handleForgejoWebhookEvent(
      'issue_comment',
      {
        action: 'created',
        is_pull: true,
        comment: { id: 10, body: '@openrabbit explain the vulnerability' },
        issue: { number: 7, title: 'feat: auth' },
        repository: { full_name: 'acme/auth' },
        simulated_diff: SAMPLE_DIFF_TEMPLATES[0].diff,
      },
      config()
    );
    assert.equal(result.handled, true);
    assert.ok(result.chatReply?.length);
    assert.match(result.action, /explain/);
  });

  it('parses short and Codeberg PR targets safely', () => {
    assert.deepEqual(parseForgejoTarget('acme/auth#7'), {
      owner: 'acme',
      repo: 'auth',
      pullNumber: 7,
    });
    assert.deepEqual(parseForgejoTarget('https://codeberg.org/acme/auth/pulls/7'), {
      owner: 'acme',
      repo: 'auth',
      pullNumber: 7,
    });
    assert.equal(
      parseForgejoTarget('https://evil-codeberg.org/acme/auth/pulls/7'),
      null
    );
  });

  it('accepts signed Codeberg webhooks asynchronously', async () => {
    process.env.FORGEJO_WEBHOOK_SECRET = 'codeberg-secret';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-forgejo-http-'));
    dirs.push(dir);
    const instance = await createOpenRabbitServer({
      port: 0,
      workspaceDir: process.cwd(),
      storageDir: dir,
    });
    servers.push(instance);
    const rawBody = JSON.stringify(basePayload());
    const signature = crypto
      .createHmac('sha256', process.env.FORGEJO_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    const baseUrl = `http://127.0.0.1:${instance.port}`;

    for (const pathName of ['/api/webhooks/forgejo', '/api/webhooks/codeberg']) {
      const response = await fetch(`${baseUrl}${pathName}?async=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gitea-Event': 'pull_request',
          'X-Gitea-Signature': signature,
          'X-Gitea-Delivery': pathName.includes('codeberg')
            ? 'delivery-codeberg-1'
            : 'delivery-forgejo-1',
        },
        body: rawBody,
      });
      assert.equal(response.status, 202);
      const accepted = (await response.json()) as { accepted: boolean; jobId: string };
      assert.equal(accepted.accepted, true);
      assert.ok(accepted.jobId);
    }
  });
});
