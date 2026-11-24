import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

describe('Raspberry Pi setup script contract', () => {
  const script = fs.readFileSync('scripts/setup-pi.sh', 'utf8');

  it('fails fast and protects generated secrets', () => {
    assert.match(script, /set -euo pipefail/);
    assert.match(script, /chmod 600 \.env/);
    assert.match(script, /umask 077/);
    assert.doesNotMatch(script, /cat \.env/);
  });

  it('uses pinned/container inputs and verifies health', () => {
    assert.doesNotMatch(script, /:latest/);
    assert.match(script, /docker compose up -d --build/);
    assert.match(script, /curl -fsS/);
    assert.match(script, /healthz/);
  });

  it('rejects 32-bit hosts explicitly', () => {
    assert.match(script, /armv7l/);
    assert.match(script, /64-bit/);
  });
});
