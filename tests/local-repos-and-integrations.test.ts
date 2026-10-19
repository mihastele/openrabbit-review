import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  browseFilesystem,
  findSubrepos,
  getCommitDiff,
  getCommitRangeDiff,
  getLocalGitDiff,
  getRepoCommits,
  getRepoMetadata,
  validateGitRepository,
} from '../src/core/git-utils.js';
import {
  handleBitbucketWebhookEvent,
  verifyBitbucketWebhook,
} from '../src/integrations/bitbucket.js';
import { createOpenRabbitServer } from '../src/server/app.js';
import {
  ReviewStore,
  SAMPLE_DIFF_TEMPLATES,
} from '../src/storage/review-store.js';

describe('Local Repositories & Integrations Suite', () => {
  it('validates local git repositories and extracts rich metadata', () => {
    // Current working directory is a git repo
    const valid = validateGitRepository(process.cwd());
    assert.equal(valid.valid, true);
    assert.ok(valid.topLevel);

    const meta = getRepoMetadata(process.cwd(), 'openRabbit-Local');
    assert.equal(meta.name, 'openRabbit-Local');
    assert.ok(meta.path);
    assert.ok(meta.branch);
    assert.ok(meta.headSha);
    assert.ok(typeof meta.isClean === 'boolean');
    assert.ok(meta.id.startsWith('repo_'));

    // Non-git folder should fail validation
    const tmpEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
    try {
      const invalid = validateGitRepository(tmpEmpty);
      assert.equal(invalid.valid, false);
      assert.ok(invalid.error?.includes('not a git repository'));
    } finally {
      fs.rmdirSync(tmpEmpty);
    }
  });

  it('lists commits and extracts individual commit unified diffs', () => {
    const commits = getRepoCommits(process.cwd(), { maxCount: 5 });
    assert.ok(commits.length > 0);
    const first = commits[0];

    assert.ok(first.sha.length >= 40);
    assert.ok(first.shortSha.length >= 7);
    assert.ok(first.author);
    assert.ok(first.subject);
    assert.ok(typeof first.filesChanged === 'number');

    // Retrieve diff for this commit
    const commitData = getCommitDiff(process.cwd(), first.sha);
    assert.equal(commitData.commit.sha, first.sha);
    assert.equal(commitData.commit.shortSha, first.shortSha);
    assert.ok(typeof commitData.diff === 'string');

    // Test getLocalGitDiff with commitSha option
    const localCommitDiff = getLocalGitDiff({
      cwd: process.cwd(),
      commitSha: first.sha,
    });
    assert.ok(localCommitDiff.diff);
    assert.equal(localCommitDiff.commitSha, first.sha);
  });

  it('manages repository registration lifecycle in ReviewStore', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-repos-store-'));
    try {
      const store = new ReviewStore(tmpDir);
      await store.init();

      // Add current repository
      const added = await store.addRepository(process.cwd(), 'Test Repo');
      assert.equal(added.name, 'Test Repo');

      const list = await store.listRepositories();
      assert.ok(list.some((r) => r.id === added.id));

      const found = await store.getRepository(added.id);
      assert.ok(found);
      assert.equal(found?.id, added.id);

      // Refresh repository
      const refreshed = await store.refreshRepository(added.id);
      assert.ok(refreshed);

      // Remove repository
      const removed = await store.removeRepository(added.id);
      assert.equal(removed, true);

      const afterRemove = await store.listRepositories();
      assert.equal(afterRemove.some((r) => r.id === added.id), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('provides REST API endpoints for repository management, commits, and commit reviews', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-api-repos-'));
    const serverInstance = await createOpenRabbitServer({
      port: 0,
      workspaceDir: process.cwd(),
      storageDir: tmpDir,
    });

    try {
      const baseUrl = `http://localhost:${serverInstance.port}`;

      // 1. GET /api/repos
      const getReposRes = await fetch(`${baseUrl}/api/repos`).then((r) =>
        r.json()
      );
      assert.ok(Array.isArray(getReposRes.repositories));

      // 2. POST /api/repos (add repository)
      const addRes = await fetch(`${baseUrl}/api/repos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: process.cwd(),
          name: 'My Workspace Repo',
        }),
      }).then((r) => r.json());
      assert.ok(addRes.repository);
      assert.equal(addRes.repository.name, 'My Workspace Repo');
      const repoId = addRes.repository.id;

      // 3. GET /api/repos/commits
      const commitsRes = await fetch(
        `${baseUrl}/api/repos/commits?id=${repoId}&maxCount=5`
      ).then((r) => r.json());
      assert.ok(Array.isArray(commitsRes.commits));
      assert.ok(commitsRes.commits.length > 0);
      const targetSha = commitsRes.commits[0].sha;

      // 4. GET /api/repos/commit
      const commitRes = await fetch(
        `${baseUrl}/api/repos/commit?id=${repoId}&sha=${targetSha}`
      ).then((r) => r.json());
      assert.ok(commitRes.commit);
      assert.equal(commitRes.commit.sha, targetSha);
      assert.ok(commitRes.parsedDiff);

      // 5. POST /api/repos/review (review a specific commit)
      const reviewCommitRes = await fetch(`${baseUrl}/api/repos/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: repoId,
          commitSha: targetSha,
        }),
      }).then((r) => r.json());

      assert.ok(reviewCommitRes.review);
      assert.ok(reviewCommitRes.review.walkthrough);
      assert.equal(reviewCommitRes.review.source, 'cli');
      assert.equal(reviewCommitRes.review.commitSha, targetSha);

      // 6. DELETE /api/repos
      const deleteRes = await fetch(`${baseUrl}/api/repos/${repoId}`, {
        method: 'DELETE',
      }).then((r) => r.json());
      assert.equal(deleteRes.removed, true);
    } finally {
      await serverInstance.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('verifies Bitbucket webhook signatures and processes Bitbucket PR reviews', async () => {
    const rawBody = JSON.stringify({ event: 'test' });
    const secret = 'bitbucket_secret_123';

    // Verify secret check
    assert.equal(verifyBitbucketWebhook(rawBody, undefined, secret), false);
    assert.equal(verifyBitbucketWebhook(rawBody, undefined, undefined), true);

    // Process Bitbucket webhook event
    const sample = SAMPLE_DIFF_TEMPLATES[0];
    const eventResult = await handleBitbucketWebhookEvent(
      'pullrequest:created',
      {
        repository: { full_name: 'acme/auth-service' },
        pullrequest: {
          id: 42,
          title: 'feat: add bitbucket review',
          source: { branch: { name: 'feat/bb' }, commit: { hash: '98765432' } },
          destination: { branch: { name: 'main' } },
          author: { display_name: 'Taylor' },
        },
        simulated_diff: sample.diff,
      }
    );

    assert.equal(eventResult.handled, true);
    assert.ok(eventResult.reviewResult);
    assert.equal(eventResult.reviewResult?.source, 'bitbucket');
    assert.equal(eventResult.reviewResult?.prNumber, 42);
    assert.ok(eventResult.reviewResult?.walkthrough.poem);
    assert.ok(eventResult.reviewResult?.findings.length > 0);

    // Test @openrabbit chat comment in Bitbucket
    const chatResult = await handleBitbucketWebhookEvent(
      'pullrequest:comment_created',
      {
        repository: { full_name: 'acme/auth-service' },
        pullrequest: { id: 42, title: 'feat: auth' },
        comment: {
          content: {
            raw: '@openrabbit explain the vulnerability here',
          },
        },
        simulated_diff: sample.diff,
      }
    );

    assert.equal(chatResult.handled, true);
    assert.ok(chatResult.chatReply);
    assert.ok(chatResult.action.includes('explain'));
  });

  it('serves Bitbucket webhook endpoint and on-demand integration endpoints via HTTP', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-api-integrations-'));
    const serverInstance = await createOpenRabbitServer({
      port: 0,
      workspaceDir: process.cwd(),
      storageDir: tmpDir,
    });

    try {
      const baseUrl = `http://localhost:${serverInstance.port}`;

      // 1. Bitbucket Webhook POST
      const bbWebhookRes = await fetch(`${baseUrl}/api/webhooks/bitbucket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Key': 'pullrequest:created',
        },
        body: JSON.stringify({
          repository: { full_name: 'team/microservice' },
          pullrequest: {
            id: 99,
            title: 'feat: bitbucket live test',
            source: { branch: { name: 'feat/test' }, commit: { hash: 'aabb1122' } },
            destination: { branch: { name: 'main' } },
            author: { display_name: 'Dev' },
          },
          simulated_diff: SAMPLE_DIFF_TEMPLATES[1].diff,
        }),
      }).then((r) => r.json());

      assert.equal(bbWebhookRes.handled, true);
      assert.ok(bbWebhookRes.reviewResult);
      assert.equal(bbWebhookRes.reviewResult.source, 'bitbucket');

      // 2. Status check verifies bitbucketConfigured property
      const statusRes = await fetch(`${baseUrl}/api/status`).then((r) =>
        r.json()
      );
      assert.ok('bitbucketConfigured' in statusRes.webhooks);
    } finally {
      await serverInstance.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('browses filesystem directory tree for folder selector with git repo detection', () => {
    const browse = browseFilesystem(process.cwd());
    assert.ok(browse.currentPath);
    assert.equal(browse.isGit, true);
    assert.ok(browse.folders.length > 0);
    assert.ok(browse.roots.length > 0);
    assert.ok(browse.homeDir);
    assert.ok(browse.workspaceDir);

    // Folders shouldn't contain node_modules
    assert.equal(browse.folders.some((f) => f.name === 'node_modules'), false);

    // Fallback on invalid path
    const fallback = browseFilesystem('D:/__non_existent_folder_xyz_1234__');
    assert.ok(fallback.currentPath);
    assert.ok(fs.existsSync(fallback.currentPath));
  });

  it('detects submodules and nested subrepositories in a root repository', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-subrepos-root-'));
    try {
      // 1. Initialize root repo
      execSync('git init -b main', { cwd: tmpRoot, stdio: 'ignore' });
      execSync('git config user.name "Test Runner"', { cwd: tmpRoot, stdio: 'ignore' });
      execSync('git config user.email "test@openrabbit.dev"', { cwd: tmpRoot, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# Root Monorepo\n');
      execSync('git add . && git commit -m "chore: initial commit in root"', { cwd: tmpRoot, stdio: 'ignore' });

      // 2. Create nested subrepo
      const sub1Dir = path.join(tmpRoot, 'packages', 'auth-service');
      fs.mkdirSync(sub1Dir, { recursive: true });
      execSync('git init -b main', { cwd: sub1Dir, stdio: 'ignore' });
      execSync('git config user.name "Test Runner"', { cwd: sub1Dir, stdio: 'ignore' });
      execSync('git config user.email "test@openrabbit.dev"', { cwd: sub1Dir, stdio: 'ignore' });
      fs.writeFileSync(path.join(sub1Dir, 'index.ts'), 'export const auth = true;\n');
      execSync('git add . && git commit -m "feat(auth): initial service"', { cwd: sub1Dir, stdio: 'ignore' });

      // 3. Create .gitmodules in root pointing to auth-service
      const gitmodulesContent = `[submodule "auth-service"]\n\tpath = packages/auth-service\n\turl = https://github.com/acme/auth-service.git\n\tbranch = main\n`;
      fs.writeFileSync(path.join(tmpRoot, '.gitmodules'), gitmodulesContent);

      // 4. Create another nested git repo (e.g. apps/web) without .gitmodules
      const sub2Dir = path.join(tmpRoot, 'apps', 'web-client');
      fs.mkdirSync(sub2Dir, { recursive: true });
      execSync('git init -b main', { cwd: sub2Dir, stdio: 'ignore' });
      execSync('git config user.name "Test Runner"', { cwd: sub2Dir, stdio: 'ignore' });
      execSync('git config user.email "test@openrabbit.dev"', { cwd: sub2Dir, stdio: 'ignore' });
      fs.writeFileSync(path.join(sub2Dir, 'App.tsx'), 'export const App = () => <div>Hello</div>;\n');
      execSync('git add . && git commit -m "feat(web): web client setup"', { cwd: sub2Dir, stdio: 'ignore' });

      // 5. Detect subrepos
      const subrepos = findSubrepos(tmpRoot);
      assert.equal(subrepos.length, 2);

      const authSub = subrepos.find((s) => s.relativePath === 'packages/auth-service');
      assert.ok(authSub);
      assert.equal(authSub?.name, 'auth-service');
      assert.equal(authSub?.isSubmodule, true);
      assert.equal(authSub?.isClean, true);
      assert.equal(authSub?.branch, 'main');
      assert.ok(authSub?.lastCommitMessage?.includes('initial service'));

      const webSub = subrepos.find((s) => s.relativePath === 'apps/web-client');
      assert.ok(webSub);
      assert.equal(webSub?.name, 'web-client');
      assert.equal(webSub?.isClean, true);

      // 6. Test ReviewStore getSubrepos and registerSubrepos
      const store = new ReviewStore(path.join(tmpRoot, 'data'));
      const subData = await store.getSubrepos(tmpRoot);
      assert.equal(subData.subrepos.length, 2);
      assert.equal(subData.rootRepo.subreposCount, 2);

      const registered = await store.registerSubrepos(tmpRoot);
      assert.equal(registered.length, 2);
      const allRepos = await store.listRepositories();
      assert.ok(allRepos.some((r) => r.name === 'auth-service'));
      assert.ok(allRepos.some((r) => r.name === 'web-client'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('provides REST API endpoints for folder browser and root subrepo management', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-api-subrepos-'));
    const serverInstance = await createOpenRabbitServer({
      port: 0,
      workspaceDir: process.cwd(),
      storageDir: tmpDir,
    });

    try {
      const baseUrl = `http://localhost:${serverInstance.port}`;

      // 1. GET /api/fs/browse
      const browseRes = await fetch(`${baseUrl}/api/fs/browse`).then((r) =>
        r.json()
      );
      assert.ok(browseRes.currentPath);
      assert.equal(browseRes.isGit, true);
      assert.ok(Array.isArray(browseRes.folders));
      assert.ok(Array.isArray(browseRes.roots));

      // 2. GET /api/repos/subrepos
      const subreposRes = await fetch(
        `${baseUrl}/api/repos/subrepos?path=${encodeURIComponent(process.cwd())}`
      ).then((r) => r.json());
      assert.ok(subreposRes.rootRepo);
      assert.ok(Array.isArray(subreposRes.subrepos));

      // 3. POST /api/repos/subrepos/register
      const registerRes = await fetch(`${baseUrl}/api/repos/subrepos/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootPath: process.cwd(),
          subrepoPaths: [],
        }),
      }).then((r) => r.json());
      assert.ok(Array.isArray(registerRes.registered));
    } finally {
      await serverInstance.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
