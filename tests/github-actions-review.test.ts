import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';
import { reviewGitHubWorkflowRun } from '../src/integrations/github-actions.js';

const repository = 'acme/openrabbit';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const run = {
  event: 'pull_request',
  conclusion: 'success',
  head_sha: head,
  head_branch: 'feature',
  head_repository: { id: 42 },
  pull_requests: [{ number: 7 }],
};
const pr = {
  number: 7,
  state: 'open',
  draft: false,
  title: 'Queue delivery defaults',
  base: { ref: 'main', sha: base, repo: { full_name: repository } },
  head: { ref: 'feature', sha: head, repo: { id: 42 } },
};
const diff = [
  'diff --git a/queue.ts b/queue.ts',
  '--- a/queue.ts',
  '+++ b/queue.ts',
  '@@ -1 +1 @@',
  '-export const isFirst = (count: number) => count === 0;',
  '+export const isFirst = (count: number) => count == 0;',
  '',
].join('\n');
const comparePath = '/compare/' + base + '...' + head;
const config = structuredClone(DEFAULT_OPENRABBIT_CONFIG);
config.llm.provider = 'heuristic';

type ExpectedRequest = {
  path: string;
  method?: string;
  response: Response;
  check?: (options: RequestInit) => void;
};

function mockGitHub(t: TestContext, ...requests: ExpectedRequest[]): void {
  t.mock.method(globalThis, 'fetch', async (input: string, options: RequestInit = {}) => {
    const url = new URL(input);
    const expected = requests.shift();
    assert.ok(expected, 'Unexpected GitHub request: ' + url.pathname);
    assert.equal(url.pathname + url.search, '/repos/' + repository + expected.path);
    assert.equal(options.method ?? 'GET', expected.method ?? 'GET');
    expected.check?.(options);
    return expected.response;
  });
  t.after(() => assert.deepEqual(requests, []));
}

it('publishes a fork review using the exact commits and the CI run head', async (t) => {
  const unrelatedPr = { ...pr, number: 8, head: { ...pr.head, repo: { id: 43 } } };
  mockGitHub(t,
    { path: '/commits/' + head + '/pulls?per_page=100', response: Response.json([unrelatedPr, pr]) },
    {
      path: comparePath,
      response: new Response(diff),
      check: ({ headers }) => assert.equal(new Headers(headers).get('Accept'), 'application/vnd.github.diff'),
    },
    { path: '/issues/7/comments?per_page=100', response: Response.json([]) },
    { path: '/pulls/7', response: Response.json(pr) },
    { path: '/issues/7/comments', method: 'POST', response: Response.json({ id: 11 }) },
    { path: '/pulls/7/reviews?per_page=100', response: Response.json([]) },
    { path: '/pulls/7', response: Response.json(pr) },
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
  const result = await reviewGitHubWorkflowRun({
    run: { ...run, pull_requests: [] },
    repository,
    token: 'test',
    config,
  });
  assert.match(result, /Published.*#7/);
});

for (const side of ['head', 'base'] as const) {
  it('skips publication when the PR ' + side + ' changes during review', async (t) => {
    const updated = { ...pr, [side]: { ...pr[side], sha: 'c'.repeat(40) } };
    mockGitHub(t,
      { path: '/pulls/7', response: Response.json(pr) },
      { path: comparePath, response: new Response(diff) },
      { path: '/issues/7/comments?per_page=100', response: Response.json([]) },
      { path: '/pulls/7', response: Response.json(updated) },
    );
    const result = await reviewGitHubWorkflowRun({ run, repository, token: 'test', config });
    assert.match(result, /PR changed during review/);
  });
}

it('skips ambiguous fork runs before reviewing or publishing', async (t) => {
  const secondPr = { ...pr, number: 8, base: { ...pr.base, ref: 'develop' } };
  mockGitHub(t, {
    path: '/commits/' + head + '/pulls?per_page=100',
    response: Response.json([pr, secondPr]),
  });
  const result = await reviewGitHubWorkflowRun({
    run: { ...run, pull_requests: [] },
    repository,
    token: 'test',
    config,
  });
  assert.match(result, /no unique open PR/);
});

it('ignores runs whose PR checks failed', async (t) => {
  mockGitHub(t);
  const result = await reviewGitHubWorkflowRun({
    run: { ...run, conclusion: 'failure' },
    repository,
    token: 'test',
    config,
  });
  assert.match(result, /did not pass PR CI/);
});
