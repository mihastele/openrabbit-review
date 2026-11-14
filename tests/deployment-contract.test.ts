import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('Deployment configuration contract', () => {
  it('builds an ARM64-safe multi-stage runtime without hardcoded x64 assets', () => {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /ARG TARGETARCH/);
    assert.match(dockerfile, /amd64/);
    assert.match(dockerfile, /arm64/);
    assert.doesNotMatch(dockerfile, /gitleaks_\$\{GITLEAKS_VER\}_linux_x64\.tar\.gz/);
    assert.match(dockerfile, /FROM .* AS build/);
    assert.match(dockerfile, /FROM .* AS lite/);
    assert.match(dockerfile, /FROM lite AS full/);
    assert.match(dockerfile, /USER node/);
    assert.match(dockerfile, /HEALTHCHECK/);
    assert.match(dockerfile, /npm ci --omit=dev/);
  });

  it('defaults Compose to private binding, async webhooks, and persisted data', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /OPENRABBIT_BIND_ADDRESS:-127\.0\.0\.1/);
    assert.match(compose, /OPENRABBIT_ASYNC_WEBHOOKS: "true"/);
    assert.match(compose, /\.\/data:\/app\/data/);
    assert.match(compose, /NODE_ENV: production/);
  });

  it('keeps secrets, runtime data, and build output out of the Docker context', () => {
    const dockerignore = read('.dockerignore');
    for (const entry of ['.git', '.env', '.hermes', 'data', 'node_modules', 'dist']) {
      assert.match(dockerignore, new RegExp(`^${entry.replace('.', '\\.')}$`, 'm'));
    }
    const gitignore = read('.gitignore');
    assert.match(gitignore, /data\/\*\.json/);
    assert.match(gitignore, /!data\/\.gitkeep/);
  });

  it('ships a Cloudflare tunnel override and documented environment', () => {
    const tunnel = read('deploy/docker-compose.tunnel.yml');
    assert.match(tunnel, /cloudflare\/cloudflared:/);
    assert.match(tunnel, /CLOUDFLARE_TUNNEL_TOKEN/);
    const env = read('.env.example');
    assert.match(env, /OPENRABBIT_ADMIN_TOKEN=/);
    assert.match(env, /FORGEJO_API_URL=/);
  });
});
