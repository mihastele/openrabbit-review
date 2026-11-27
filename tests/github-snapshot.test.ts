import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  GitHubPRChangedError,
  handleGitHubWebhookEvent,
  runGitHubOnDemandReview,
} from '../src/integrations/github.js';

const repository = 'acme/openrabbit';
const pullPath = '/pulls/7';
const baseSha = 'a'.repeat(40);
const newSha = 'c'.repeat(40);
const diff = [
  'diff --git a/queue.ts b/queue.ts',
  '--- a/queue.ts',
  '+++ b/queue.ts',
  '@@ -1 +1 @@',
  '-export const isFirst = (count: number) => count === 0;',
  '+export const isFirst = (count: number) => count == 0;',
  '',
].join('\n');

function pullRequest(headSha: string) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    title: 'Compare queue delivery count',
    base: { sha: baseSha, ref: 'main' },
    head: {
      sha: headSha,
      ref: 'feature',
      repo: { clone_url: 'https://fixture.invalid/contributor/openrabbit.git' },
    },
  };
}

function webhook(headSha: string) {
  return {
    action: 'synchronize',
    repository: { full_name: repository },
    // The event base can lag behind the current base branch.
    pull_request: { ...pullRequest(headSha), base: { sha: 'd'.repeat(40), ref: 'main' } },
  };
}

function configureEnvironment(t: TestContext, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

function createFixture(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-github-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const origin = path.join(directory, 'origin');
  const gitConfig = path.join(directory, 'gitconfig');
  configureEnvironment(t, {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GITHUB_TOKEN: 'test-token',
    GITHUB_BOT_LOGIN: '',
    GITHUB_WEB_HOST: 'fixture.invalid',
    GITHUB_API_URL: 'https://api.fixture.invalid',
    OPENRABBIT_DATA_DIR: path.join(directory, 'data'),
  });
  fs.mkdirSync(origin);
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: origin, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  }
  git('init');
  git('config', 'user.name', 'OpenRabbit Tests');
  git('config', 'user.email', 'tests@example.test');
  fs.writeFileSync(path.join(origin, 'queue.ts'), 'export const isFirst = (count: number) => count == 0;\n');
  git('add', 'queue.ts');
  git('commit', '-m', 'Add delivery helper');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/7/head', head);
  git('config', '--file', gitConfig, `url.${pathToFileURL(origin).href}.insteadOf`,
    `https://fixture.invalid/${repository}.git`);
  return head;
}

type ExpectedRequest = {
  path: string;
  response: Response;
  method?: string;
  check?: (options: RequestInit) => void;
};

function mockGitHub(t: TestContext, ...requests: ExpectedRequest[]) {
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit = {}) => {
    const url = new URL(input);
    const expected = requests.shift();
    assert.ok(expected, 'Unexpected GitHub request: ' + url.pathname);
    const prefix = expected.path === '/user' ? '' : '/repos/' + repository;
    assert.equal(url.pathname + url.search, prefix + expected.path);
    assert.equal(options.method ?? 'GET', expected.method ?? 'GET');
    expected.check?.(options);
    return expected.response;
  });
  t.after(() => assert.deepEqual(requests, []));
}

function configRequest(response = new Response('llm:\n  provider: heuristic\n')): ExpectedRequest {
  return { path: '/contents/.openrabbit.yaml?ref=' + baseSha, response };
}

const compareRequest = (head: string): ExpectedRequest => ({
  path: '/compare/' + baseSha + '...' + head,
  response: new Response(diff),
});

const publisherRequest = (): ExpectedRequest => ({
  path: '/user',
  response: Response.json({ login: 'review-bot' }),
});

it('skips an old webhook before reading config, fetching a diff, or posting', async (t) => {
  mockGitHub(t, { path: pullPath, response: Response.json(pullRequest(newSha)) });
  const result = await handleGitHubWebhookEvent('pull_request', webhook('b'.repeat(40)));
  assert.equal(result.reviewResult, undefined);
  assert.equal(result.postedToGitHub, false);
  assert.match(result.action, /head is no longer current/);
});

it('uses the base commit automatic-review policy for a fork PR', async (t) => {
  configureEnvironment(t, { GITHUB_TOKEN: 'test-token' });
  mockGitHub(t,
    { path: pullPath, response: Response.json(pullRequest(newSha)) },
    configRequest(new Response('reviews:\n  auto_review:\n    enabled: false\n')),
  );
  const result = await handleGitHubWebhookEvent('pull_request', webhook(newSha));
  assert.equal(result.handled, false);
  assert.match(result.action, /base branch automatic review policy/);
});

it('reviews a fork ref in the base repository and publishes against the verified head', async (t) => {
  const head = createFixture(t);
  const pr = pullRequest(head);
  mockGitHub(t,
    { path: pullPath, response: Response.json(pr) },
    configRequest(),
    compareRequest(head),
    publisherRequest(),
    { path: '/issues/7/comments?per_page=100', response: Response.json([]) },
    { path: pullPath, response: Response.json(pr) },
    { path: '/issues/7/comments', method: 'POST', response: Response.json({ id: 11 }) },
    { path: '/pulls/7/reviews?per_page=100', response: Response.json([]) },
    { path: pullPath, response: Response.json(pr) },
    {
      path: '/pulls/7/reviews',
      method: 'POST',
      response: Response.json({ id: 12 }),
      check: ({ body }) => {
        const review = JSON.parse(String(body));
        assert.equal(review.commit_id, head);
        assert.equal(review.comments[0].path, 'queue.ts');
        assert.equal(review.comments[0].line, 1);
      },
    },
  );
  const result = await handleGitHubWebhookEvent('pull_request', webhook(head));
  assert.equal(result.postedToGitHub, true);
  assert.equal(result.reviewResult?.commitSha, head);
  assert.equal(result.reviewResult?.rawDiff, diff);
});

it('skips a webhook whose fork ref moves between GitHub metadata and checkout', async (t) => {
  createFixture(t);
  mockGitHub(t,
    { path: pullPath, response: Response.json(pullRequest(newSha)) },
    configRequest(),
    compareRequest(newSha),
  );
  const result = await handleGitHubWebhookEvent('pull_request', webhook(newSha));
  assert.equal(result.reviewResult, undefined);
  assert.equal(result.postedToGitHub, false);
  assert.match(result.action, /head changed before checkout/);
});

it('reports a posted walkthrough and skips inline comments if the head changes between writes', async (t) => {
  const head = createFixture(t);
  const pr = pullRequest(head);
  mockGitHub(t,
    { path: pullPath, response: Response.json(pr) },
    configRequest(),
    compareRequest(head),
    publisherRequest(),
    { path: '/issues/7/comments?per_page=100', response: Response.json([]) },
    { path: pullPath, response: Response.json(pr) },
    { path: '/issues/7/comments', method: 'POST', response: Response.json({ id: 11 }) },
    { path: '/pulls/7/reviews?per_page=100', response: Response.json([]) },
    { path: pullPath, response: Response.json(pullRequest(newSha)) },
  );
  const result = await handleGitHubWebhookEvent('pull_request', webhook(head));
  assert.equal(result.postedToGitHub, true);
  assert.equal(result.reviewResult, undefined);
  assert.match(result.action, /Skipped inline review/);
});

it('rejects on-demand publication when the base moves during review', async (t) => {
  const head = createFixture(t);
  const pr = pullRequest(head);
  mockGitHub(t,
    { path: pullPath, response: Response.json(pr) },
    configRequest(),
    compareRequest(head),
    publisherRequest(),
    { path: '/issues/7/comments?per_page=100', response: Response.json([]) },
    { path: pullPath, response: Response.json({ ...pr, base: { ...pr.base, sha: newSha } }) },
  );
  await assert.rejects(runGitHubOnDemandReview({
    owner: 'acme', repo: 'openrabbit', pullNumber: 7, postComment: true,
  }), GitHubPRChangedError);
});
