import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';
import { WALKTHROUGH_COMMENT_MARKER } from '../src/core/markdown-formatter.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import { publishGitHubPRReview } from '../src/integrations/github.js';

const target = { owner: 'acme', repo: 'openrabbit', pullNumber: 7, token: 'test-token' };
const actor = 'openrabbit-bot[bot]';
const user = { login: actor };
const snapshot = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const repoPath = '/repos/acme/openrabbit';
const commentsPath = repoPath + '/issues/7/comments';
const reviewsPath = repoPath + '/pulls/7/reviews';

async function createReview() {
  return runPullRequestReview({
    rawDiff: [
      'diff --git a/queue.ts b/queue.ts',
      '--- a/queue.ts',
      '+++ b/queue.ts',
      '@@ -1 +1 @@',
      '-export const isFirst = (count: number) => count === 0;',
      '+export const isFirst = (count: number) => count == 0;',
      '',
    ].join('\n'),
    config: { ...DEFAULT_OPENRABBIT_CONFIG, llm: { ...DEFAULT_OPENRABBIT_CONFIG.llm, provider: 'heuristic' } },
  });
}

const mark = ({ baseSha, headSha }: typeof snapshot) =>
  `\n<!-- openrabbit-inline-review:${baseSha}:${headSha} -->`;
const fresh = async () => true;

type Comment = { id: number; body: string; user: { login: string } };
type InlineReview = Comment & { state: string; commit_id: string };

function mockPublications(t: TestContext, options: {
  comments?: Comment[];
  reviews?: InlineReview[];
  pageSize?: number;
  dropResponseTo?: 'walkthrough' | 'inline';
  failLookup?: boolean;
} = {}) {
  const comments = options.comments ?? [];
  const reviews = options.reviews ?? [];
  const pageSize = options.pageSize ?? 100;
  const writes: string[] = [];
  let dropResponseTo = options.dropResponseTo;

  function respondToWrite(resource: 'walkthrough' | 'inline', record: Comment) {
    if (dropResponseTo === resource) {
      dropResponseTo = undefined;
      throw new TypeError('Connection closed after the provider accepted the write');
    }
    return Response.json(record);
  }

  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      assert.ok([commentsPath, reviewsPath].includes(url.pathname), url.pathname);
      if (options.failLookup) return new Response(null, { status: 503 });
      const rows = url.pathname === commentsPath ? comments : reviews;
      const page = Number(url.searchParams.get('page') ?? 1);
      const headers = page * pageSize < rows.length
        ? { Link: `<${url.origin}${url.pathname}?per_page=100&page=${page + 1}>; rel="next"` }
        : {};
      return Response.json(rows.slice((page - 1) * pageSize, page * pageSize), { headers });
    }

    writes.push(method + ' ' + url.pathname);
    const data = JSON.parse(String(init.body));
    if (method === 'POST' && url.pathname === commentsPath) {
      const comment = { id: 101, body: data.body, user };
      comments.push(comment);
      return respondToWrite('walkthrough', comment);
    }
    if (method === 'PATCH' && url.pathname === repoPath + '/issues/comments/101') {
      assert.equal(comments[0].id, 101);
      comments[0].body = data.body;
      return Response.json(comments[0]);
    }
    assert.equal(method, 'POST');
    assert.equal(url.pathname, reviewsPath);
    assert.equal(data.event, 'COMMENT');
    assert.equal(data.comments.length, 1);
    const review = { id: 200 + reviews.length, body: data.body, user, state: 'COMMENTED', commit_id: data.commit_id };
    reviews.push(review);
    return respondToWrite('inline', review);
  });
  return { writes, comments, reviews };
}

for (const resource of ['walkthrough', 'inline'] as const) {
  it('reconciles an accepted ' + resource + ' write after a lost response', async (t) => {
    const review = await createReview();
    const remote = mockPublications(t, { dropResponseTo: resource });
    await assert.rejects(publishGitHubPRReview(target, snapshot, review, fresh, actor), /provider accepted/);

    const replay = { ...review, markdownWalkthrough: review.markdownWalkthrough + '\nRefreshed summary' };
    await publishGitHubPRReview(target, snapshot, replay, fresh, actor);
    assert.equal(remote.comments.length, 1);
    assert.equal(remote.comments[0].body, replay.markdownWalkthrough);
    assert.equal(remote.reviews.length, 1);
    assert.ok(remote.reviews[0].body.endsWith(mark(snapshot)));
    assert.equal(remote.writes.filter((write) => write === 'POST ' + reviewsPath).length, 1);
  });
}

it('serializes concurrent publication of the same GitHub snapshot', async (t) => {
  const review = await createReview();
  const remote = mockPublications(t);
  await Promise.all([
    publishGitHubPRReview(target, snapshot, review, fresh, actor),
    publishGitHubPRReview(target, snapshot, review, fresh, actor),
  ]);
  assert.deepEqual(remote.writes, ['POST ' + commentsPath, 'POST ' + reviewsPath]);
});

it('finds existing publications on later pages and checks the publisher identity', async (t) => {
  const review = await createReview();
  const other = { login: 'contributor' };
  const remote = mockPublications(t, {
    pageSize: 1,
    comments: [
      { id: 1, body: WALKTHROUGH_COMMENT_MARKER, user: other },
      { id: 2, body: review.markdownWalkthrough, user },
    ],
    reviews: [
      { id: 1, state: 'COMMENTED', commit_id: snapshot.headSha, body: mark(snapshot), user: other },
      { id: 2, state: 'COMMENTED', commit_id: snapshot.headSha, body: mark(snapshot), user },
    ],
  });
  await publishGitHubPRReview(target, snapshot, review, fresh, actor.toUpperCase());
  assert.deepEqual(remote.writes, []);
});

it('requires an owned submitted review for the same base and head', async (t) => {
  const review = await createReview();
  const remote = mockPublications(t, {
    comments: [{ id: 101, body: WALKTHROUGH_COMMENT_MARKER, user }],
    reviews: [
      { id: 1, state: 'COMMENTED', commit_id: snapshot.headSha, body: mark(snapshot), user: { login: 'contributor' } },
      { id: 2, state: 'PENDING', commit_id: snapshot.headSha, body: mark(snapshot), user },
      { id: 3, state: 'COMMENTED', commit_id: 'd'.repeat(40), body: mark(snapshot), user },
      { id: 4, state: 'COMMENTED', commit_id: snapshot.headSha, body: mark({ ...snapshot, baseSha: 'c'.repeat(40) }), user },
    ],
  });
  await publishGitHubPRReview(target, snapshot, review, fresh, actor);
  assert.deepEqual(remote.writes, ['PATCH ' + repoPath + '/issues/comments/101', 'POST ' + reviewsPath]);
});

it('stops before creating a walkthrough when lookup fails', async (t) => {
  const review = await createReview();
  const remote = mockPublications(t, { failLookup: true });
  await assert.rejects(publishGitHubPRReview(target, snapshot, review, fresh, actor), /list GitHub publications.*503/);
  assert.deepEqual(remote.writes, []);
});
