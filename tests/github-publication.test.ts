import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import { DEFAULT_OPENRABBIT_CONFIG } from '../src/config/config-loader.js';
import { WALKTHROUGH_COMMENT_MARKER } from '../src/core/markdown-formatter.js';
import { runPullRequestReview } from '../src/core/review-engine.js';
import { postGitHubInlineReview, publishGitHubPRReview } from '../src/integrations/github.js';

const target = { owner: 'acme', repo: 'openrabbit', pullNumber: 7, token: 'test-token' };
const actor = 'openrabbit-bot[bot]';
const user = { login: actor };
const snapshot = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
const repoPath = '/repos/acme/openrabbit';
const commentsPath = repoPath + '/issues/7/comments';
const reviewsPath = repoPath + '/pulls/7/reviews';
const inlinePath = repoPath + '/pulls/7/comments';

async function createReview(lines = [1], comparedValue = 0) {
  const baseline = `export const isFirst = (count: number) => count === ${comparedValue};`;
  const changed = baseline.replace('===', '==');
  return runPullRequestReview({
    rawDiff: [
      'diff --git a/queue.ts b/queue.ts',
      '--- a/queue.ts',
      '+++ b/queue.ts',
      ...lines.flatMap((line) => [`@@ -${line} +${line} @@`, '-' + baseline, '+' + changed]),
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
type InlineComment = Comment & {
  path: string;
  line: number;
  side: string;
  position?: number | null;
  pull_request_review_id: number;
};

function mockPublications(t: TestContext, options: {
  comments?: Comment[];
  reviews?: InlineReview[];
  pageSize?: number;
  dropResponseTo?: 'walkthrough' | 'inline';
  failLookup?: boolean;
} = {}) {
  const comments = options.comments ?? [];
  const reviews = options.reviews ?? [];
  const inlineComments: InlineComment[] = [];
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
      assert.ok([commentsPath, reviewsPath, inlinePath].includes(url.pathname), url.pathname);
      if (options.failLookup) return new Response(null, { status: 503 });
      const rows = url.pathname === commentsPath ? comments : url.pathname === reviewsPath ? reviews : inlineComments;
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
    assert.ok(data.comments.length > 0);
    const review = { id: 200 + reviews.length, body: data.body, user, state: 'COMMENTED', commit_id: data.commit_id };
    reviews.push(review);
    for (const comment of data.comments) {
      inlineComments.push({ ...comment, id: 400 + inlineComments.length, user, pull_request_review_id: review.id });
    }
    return respondToWrite('inline', review);
  });
  return { writes, comments, reviews, inlineComments };
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

it('reuses a shifted finding and gives the comment budget to a second occurrence', async (t) => {
  const remote = mockPublications(t, { pageSize: 1 });
  await publishGitHubPRReview(target, snapshot, await createReview(), fresh, actor);
  const [original] = remote.inlineComments;
  assert.match(original.body, /<!-- openrabbit-finding:v1:[a-f0-9]{64} -->$/);

  // GitHub maps the old comment to its current line after the second push.
  original.line = 12;
  const newSnapshot = { ...snapshot, headSha: 'c'.repeat(40) };
  await publishGitHubPRReview(target, newSnapshot, await createReview([12]), fresh, actor);
  assert.equal(remote.reviews.length, 1);

  const review = await createReview([12, 20]);
  const result = await postGitHubInlineReview(
    target.owner, target.repo, target.pullNumber, newSnapshot.headSha, review.findings, target.token,
    {
      rawDiff: review.rawDiff,
      maxComments: 1,
      snapshot: { baseSha: snapshot.baseSha, actorLogin: actor, ensureCurrent: async () => {} },
    }
  );
  assert.equal(result.commentsPosted, 1);
  assert.equal(result.commentsSkipped, 1);
  assert.deepEqual(remote.inlineComments.map((comment) => comment.line), [12, 20]);
  assert.match(remote.reviews[1].body, /1 already-commented/);
});

const newFindingCases: {
  why: string;
  earlierComment?: Partial<InlineComment>;
  comparedValue?: number;
  escalate?: boolean;
}[] = [
  { why: 'the anchor is outdated', earlierComment: { position: null } },
  { why: 'the evidence changes', comparedValue: 1 },
  { why: 'the comment has no fingerprint', earlierComment: { body: 'OpenRabbit review without a fingerprint' } },
  { why: 'the author differs', earlierComment: { user: { login: 'contributor' } } },
  { why: 'the severity increases', escalate: true },
];

for (const { why, earlierComment, comparedValue, escalate } of newFindingCases) {
  it('posts a fresh finding when ' + why, async (t) => {
    const remote = mockPublications(t);
    await publishGitHubPRReview(target, snapshot, await createReview(), fresh, actor);
    Object.assign(remote.inlineComments[0], earlierComment);
    const current = await createReview([1], comparedValue);
    if (escalate) current.findings[0].severity = 'warning';
    await publishGitHubPRReview(target, { ...snapshot, headSha: 'c'.repeat(40) }, current, fresh, actor);
    assert.equal(remote.reviews.length, 2);
    assert.equal(remote.inlineComments.length, 2);
  });
}
