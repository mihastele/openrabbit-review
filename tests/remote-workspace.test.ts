import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { withRemoteWorkspace } from '../src/core/remote-workspace.js';

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-remote-origin-'));
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  execFileSync('git', ['init', '-b', 'main'], { cwd: work, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: work });
  execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: work });
  fs.writeFileSync(path.join(work, 'sample.ts'), 'export const ok = true;\n');
  execFileSync('git', ['add', '.'], { cwd: work });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: work, stdio: 'ignore' });
  return work;
}

describe('Remote workspace safety', () => {
  it('checks out a ref and removes the temporary workspace afterwards', async () => {
    const origin = createRepository();
    let checkedOutPath = '';
    await withRemoteWorkspace(
      {
        cloneUrl: `file://${origin}`,
        ref: 'refs/heads/main',
        providerHost: 'example.invalid',
        allowFileProtocol: true,
      },
      async (workspace) => {
        checkedOutPath = workspace.path;
        assert.equal(
          fs.readFileSync(path.join(checkedOutPath, 'sample.ts'), 'utf8'),
          'export const ok = true;\n'
        );
      }
    );
    assert.equal(fs.existsSync(checkedOutPath), false);
    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('cleans up when the callback throws', async () => {
    const origin = createRepository();
    let checkedOutPath = '';
    await assert.rejects(
      withRemoteWorkspace(
        {
          cloneUrl: `file://${origin}`,
          ref: 'refs/heads/main',
          providerHost: 'example.invalid',
          allowFileProtocol: true,
        },
        async (workspace) => {
          checkedOutPath = workspace.path;
          throw new Error('review failed');
        }
      ),
      /review failed/
    );
    assert.equal(fs.existsSync(checkedOutPath), false);
    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('rejects untrusted HTTPS hosts before running Git', async () => {
    await assert.rejects(
      withRemoteWorkspace(
        {
          cloneUrl: 'https://evil.example/repo.git',
          ref: 'refs/heads/main',
          providerHost: 'codeberg.org',
        },
        async () => undefined
      ),
      /not allowed/
    );
  });

  it('accepts file remotes only with the explicit test opt-in', async () => {
    await assert.rejects(
      withRemoteWorkspace(
        {
          cloneUrl: 'file:///tmp/nope',
          ref: 'refs/heads/main',
          providerHost: 'example.invalid',
        },
        async () => undefined
      ),
      /not allowed/
    );
  });
});
