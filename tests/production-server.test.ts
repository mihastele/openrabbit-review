import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createOpenRabbitServer } from '../src/server/app.js';

const ORIGINAL_ENV = { ...process.env };

let tempDirs: string[] = [];
let openServers: Array<{ close: () => Promise<void> }> = [];

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function startServer(env: Record<string, string | undefined> = {}) {
  Object.assign(process.env, env);
  const instance = await createOpenRabbitServer({
    port: 0,
    workspaceDir: process.cwd(),
    storageDir: tempDir('openrabbit-production-server-'),
  });
  openServers.push(instance);
  return `http://127.0.0.1:${instance.port}`;
}

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.OPENRABBIT_ADMIN_TOKEN = 'test-admin-token';
});

afterEach(async () => {
  await Promise.all(openServers.map((server) => server.close()));
  openServers = [];
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  process.env = { ...ORIGINAL_ENV };
});

describe('Production HTTP security', () => {
  it('serves a minimal public health endpoint', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const statusResponse = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusResponse.status, 401);
  });

  it('logs in with an HttpOnly session and unlocks API routes', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-admin-token' }),
    });

    assert.equal(response.status, 204);
    const setCookie = response.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    assert.equal((await response.text()).includes('test-admin-token'), false);

    const cookie = setCookie.split(';')[0];
    const statusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: { cookie },
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.version, '1.0.0');
  });

  it('rejects a wrong token and API calls without a session', async () => {
    const baseUrl = await startServer();
    const wrong = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(`${baseUrl}/api/reviews`)).status, 401);
  });

  it('requires webhook signatures in production instead of dashboard auth', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({ action: 'opened' }),
    });
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.error, /signature/i);
  });

  it('starts a production install with no fabricated review history', async () => {
    const baseUrl = await startServer();
    const login = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-admin-token' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${baseUrl}/api/reviews`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.reviews, []);
    assert.equal(data.analytics.totalReviews || 0, 0);
  });

  it('rejects oversized request bodies without killing the server', async () => {
    const baseUrl = await startServer({ OPENRABBIT_MAX_BODY_BYTES: '64' });
    const login = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-admin-token' }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${baseUrl}/api/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie,
      },
      body: JSON.stringify({ diff: 'x'.repeat(200) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Request body too large' });
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  });
});
