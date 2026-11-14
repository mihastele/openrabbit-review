# OpenRabbit: simple self-hosting on a Raspberry Pi

Status: implementation plan only
Repository: `/home/miha/dev/openrabbit-review`
Baseline branch: `mihastele/sec-20261115`

## Goal

Make OpenRabbit a low-friction, secure-by-default, single-user review and security-check service that runs on a 64-bit Raspberry Pi, connects to GitHub/Codeberg/GitLab/Bitbucket, and retains its existing CodeRabbit-style review capabilities behind a much simpler UI.

## Current context and assumptions

- The project is dependency-light TypeScript/ESM on Node 20+, using `node:http`, vanilla HTML/CSS/JS, JSON-file persistence, and Node's built-in test runner. Do not introduce React, a web framework, an ORM, Redis, or a database for this work.
- The main server is `src/server/app.ts`; the CLI is `src/cli/index.ts`; the UI is `public/index.html`, `public/app.js`, and `public/styles.css`.
- Existing integrations are GitHub, GitLab, and Bitbucket. Codeberg is absent. Codeberg uses Forgejo, so add one configurable Forgejo adapter and present it as “Codeberg / Forgejo”; this also supports self-hosted Forgejo and compatible Gitea instances without another adapter.
- Existing CodeRabbit-style capabilities that must not regress: sticky PR walkthroughs, release notes, changed-file tables, Mermaid diagrams, effort/risk estimates, optional poems, inline findings, committable suggestions, `@openrabbit` explain/test/fix/docstring/resolve/ignore/remember commands, repository instructions/memory, automatic PR updates, profiles, path filters/instructions, custom rules, multi-provider BYOK, heuristic-only operation, local repositories, history/analytics, SARIF/JSON/Markdown reports, and severity gates.
- “CodeRabbit parity” in this plan means preserving and making operational the feature set already advertised in this repository. It does not authorize a rewrite to clone every CodeRabbit SaaS feature. Full code-graph parity, multi-tenant accounts, and a hosted control plane are non-goals.
- The default Pi target is 64-bit Raspberry Pi OS, Docker with Compose v2, ARM64, and at least 4 GB RAM. The `lite` image and built-in static/heuristic checks are the default. Semgrep/Trivy/Gitleaks remain an opt-in `full` image. Do not default to running Ollama on the Pi.
- Local use must work with no LLM key and no Git token. Public webhook hosting necessarily requires a public URL and provider credentials; use a named Cloudflare Tunnel as the opinionated default so no router port forwarding is required. Document an existing-reverse-proxy alternative.
- This is a single-administrator, single-process service. Existing JSON storage is adequate, but only one OpenRabbit container may write a given `data/` directory.
- Current operational gaps to fix deliberately: the Dockerfile hardcodes an x64 Gitleaks archive; the server has no UI authentication or body-size limit; production accepts unsigned webhooks when secrets are absent; Compose defaults to synchronous webhooks; the UI automatically runs a sample review on startup; Mermaid/fonts require third-party CDNs; Mermaid uses `securityLevel: 'loose'`; remote reviews do not supply `repoPath`, so repository context and external scanners do not run for them.

## Architecture and proposed approach

Keep the existing engine and static frontend, adding a small production server hardening layer, a reusable Forgejo integration, and a temporary remote-checkout helper that lets existing context enrichment and scanner adapters work on remote PRs. Use progressive disclosure rather than deleting advanced functionality: four top-level destinations (Home, Review, Activity, Settings), with local repositories, rules, raw YAML, provider details, and webhook simulators nested under Settings. Ship a multi-arch Docker build, a generated `.env`, an authenticated dashboard, always-asynchronous provider webhooks on the Pi, and copyable provider-specific setup instructions in both the UI and README-linked guides.

## Non-negotiable implementation rules

- Preserve all existing DOM IDs unless a task explicitly renames one; move elements rather than duplicating them. `public/app.js` currently depends on those IDs.
- Never put API tokens, webhook secrets, or the admin token in review history, job results, URLs, logs, `localStorage`, or committed files.
- Use `execFile`/`execFileSync` with argument arrays for Git and scanner processes. Never construct shell commands from webhook or UI input.
- Every outbound API write must check `response.ok`; failures become visible failed jobs or visible on-demand errors. Do not silently claim a comment/review was posted.
- A zero-finding scan is not a security guarantee. Preserve the existing scope wording in reports and docs.
- After each task: run its exact RED/GREEN command, then `npm test && npm run build` before the task commit when source changed. Commit only the named files.

## Step-by-step tasks

### Phase 0 — Establish the baseline and feature-preservation gate

#### Task 0.1 — Record a clean baseline

Run:

```bash
npm ci
npm test
npm run build
git status --short
```

Expected: all existing tests report `# fail 0`, TypeScript exits 0, and `git status --short` shows only intended plan files. If baseline tests fail, record the failure and fix it separately before feature work; do not label later regressions as pre-existing without this evidence.

No commit is needed for a read-only baseline.

#### Task 0.2 — Add characterization tests for features the UI refactor must retain

Create `tests/feature-preservation.test.ts`. Reuse `SAMPLE_DIFF_TEMPLATES[0]`, `DEFAULT_OPENRABBIT_CONFIG`, `runPullRequestReview`, and `handlePRChat`. Add these exact test cases:

1. `walkthrough contract remains complete`: run with `llm.provider = 'heuristic'`; assert executive summary, at least one file summary, Mermaid containing `sequenceDiagram`, effort score 1–5, risk level, non-empty poem, sticky Markdown marker, and at least one finding with a suggestion.
2. `chat commands remain available`: call `@openrabbit explain`, `test`, `fix`, and `docstring`; assert the corresponding `commandDetected` and non-empty Markdown.
3. `security profile and reports remain available`: set `profile = 'security-focused'`; assert every finding has category `security`, `formatSarifReport(result).version` equals `2.1.0`, and `exceedsFailureThreshold` honors `warning`.
4. `configuration compatibility remains available`: parse minimal YAML containing `profile`, `reviews.path_filters`, `reviews.path_instructions`, and `chat.auto_reply`; assert those values survive `parseYamlConfig`.

Verification:

```bash
npx tsx --test tests/feature-preservation.test.ts
```

Expected on the unmodified engine: `# pass 4` and `# fail 0`. These are characterization tests, so they need not fail first.

Commit:

```bash
git add tests/feature-preservation.test.ts
git commit -m "test: preserve review and chat feature contracts"
```

### Phase 1 — Make the HTTP service safe to expose

#### Task 1.1 — Write failing authentication and health tests

Create `tests/production-server.test.ts` with tests named and specified as follows:

- `health is public and contains no configuration`: start on port 0 with `NODE_ENV=production` and `OPENRABBIT_ADMIN_TOKEN=test-admin-token`; `GET /healthz` returns 200 and exactly `{ ok: true }`; `GET /api/status` returns 401.
- `session login sets an HttpOnly cookie and unlocks the API`: POST `{"token":"test-admin-token"}` to `/api/session`; expect 204, a cookie containing `HttpOnly`, `SameSite=Strict`, and `Path=/`; use only that cookie for `/api/status` and expect 200. Assert the response body does not contain `test-admin-token`.
- `wrong login and missing session are rejected`: wrong token returns 401; no cookie returns 401.
- `webhooks remain reachable but require signatures in production`: POST `/api/webhooks/github` without a signature returns 401, not a dashboard-auth response or 200.
- Restore all mutated environment variables and close every server in `finally`; use a fresh temporary `storageDir` per test.

Run:

```bash
npx tsx --test tests/production-server.test.ts
```

Expected RED: `/healthz` and `/api/session` return 404 and `/api/status` is currently public, producing assertion failures.

Commit the failing tests only if using a RED commit workflow; otherwise proceed directly to Task 1.2 and commit both together.

#### Task 1.2 — Implement signed, expiring dashboard sessions

Create `src/server/auth.ts` with this complete implementation:

```ts
import crypto from 'node:crypto';
import type http from 'node:http';

const COOKIE_NAME = 'openrabbit_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

function signature(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function tokensEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(secret: string, nowMs = Date.now()): string {
  const expires = String(Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS);
  return `${expires}.${signature(expires, secret)}`;
}

export function isAuthenticated(
  req: http.IncomingMessage,
  adminToken: string | undefined,
  nowMs = Date.now()
): boolean {
  if (!adminToken) return process.env.NODE_ENV !== 'production';
  const cookies = (req.headers.cookie || '').split(';').map((part) => part.trim());
  const session = cookies.find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!session) return false;
  const [expires, providedSignature] = session.split('.');
  if (!/^\d+$/.test(expires || '') || !providedSignature) return false;
  if (Number(expires) <= Math.floor(nowMs / 1000)) return false;
  return tokensEqual(providedSignature, signature(expires, adminToken));
}

export function sessionCookie(secret: string, secure: boolean): string {
  return `${COOKIE_NAME}=${createSession(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
```

Add `tests/server-auth.test.ts` for expired sessions, malformed cookies, wrong signatures, and development-only anonymous access. Run both test files; expect the auth unit tests to pass and the HTTP tests still to fail until wiring is complete.

#### Task 1.3 — Wire health, login/logout, authentication, host binding, and security headers

In `src/server/app.ts`:

1. Import `clearedSessionCookie`, `isAuthenticated`, `sessionCookie`, and `tokensEqual`.
2. Add public `GET /healthz` before other routes; return only `{ ok: true }`.
3. Add `POST /api/session` reading at most 16 KiB, comparing the submitted token with `tokensEqual`, returning 204 plus `Set-Cookie: sessionCookie(...)` on success and 401 on failure. Set `Secure` only when `OPENRABBIT_PUBLIC_URL` starts with `https://`.
4. Add `DELETE /api/session`, returning 204 with `clearedSessionCookie()`.
5. Before every other `/api/` route except `/api/webhooks/*`, call `isAuthenticated`; on failure return 401 `{ error: 'Authentication required' }`.
6. Replace wildcard CORS headers with no CORS headers. Same-origin browser calls need none. Add `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY` to JSON and static responses.
7. Add optional `host?: string` to `createOpenRabbitServer` options. Listen on `options.host || process.env.HOST || '127.0.0.1'`; keep test calls on `127.0.0.1`. In Docker set `HOST=0.0.0.0`.
8. At startup, throw `OPENRABBIT_ADMIN_TOKEN is required when NODE_ENV=production` if production has no admin token.

Verification:

```bash
npx tsx --test tests/server-auth.test.ts tests/production-server.test.ts
npm test && npm run build
```

Expected GREEN: all new and existing tests pass; the production startup test without a token rejects with the exact message above.

Commit:

```bash
git add src/server/auth.ts src/server/app.ts tests/server-auth.test.ts tests/production-server.test.ts
git commit -m "feat: secure the self-hosted dashboard and API"
```

#### Task 1.4 — Enforce request limits and production webhook signatures

First extend `tests/production-server.test.ts`:

- POST more than the configured body limit to `/api/review`; expect 413 `{ error: 'Request body too large' }` and a server that still answers `/healthz`.
- With `NODE_ENV=production`, GitHub, GitLab, Bitbucket, and Forgejo verification helpers must reject an absent secret. In non-production they may retain the existing local-simulator behavior.

Then change `readBody` in `src/server/app.ts` to count bytes, stop at `Number(process.env.OPENRABBIT_MAX_BODY_BYTES || 2 * 1024 * 1024)`, and produce a typed 413 error handled by the route catch. Do not call `req.destroy()` before the 413 response is flushed. Change the fallback in `verifyGitHubWebhookSignature`, `verifyGitLabWebhookToken`, and `verifyBitbucketWebhook` to:

```ts
if (!secret) return process.env.NODE_ENV !== 'production';
```

Run the new tests, full tests, and build. Expected: 413 for oversized requests, 401 for unsigned production webhooks, and `# fail 0` overall.

Commit:

```bash
git add src/server/app.ts src/integrations/github.ts src/integrations/gitlab.ts src/integrations/bitbucket.ts tests/production-server.test.ts
git commit -m "fix: bound requests and require production webhook secrets"
```

#### Task 1.5 — Make webhook delivery deduplication safe and configurable

Add tests to `tests/job-queue.test.ts`:

- A completed job with the same key is returned as deduplicated instead of being run twice.
- A new commit SHA creates a new job.
- Two different comment IDs on the same PR create two jobs.
- `OPENRABBIT_JOB_CONCURRENCY=1` is honored by `createOpenRabbitServer`; clamp valid configuration to 1–4 and default production to 1.

In `src/core/job-queue.ts`, extend the existing-key lookup to completed jobs and return the completed result without rerunning. In `src/server/app.ts`, configure concurrency, max attempts, and retry delay from `OPENRABBIT_JOB_CONCURRENCY`, `OPENRABBIT_JOB_MAX_ATTEMPTS` (default 3), and `OPENRABBIT_RETRY_DELAY_MS` (default 1000). Build dedup keys from provider delivery IDs when available (`X-GitHub-Delivery`, `X-Gitea-Delivery`), otherwise include event, repository, PR, head SHA, and comment ID; never use only `eventName` for comments.

Verification:

```bash
npx tsx --test tests/job-queue.test.ts tests/production-server.test.ts
npm test && npm run build
```

Expected: all pass; a repeated simulated delivery ID produces `deduplicated: true` and only one execution.

Commit the three source files and test file with message `fix: deduplicate webhook deliveries safely`.

### Phase 2 — Provide an ARM64-safe, one-command Pi deployment

#### Task 2.1 — Add failing deployment contract tests

Create `tests/deployment-contract.test.ts` using `fs.readFileSync` and Node assertions. Assert:

- `Dockerfile` contains `ARG TARGETARCH`, maps both `amd64` and `arm64`, and does not contain the hardcoded `gitleaks_${GITLEAKS_VER}_linux_x64.tar.gz` pattern.
- The runtime target contains `USER node`, `HEALTHCHECK`, and `npm ci --omit=dev`.
- `docker-compose.yml` defaults the published interface to `127.0.0.1`, uses `OPENRABBIT_ASYNC_WEBHOOKS=true`, and persists `/app/data`.
- `.dockerignore` excludes `.git`, `node_modules`, `dist`, `.env`, `.hermes`, and `data`.
- `.gitignore` excludes runtime JSON, job state, memory, and cache files under `data/` while retaining `data/.gitkeep`.

Run `npx tsx --test tests/deployment-contract.test.ts`; expect RED on the missing multi-arch/non-root/healthcheck entries.

#### Task 2.2 — Replace the Dockerfile with build/runtime stages and pinned scanner versions

Rewrite `Dockerfile` with these exact stages and behavior:

1. `build`: `node:22-alpine`, `npm ci`, copy `tsconfig.json`, `.openrabbit.yaml`, `src`, and `public`, then `npm run build`.
2. `lite`: fresh `node:22-alpine`; install only `git` and `ca-certificates`; run `npm ci --omit=dev`; copy built `dist`, `public`, and default YAML; create/chown `/app/data`; set `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3847`, `OPENRABBIT_DATA_DIR=/app/data`; use `USER node`; expose 3847; health-check `http://127.0.0.1:3847/healthz` using Node `fetch`; start `node dist/cli/index.js serve`.
3. `full`: temporarily switch to root; install Python/pip/curl/tar; install `semgrep==1.185.0`, Trivy `0.76.2`, and Gitleaks `8.30.1` as the tested baseline pins. Use `ARG TARGETARCH` and map `amd64 -> 64bit/x64`, `arm64 -> ARM64/arm64` for Trivy/Gitleaks respectively. Download each project's release checksum file and fail the build unless the selected archive passes `sha256sum -c`. Do not use a `latest` API lookup or pipe a moving install script into a shell. Return to `USER node` and set `TRIVY_CACHE_DIR=/app/data/cache/trivy`.

Add `.dockerignore` with:

```text
.git
.gitignore
node_modules
dist
.env
.hermes
data
coverage
*.log
tests
```

Run:

```bash
npx tsx --test tests/deployment-contract.test.ts
docker build --target lite -t openrabbit-test:lite .
```

Expected: contract test passes and the image build ends with `naming to docker.io/library/openrabbit-test:lite` (or the equivalent BuildKit DONE line).

Commit `Dockerfile`, `.dockerignore`, and the test with message `build: add a production ARM64-compatible image`.

#### Task 2.3 — Make Compose production-ready and add the tunnel override

Replace `docker-compose.yml` with:

```yaml
services:
  openrabbit:
    build:
      context: .
      target: ${OPENRABBIT_DOCKER_TARGET:-lite}
    container_name: openrabbit
    env_file: .env
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3847
      OPENRABBIT_DATA_DIR: /app/data
      OPENRABBIT_ASYNC_WEBHOOKS: "true"
      OPENRABBIT_JOB_CONCURRENCY: ${OPENRABBIT_JOB_CONCURRENCY:-1}
      TRIVY_CACHE_DIR: /app/data/cache/trivy
    ports:
      - "${OPENRABBIT_BIND_ADDRESS:-127.0.0.1}:3847:3847"
    volumes:
      - ./data:/app/data
      - ./.openrabbit.yaml:/app/.openrabbit.yaml
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp:size=512m,mode=1777
```

Create `deploy/docker-compose.tunnel.yml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:2026.11.0
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN:?Set CLOUDFLARE_TUNNEL_TOKEN in .env}
    depends_on:
      openrabbit:
        condition: service_healthy
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Expand `.env.example` with documented entries for `HOST`, `OPENRABBIT_BIND_ADDRESS`, `OPENRABBIT_PUBLIC_URL`, `OPENRABBIT_ADMIN_TOKEN`, `OPENRABBIT_ASYNC_WEBHOOKS=true`, job limits, `CLOUDFLARE_TUNNEL_TOKEN`, Bitbucket token/API URL, and `FORGEJO_TOKEN`, `FORGEJO_WEBHOOK_SECRET`, `FORGEJO_WEB_URL=https://codeberg.org`, `FORGEJO_API_URL=https://codeberg.org/api/v1`. Keep all secrets blank in the example.

Verification:

```bash
OPENRABBIT_ADMIN_TOKEN=test docker compose config -q
CLOUDFLARE_TUNNEL_TOKEN=test OPENRABBIT_ADMIN_TOKEN=test docker compose -f docker-compose.yml -f deploy/docker-compose.tunnel.yml config -q
```

Expected: both commands exit 0 with no output.

Commit the three deployment files and `.env.example` with message `build: add Pi Compose and Cloudflare Tunnel deployment`.

#### Task 2.4 — Add an idempotent Pi setup script

Create executable `scripts/setup-pi.sh`. It must:

- Use `#!/usr/bin/env bash`, `set -euo pipefail`, and run from the repository root.
- Require `docker`, `docker compose version`, and `curl`; print package-install guidance and exit 1 if absent.
- Require an ARM64 or x86_64 host; reject 32-bit ARM with a clear message.
- Refuse to overwrite an existing `.env`; print “.env already exists; leaving it unchanged” and continue with validation/startup.
- On first run, create `.env` with mode 600, random 32-byte hex values for `OPENRABBIT_ADMIN_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITLAB_WEBHOOK_SECRET`, `BITBUCKET_WEBHOOK_SECRET`, and `FORGEJO_WEBHOOK_SECRET`, generated from `/dev/urandom` using `od`/`tr`, not a predictable timestamp. Include blank provider/LLM/tunnel tokens and the defaults from `.env.example`.
- Prompt only for `OPENRABBIT_PUBLIC_URL`, defaulting to `http://127.0.0.1:3847`. Do not prompt for provider tokens; direct the user to edit `.env` later.
- Create `data`, set it to UID/GID 1000 only when the current user owns it or passwordless `sudo` is already available; otherwise print the exact `sudo chown -R 1000:1000 data` command and stop before startup.
- Run `docker compose up -d --build`, wait at most 60 seconds for `curl -fsS http://127.0.0.1:3847/healthz`, and print the dashboard URL, the admin token only on first creation, and the next command for adding provider tokens.
- Never print the `.env` file or any provider token.

Add `tests/setup-script-contract.test.ts` asserting the script contains `set -euo pipefail`, `chmod 600 .env`, no `latest`, and no token-echoing command such as `cat .env`.

Verification:

```bash
bash -n scripts/setup-pi.sh
npx tsx --test tests/setup-script-contract.test.ts
```

Expected: both exit 0. If ShellCheck is already installed, also run `shellcheck scripts/setup-pi.sh`; do not make it a new runtime dependency.

Commit the script and test with message `feat: add guided Raspberry Pi setup`.

#### Task 2.5 — Exercise the actual container, not just its configuration

Run:

```bash
OPENRABBIT_ADMIN_TOKEN=test-admin docker run --rm -d --name openrabbit-test \
  -p 127.0.0.1:13847:3847 \
  -e NODE_ENV=production -e OPENRABBIT_ADMIN_TOKEN=test-admin \
  -e HOST=0.0.0.0 -e OPENRABBIT_DATA_DIR=/app/data \
  openrabbit-test:lite
curl -fsS http://127.0.0.1:13847/healthz
docker inspect --format '{{.Config.User}}' openrabbit-test
docker stop openrabbit-test
```

Expected: health returns `{"ok":true}` and the configured user is `node`. On a build host with ARM64 emulation, also run:

```bash
docker buildx build --platform linux/arm64 --target lite --load -t openrabbit-test:arm64 .
docker run --rm --platform linux/arm64 openrabbit-test:arm64 uname -m
```

Expected: `aarch64`. If emulation is unavailable, report that explicitly and leave native Pi verification in the final checklist; do not claim ARM64 was executed.

Commit any fixes discovered by this runtime test separately as `fix: correct container runtime startup`.

### Phase 3 — Add Codeberg and generic Forgejo support without forking the review engine

#### Task 3.1 — Define the provider contract in failing tests

Create `tests/forgejo-integration.test.ts` with these tests:

1. `verifies Forgejo HMAC signatures`: raw body plus secret, hex HMAC-SHA256 in `X-Gitea-Signature` and `sha256=...` form; valid passes, invalid/missing fails, production missing secret fails.
2. `reviews Codeberg pull_request events`: call `handleForgejoWebhookEvent('pull_request', payload, config)` with `action: 'opened'`, repository `full_name: 'acme/auth'`, PR number 7, head SHA, base/head branches, author, and `simulated_diff`; assert `handled`, `reviewResult.source === 'forgejo'`, PR 7, findings, and no network post in simulation.
3. `handles synchronized and ignores closed`: synchronized is handled; closed returns `handled: false`.
4. `answers PR issue comments only`: `issue_comment` with `is_pull: true` and `@openrabbit explain` returns an explain response; a non-PR issue comment is ignored.
5. `exposes Codeberg HTTP webhook and status`: temporary server, signed POST to `/api/webhooks/forgejo`, expect 202 when async is enabled; `/api/status` includes `forgejoConfigured` and `forgejoWebhookConfigured` booleans, never token values.
6. `accepts the Codeberg alias`: the same signed request to `/api/webhooks/codeberg` reaches the same handler.

Run:

```bash
npx tsx --test tests/forgejo-integration.test.ts
```

Expected RED: module `src/integrations/forgejo.js` does not exist.

#### Task 3.2 — Implement signature verification and pure payload mapping

Create `src/integrations/forgejo.ts`. Start with this complete signature helper:

```ts
import crypto from 'node:crypto';

export function verifyForgejoWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
```

Add exported pure mappers `mapForgejoPullRequest(payload)` and `mapForgejoComment(payload)` returning typed metadata or null. Validate repository owner/name, positive PR number, action, branch/title/author strings, head SHA, and comment body. Use no `any` outside clearly documented payload-boundary parsing. Only PR actions `opened`, `synchronized`, `reopened`, and `ready_for_review` trigger reviews. Ignore drafts when `reviews.auto_review.drafts` is false and bases not listed in `reviews.auto_review.base_branches`.

Run the signature/mapper tests; expect them to pass while HTTP/handler tests remain RED.

#### Task 3.3 — Implement the Forgejo API client with sticky and inline reviews

In the same `src/integrations/forgejo.ts`, implement these exact functions using native `fetch` and `Authorization: token <FORGEJO_TOKEN>`:

- `fetchForgejoPRDiff(owner, repo, index, token?)`: GET `/api/v1/repos/{owner}/{repo}/pulls/{index}.diff`; require `res.ok`, return text.
- `fetchForgejoPRDetails`: GET `/repos/{owner}/{repo}/pulls/{index}`; map title, head SHA, base/head refs, author, draft.
- `fetchForgejoRepoConfig`: try `.openrabbit.yaml`, `.openrabbit.yml`, `.coderabbit.yaml`, `.coderabbit.yml` through `/repos/{owner}/{repo}/raw/{filename}?ref=<headSHA>` and parse with `parseYamlConfig`.
- `upsertForgejoWalkthroughComment`: list `/repos/{owner}/{repo}/issues/{index}/comments`, find `WALKTHROUGH_COMMENT_MARKER`, PATCH `/repos/{owner}/{repo}/issues/comments/{commentId}` when found, otherwise POST to the PR issue's comments endpoint. Check every response and return `{ commentId, updated }`.
- `postForgejoInlineReview`: POST `/repos/{owner}/{repo}/pulls/{index}/reviews` with `event: 'COMMENT'`, `commit_id`, a summary body, and comments `{ path, new_line_num, body }`. Use `formatInlineCommentMarkdown(finding, 'github')` because Forgejo supports GitHub-style suggestion fences. Check the response and return review ID/count.
- `postForgejoChatComment`: POST to the PR issue comments endpoint and throw on non-2xx.

Build URLs from `FORGEJO_API_URL`, encode owner/repo/path components, and set `User-Agent: OpenRabbit-Bot/1.0`. Add mocked-fetch tests for URL paths, auth header, sticky update versus create, inline payload line numbers, and non-2xx errors. Never include tokens in thrown errors.

Run the new API tests and build. Expected: all pass without network access.

#### Task 3.4 — Implement Forgejo review/chat handlers and on-demand review

Complete `src/integrations/forgejo.ts` by following the existing GitHub handler flow, not by modifying the review engine:

- `handleForgejoWebhookEvent(eventName, payload, fallbackConfig)` fetches diff/config unless `simulated_diff` is present, calls `runPullRequestReview` with `source: 'forgejo'`, posts sticky and inline output only for real events with a token, and handles `@openrabbit` PR comments with `handlePRChat`.
- `runForgejoOnDemandReview({ owner, repo, pullNumber?, commitSha?, token?, postComment?, config? })` requires exactly one target, accepts an optional token override without persisting it, fetches the diff, reviews it, and optionally posts PR output.
- Export `parseForgejoTarget(input)` using `new URL`: support `owner/repo#123` and `https://codeberg.org/owner/repo/pulls/123`; when a URL is supplied require its host to equal the host in `FORGEJO_WEB_URL`. Do not use a regex that accepts `evil-codeberg.org`.

Update `src/types/index.ts`: add `'forgejo'` to `ReviewResult.source` and `RunReviewOptions.source` in `src/core/review-engine.ts`.

Run `npx tsx --test tests/forgejo-integration.test.ts`; expect all handler tests GREEN. Run full tests/build before committing.

#### Task 3.5 — Route Forgejo webhooks and on-demand requests

In `src/server/app.ts`:

- Extend `WebhookJobPayload.provider` and dispatch types with `'forgejo'`.
- Import the Forgejo handler/verifier/on-demand function.
- Add `/api/webhooks/forgejo` and `/api/webhooks/codeberg`; read `X-Gitea-Signature` or `X-Hub-Signature-256`, and event from `X-Gitea-Event` or `X-GitHub-Event`.
- Deduplicate on `X-Gitea-Delivery` when present, with the fallback described in Task 1.5.
- Add `/api/integrations/forgejo/review` with owner/repo and PR/commit validation identical in spirit to GitHub; do not accept arbitrary API base URLs in the request body.
- Add status booleans and `publicUrl`, but no secrets.

Update `src/cli/index.ts` with `--forgejo` and alias `--codeberg`, remote URL/short-target parsing, optional `--post-comment`, help text, and persistence through the existing store. Add CLI parsing tests to `tests/forgejo-integration.test.ts` rather than spawning a real network review.

Verification:

```bash
npx tsx --test tests/forgejo-integration.test.ts tests/job-queue.test.ts
npm test && npm run build
```

Expected: signed HTTP tests pass, unsigned production requests return 401, duplicate delivery IDs deduplicate, and the build has no source-union errors.

Commit all Forgejo/type/server/CLI/test changes with message `feat: support Codeberg and Forgejo pull request reviews`.

### Phase 4 — Give remote reviews the same context and security scanners as local reviews

#### Task 4.1 — Specify the temporary checkout helper with local-only tests

Create `tests/remote-workspace.test.ts`. Use a temporary bare Git repository containing two commits; no external network. Test that:

- `withRemoteWorkspace` checks out the requested ref, exposes its files through `workspace.path`, and removes the temporary directory in `finally` after both success and thrown callbacks.
- Arguments passed to the mocked `execFile` never contain a token and never use `shell: true`.
- HTTPS clone URLs outside the configured provider host are rejected before Git runs.
- Git prompts are disabled, checkout timeout is configurable, and timeout errors identify the provider operation without printing credentials.
- A file-protocol remote is accepted only when the test explicitly passes `allowFileProtocol: true`; production callers never set it.

Run the test; expect RED because `src/core/remote-workspace.ts` is absent.

#### Task 4.2 — Implement safe, ephemeral remote workspaces

Create `src/core/remote-workspace.ts` exporting:

```ts
export interface RemoteWorkspaceOptions {
  cloneUrl: string;
  ref: string;
  providerHost: string;
  auth?: { username: string; password: string };
  timeoutMs?: number;
  allowFileProtocol?: boolean;
}

export interface RemoteWorkspace {
  path: string;
}

export async function withRemoteWorkspace<T>(
  options: RemoteWorkspaceOptions,
  callback: (workspace: RemoteWorkspace) => Promise<T>
): Promise<T>;
```

Implementation requirements: validate `https:` and exact hostname against `providerHost` (file only in tests); create a directory with `fs.mkdtemp`; use `execFile` argument arrays and no shell; run `git init`, `git remote add origin <cloneUrl>`, `git fetch --depth 1 origin <ref>`, and `git checkout --detach FETCH_HEAD`; set `GIT_TERMINAL_PROMPT=0`; enforce a default 60-second timeout. For private repos, create a mode-700 `GIT_ASKPASS` script inside the temporary directory that reads `OPENRABBIT_GIT_USERNAME` and `OPENRABBIT_GIT_PASSWORD` from its environment. Pass the token only through that environment and remove the whole directory in `finally`. Do not embed credentials in remote URLs or Git config.

Run the helper tests, full tests, and build. Expected: cleanup and credential-safety tests pass.

#### Task 4.3 — Wire PR webhooks to remote checkouts and persistent memory

For GitHub, GitLab, Bitbucket, and Forgejo real PR webhook paths:

- Derive clone URLs from trusted provider payload fields and validate them against the configured provider host. For on-demand requests, construct URLs from the configured provider base rather than user-provided URLs.
- Fetch PR refs `pull/<n>/head` for GitHub, `merge-requests/<n>/head` for GitLab, and `pull/<n>/head` for Forgejo. For Bitbucket, use the source repository clone URL plus the head SHA/ref supplied by the payload; if the provider cannot fetch that ref, fail visibly with remediation text rather than silently reducing scan scope.
- Wrap the existing diff fetch/review/post sequence in `withRemoteWorkspace`; pass `repoPath: workspace.path` to `runPullRequestReview`. This activates `enrichDiffContext`, external scanners, and existing repository-aware behavior.
- Keep `simulated_diff` tests diff-only and network-free.
- Pass `memoryFilePath` under `<storageDir>/memory/<sha256(source + ':' + repository)>.json`, so `ignore`/`remember` survive ephemeral checkout deletion. Add `OPENRABBIT_DATA_DIR` support for CLI use; server code passes its actual `resolvedStorageDir` explicitly.
- On checkout/scanner failure, mark the job failed and do not post a partial “successful” review. The queue retry handles transient failures.
- Do not run repository build scripts, package installation, tests, hooks, or arbitrary code. Git config must disable hooks in the temporary checkout.

Add tests asserting that simulated reviews still pass and that remote handler options propagate a non-empty `repoPath` and stable memory path through an injected review function. If current handler signatures make mocking difficult, add an optional final `dependencies` parameter with defaults `{ runReview: runPullRequestReview, withWorkspace: withRemoteWorkspace }`; do not use network-only tests.

Run:

```bash
npx tsx --test tests/remote-workspace.test.ts tests/context-and-memory.test.ts tests/security-scanners.test.ts
npm test && npm run build
```

Expected: all pass; no real provider network is needed.

Commit `src/core/remote-workspace.ts`, the four integrations, server/type changes as required, and tests with message `feat: scan remote pull requests with repository context`.

### Phase 5 — Simplify the UI through progressive disclosure

#### Task 5.1 — Add failing UI contract tests before moving markup

Create `tests/ui-contract.test.ts` that reads the static files and asserts:

- Top-level `data-tab` values are exactly `home`, `studio`, `history`, and `settings`.
- Existing panels `tab-repos`, `tab-rules`, and `tab-webhooks` remain present inside `tab-settings`, but their class changes from `tab-panel` to `settings-panel`; only the four top-level destinations retain `tab-panel`. Existing IDs such as `btnRunReview`, `textareaDiff`, `selectProfile`, `selectProvider`, `annotatedDiffContainer`, `globalChatInput`, and report controls remain exactly once.
- A login form `loginForm` and password field `loginToken` exist.
- Home has `btnTryDemo`, `btnConnectProvider`, `homeServerStatus`, `homeAiStatus`, and `homeIntegrationsStatus`.
- `initApp` does not call `executeReview`; demo execution is only in the explicit demo button handler.
- `public/index.html` has no `https://fonts.googleapis.com`, `https://fonts.gstatic.com`, or CDN Mermaid script; it loads `/vendor/mermaid.min.js`.
- `public/app.js` sets Mermaid `securityLevel: 'strict'`.

Run `npx tsx --test tests/ui-contract.test.ts`; expect RED on navigation, login, home, and local assets.

#### Task 5.2 — Restructure navigation and add the Home/Login markup

Edit `public/index.html` only:

- Replace the five current top tabs with `Home`, `Review`, `Activity`, and `Settings`, using data values from Task 5.1. Keep accessible `role="tablist"`, `role="tab"`, `aria-selected`, and keyboard behavior hooks.
- Add `tab-home`: one sentence (“Review pull requests and scan changes on your own server”), primary `Try a demo review`, secondary `Connect a Git provider`, and three status cards for Server, AI provider, and Git providers. Below, show the five most recent reviews with links to existing review detail rendering. Do not auto-populate fake data.
- Rename visible `PR Review Studio` to `Review`; keep `tab-studio` and all review rendering.
- Rename history to `Activity`; add a Jobs card above history with table columns Provider, PR, Status, Attempts, Updated, and Error. Keep analytics below it.
- Add `tab-settings` containing a secondary navigation with Connections, Local repositories, Review behavior, Rules, and Advanced YAML. Move the existing `tab-webhooks`, `tab-repos`, and configuration/rules sections into these subsections without changing their internal IDs. The default Settings subsection is Connections.
- Add a login panel before the app shell with `loginForm`, `loginToken`, `btnLogin`, and `loginStatus`. It accepts the admin token, never stores it, and explains that the token is in `.env` on the server.
- Wrap reviewer engine, profile/provider overrides, raw diff metadata, raw Markdown, webhook simulators, and raw YAML in labeled `<details class="advanced">` elements. Default review controls are only source/PR URL plus a single primary `Review pull request` button; defaults remain `chill`, `auto`, and `hybrid` in the existing hidden/advanced selects so current request code continues working.
- Replace sample-pill prominence with a single `Try a demo` action. Keep the template container in advanced mode so existing code can still use it.

Run the UI contract test; only local-assets and JS-behavior assertions should remain RED. Build is unaffected but run it to catch no accidental TypeScript changes.

Commit markup and tests with message `feat: simplify dashboard navigation and onboarding`.

#### Task 5.3 — Make startup intentional and authentication seamless

Edit `public/app.js`:

- Create `apiFetch(input, init)` around native `fetch`; on 401, show the login panel and throw `Error('Sign in required')`. Replace dashboard API calls with `apiFetch`, except login/logout/health. Preserve request bodies and response handling.
- `initApp` first calls `/api/session` or `/api/status`; if unauthenticated, show login and do not load reviews/rules/repositories. After successful login, hide login and run initialization.
- Remove automatic sample selection/review execution from startup. With no history, show the Home empty state. `btnTryDemo` explicitly selects `SAMPLE_DIFF_TEMPLATES[0]`, switches to Review, and runs once. `btnConnectProvider` opens Settings > Connections.
- On logout, clear `currentReview`, repositories, jobs, and rendered sensitive content before showing login.
- Add top-tab keyboard left/right navigation, update `aria-selected`, and preserve `switchToTab('studio')` used by history. Add `openSettingsSection('connections' | 'repos' | 'review' | 'rules' | 'webhooks' | 'yaml')` to activate exactly one nested `.settings-panel`, load its existing data callback, and update all old links such as `linkGoToReposTab`, `linkConfigureCustomRules`, and integration shortcuts to use it; no old `switchToTab('repos'|'rules'|'webhooks')` call may remain.
- In `src/storage/review-store.ts`, skip sample seeding when `NODE_ENV=production`; retain current development seeding for compatibility unless `OPENRABBIT_SEED_DEMOS=false`. Add a production-server test proving a fresh authenticated `GET /api/reviews` returns an empty array and analytics zeros. This test must fail before the storage change.
- Keep all current suggestion application, chat, filtering, downloads, severity gates, custom rules, and repository callbacks intact.

Update the UI contract test to inspect the extracted `initApp` function body rather than the whole file, ensuring no hidden `executeReview()` call remains.

Run:

```bash
npx tsx --test tests/ui-contract.test.ts
npm test && npm run build
```

Expected: behavior assertions pass; existing API callbacks still compile under the unchanged build.

Commit `public/app.js`, `src/storage/review-store.ts`, and test changes with message `feat: make dashboard startup explicit and authenticated`.

#### Task 5.4 — Turn Connections into a copyable guided checklist

Edit the moved Connections markup and its handlers:

- Platform choices: GitHub, Codeberg / Forgejo, GitLab, Bitbucket.
- One target field accepts a PR/MR URL; the existing optional token field is only for that on-demand review and is cleared immediately after the request. Add text: “For automatic reviews, set the server token in `.env`; browser-entered tokens are not saved.”
- Show configured/not-configured badges from `/api/status`. Never display a token.
- Display and copy the exact webhook URL: `${OPENRABBIT_PUBLIC_URL}/api/webhooks/github`, `/forgejo`, `/gitlab`, or `/bitbucket`. Disable copy with an actionable warning if `publicUrl` is absent or still loopback.
- Show only the relevant provider's 4–6 setup steps, required events, and token-permission link. Include a “Review one PR to test this connection” primary action using the existing on-demand endpoint.
- Add Codeberg to `selectIntegrationPlatform`; map it to `/api/integrations/forgejo/review`. Use `parseForgejoTarget` semantics in the client for immediate validation, but keep server validation authoritative.
- Move simulator buttons into `<details class="advanced">Developer webhook simulator</details>`. Update simulations for async 202 responses, poll `/api/jobs/:id`, and display final status instead of assuming an immediate review body.

Add tests for URL labels and absence of token persistence to `tests/ui-contract.test.ts`. Run it plus full tests/build; expect GREEN.

Commit UI files with message `feat: add guided Git provider connections`.

#### Task 5.5 — Surface real job state and failures in Activity

Edit `public/app.js` and the Activity markup:

- Load `/api/jobs?limit=20` only when Activity is open; poll every 5 seconds while visible and stop polling when hidden or logged out.
- Render job provider, PR/repository when available, status, attempts, relative updated time, and sanitized error text with `textContent`, not `innerHTML`.
- Link completed review results to the existing review detail view when a review ID is present. For failed jobs, show “Check provider token, webhook secret, repository access, or LLM status; redeliver the webhook after fixing the issue.” Do not add a retry endpoint in this phase.
- Show scanner telemetry (`scannersRun`, `scannersSkipped`) on review detail so lite mode never implies Semgrep/Trivy/Gitleaks ran.

Extend `tests/ui-contract.test.ts` for the Jobs table and scanner telemetry labels. Run tests/build and commit as `feat: expose review job health in the dashboard`.

#### Task 5.6 — Make frontend assets private/offline-friendly and responsive

Add `mermaid@10` as a production dependency with `npm install mermaid@10` (update both package manifests). In `src/server/app.ts`, map only `/vendor/mermaid.min.js` to the installed `node_modules/mermaid/dist/mermaid.min.js`; do not expose all of `node_modules`. Remove Google font links and use the existing system-font fallbacks. Change Mermaid to `securityLevel: 'strict'` and render diagram failures as text rather than falling back to loose mode.

In `public/styles.css`: use system fonts, add visible `:focus-visible` outlines, make top/secondary navigation horizontally scrollable on small screens, make forms one column below 720px, keep tables/diffs horizontally scrollable, disable sticky sidebar below 1120px, ensure buttons have at least 44px touch targets on coarse pointers, and respect `prefers-reduced-motion`. Do not change the visual theme or remove feature panels.

Run:

```bash
npx tsx --test tests/ui-contract.test.ts
npm test && npm run build
```

Expected: no external font/CDN assertions remain, Mermaid is strict, and all tests pass.

Commit manifests, server static mapping, and public assets with message `feat: make the dashboard offline-friendly and responsive`.

#### Task 5.7 — Add browser smoke tests for the actual user flows

Add `@playwright/test` as a dev dependency and scripts:

```json
"test:ui": "playwright test"
```

Create `playwright.config.ts` with a `webServer` running `npm run dev -- --port 3847`, base URL `http://127.0.0.1:3847`, health URL `/healthz`, and trace retained on failure. Set test environment `OPENRABBIT_ADMIN_TOKEN=ui-test-token`, `NODE_ENV=production`, `HOST=127.0.0.1`, and a temporary data directory.

Create `tests/ui/dashboard.spec.ts` with four tests:

1. Login failure then success; expect Home and no token in local/session storage.
2. Click `Try a demo review`; expect executive summary, file walkthrough, findings, diagram, and enabled report download; no review occurs before the click.
3. Open Settings > Connections, choose Codeberg, and expect `/api/webhooks/forgejo` instructions and no GitHub-only form.
4. At a 390px viewport, open Home, start demo, and verify `document.documentElement.scrollWidth <= window.innerWidth` except intentionally scrollable diff/table internals; all primary actions remain visible and keyboard focus is visible.

Run:

```bash
npx playwright install chromium
npm run test:ui
```

Expected: `4 passed`. If Chromium cannot be installed in the implementation environment, report the exact blocker and keep the test command in CI; do not substitute static tests and claim browser coverage.

Commit Playwright config/tests and package changes with message `test: cover core dashboard flows in a browser`.

### Phase 6 — Write documentation that a new Pi owner can follow

#### Task 6.1 — Rewrite the README around the first successful review

Rewrite `README.md` while retaining the existing feature/configuration detail in shorter linked sections. The first screen after the title must contain:

1. What it does and the feature-preservation list (walkthroughs, inline suggestions, chat, learning/instructions, profiles/rules, BYOK/heuristic, security scans, SARIF/gates).
2. Requirements: 64-bit Pi OS, ARM64/x86_64, Docker Compose v2, 4 GB RAM recommended, optional Cloudflare account/domain for public webhooks.
3. Quickstart exactly:

```bash
git clone https://github.com/mihastele/openrabbit-review.git openrabbit
cd openrabbit
./scripts/setup-pi.sh
curl -fsS http://127.0.0.1:3847/healthz
```

Expected health output: `{"ok":true}`. Explain that setup prints the admin token once and starts the `lite` image with no API key required.
4. Access from another machine using SSH forwarding:

```bash
ssh -L 3847:127.0.0.1:3847 <pi-user>@<pi-host>
```

Then open `http://127.0.0.1:3847`, sign in, and click `Try a demo review`.
5. Public webhooks: create a named Cloudflare Tunnel and public hostname, set `CLOUDFLARE_TUNNEL_TOKEN` and `OPENRABBIT_PUBLIC_URL=https://review.example.com` in `.env`, then run:

```bash
docker compose up -d --force-recreate
docker compose -f docker-compose.yml -f deploy/docker-compose.tunnel.yml up -d
curl -fsS https://review.example.com/healthz
```

6. One GitHub and one Codeberg minimal example with token/webhook env names and links to detailed guides. Include the GitLab/Bitbucket support matrix and generic Forgejo/self-hosted URLs.
7. Optional AI configuration and an explicit warning about which source/diff data leaves the Pi when an external LLM is used. Default to heuristic and explain `full` scanner mode:

```bash
# In .env: OPENRABBIT_DOCKER_TARGET=full
docker compose up -d --build --force-recreate
```

8. Daily operations: logs, restart, update, backup/restore, and troubleshooting links.

Move exhaustive language/rule inventories to `docs/features.md`; keep links valid. Run `npx markdownlint-cli README.md docs/**/*.md` only if markdownlint is added as a dev tool; otherwise validate all fenced blocks are closed and all relative links resolve with a small `tests/docs-contract.test.ts`.

Commit README/docs test with message `docs: add a Pi-first quickstart`.

#### Task 6.2 — Write exact provider guides

Create `docs/integrations/github.md`, `codeberg.md`, `gitlab.md`, and `bitbucket.md`. Each guide must contain: required env vars, least-privilege token instructions, webhook URL, content type, secret location, exact events, test-delivery steps, expected 202 response, where to see the job, redelivery steps, private-repository notes, and common 401/403/404 fixes.

Provider specifics:

- GitHub: events `Pull requests`, `Pull request review comments`, and `Issue comments`; URL `/api/webhooks/github`; secret `GITHUB_WEBHOOK_SECRET`; token `GITHUB_TOKEN`. Document read-only review versus permissions required to post comments/reviews. Include GitHub Enterprise API/base URL behavior only if implemented and tested.
- Codeberg: token from Settings > Applications; URL `/api/webhooks/forgejo`; Forgejo webhook type, JSON body, secret `FORGEJO_WEBHOOK_SECRET`; PR and PR-comment events. Set `FORGEJO_TOKEN`, and for self-hosted Forgejo override `FORGEJO_WEB_URL` and `FORGEJO_API_URL`. Include a live API capability check for inline reviews and a documented fallback only if the code explicitly reports the fallback; never silently downgrade.
- GitLab: URL `/api/webhooks/gitlab`, secret token `GITLAB_WEBHOOK_SECRET`, Merge Request and Comment events, `GITLAB_TOKEN`, and self-hosted `GITLAB_API_URL`.
- Bitbucket: URL `/api/webhooks/bitbucket`, `BITBUCKET_TOKEN`, signature secret, PR created/updated/comment events, and the exact supported token type. Do not claim app-password Bearer support if the client has not implemented it.

Add `tests/docs-contract.test.ts` assertions that every documented env key exists in `.env.example`, every documented webhook path exists in `src/server/app.ts`, and every relative Markdown link resolves.

Run the docs test; expect `# fail 0`. Commit the guides and test with message `docs: document Git provider setup and recovery`.

#### Task 6.3 — Add operations, security, and troubleshooting guides

Create:

- `docs/hosting/raspberry-pi.md`: architecture check (`uname -m` -> `aarch64`), Docker install verification, setup script, tunnel, firewall/no-port-forward rationale, resource expectations, SD-card backup warning, and native ARM64 verification.
- `docs/operations.md`: `docker compose ps`, `docker compose logs -f --tail=100 openrabbit`, `docker compose restart openrabbit`, update with `git pull` plus `docker compose up -d --build`, backup while stopped, restore ownership, and single-writer warning.
- `docs/security.md`: admin/session model, webhook signature requirements, reverse proxy/TLS expectations, token storage/rotation, source-data retention in `data/reviews.json` and `data/jobs.json`, external LLM data flow, untrusted repository handling, no build/hook execution, scanner limitations, and recommendation to restrict dashboard access where possible.
- `docs/troubleshooting.md`: decision table for UI 401, webhook 401, 403 provider API, empty diff, job queued/running/failed, missing scanners, tunnel offline, permission denied on `data`, large diff 413, LLM timeout, and ARM/x64 binary mismatch. Every row must include the exact diagnostic command and a concrete fix.

Extend the docs test to require these files and the commands above. Run docs tests, full tests, and build; commit as `docs: add self-hosting operations and security guidance`.

### Phase 7 — Final acceptance and release gate

#### Task 7.1 — Run all automated checks from a clean install

Run:

```bash
npm ci
npm test
npm run build
npm run test:ui
npx tsx --test tests/docs-contract.test.ts tests/deployment-contract.test.ts tests/setup-script-contract.test.ts
docker build --target lite -t openrabbit-release:lite .
git diff --check
git status --short
```

Expected: `# fail 0` in every Node test run, TypeScript exits 0, Playwright reports `4 passed`, Docker build succeeds, `git diff --check` has no output, and status contains no unexpected generated runtime data or `.env`.

Run the real container health/auth smoke test from Task 2.5 again. Run the full scanner image build separately:

```bash
docker build --target full -t openrabbit-release:full .
docker run --rm openrabbit-release:full sh -c 'semgrep --version && trivy --version && gitleaks version'
```

Expected: Semgrep `1.185.0`, Trivy `0.76.2`, Gitleaks `8.30.1`. If full ARM64 cannot run in the current environment, mark native full-image verification explicitly pending instead of claiming success.

#### Task 7.2 — Perform two live provider walkthroughs

Using user-owned disposable repositories and user-supplied credentials (never invent or print them):

1. GitHub: open a PR with a small intentional SQL injection, confirm 202 delivery, completed job, one sticky walkthrough, inline committable suggestion, `@openrabbit explain` reply, and updated sticky comment after synchronize. Confirm no duplicate inline review from redelivering the same delivery ID.
2. Codeberg: repeat against a disposable Codeberg PR using a Forgejo webhook. Verify diff fetch, sticky comment, inline review, chat, and synchronize. If Codeberg rejects inline review syntax, record the exact API response, fix the adapter, rerun its mocked test plus live check, and do not mark Codeberg complete on sticky comments alone.
3. Optionally smoke GitLab/Bitbucket if credentials are available; otherwise mark them “existing adapter retained; live verification not run.”

Do not commit provider credentials, repository payloads, or live tokens into tests/docs.

#### Task 7.3 — Final feature and UX sign-off

Verify every item in the Current context feature list against `tests/feature-preservation.test.ts`, existing tests, or a browser check. Confirm:

- A new user can go from clone to local demo without editing YAML or obtaining an API key.
- A user with a public tunnel can copy the correct webhook URL and see the required provider events without reading source code.
- The default Home/Review path contains no reviewer-engine jargon; advanced features remain reachable in Settings.
- No automatic review starts on page load; no seeded sample is presented as a real review in production.
- Mobile login, demo review, findings filtering, report download, chat, and Settings are usable.
- Every failed background job is visible and no success message is emitted after a failed provider write.
- README links, env names, endpoints, and commands match the implementation.

Commit final fixes in small commits, then create the final implementation commit only if files remain:

```bash
git commit -m "docs: record self-hosting acceptance verification"
```

## Tests and validation summary

- Unit/integration: Node's existing runner via `npm test`; targeted RED/GREEN commands are listed per task.
- Browser: Playwright via `npm run test:ui`, four real Chromium flows.
- Deployment: Compose parsing, shell syntax, deployment contract tests, actual Docker health/auth smoke test, and ARM64 build/run where supported.
- Provider contracts: mocked native-fetch tests for every endpoint plus live GitHub/Codeberg acceptance on user-owned test repositories.
- Regression: `tests/feature-preservation.test.ts` guards the existing CodeRabbit-style behavior during DOM and integration changes.
- Security: negative tests for missing auth, bad/expired sessions, unsigned webhooks, invalid HMAC, oversized bodies, wrong-host clone URLs, and credential-free process arguments.

## Risks, tradeoffs, and open questions

- **Forgejo version differences:** Codeberg and self-hosted Forgejo/Gitea can differ in inline-review fields and event names. The adapter isolates this risk, but a live Codeberg test is a hard acceptance gate. Do not add a silent sticky-only fallback.
- **Pi performance:** Semgrep and Trivy can be heavy and require network rule/DB downloads. `lite` is the default and queue concurrency is 1; `full` is explicit. Remote checkouts are temporary and capped by timeout, but disk usage still needs monitoring.
- **Cloudflare dependency:** A named tunnel is the simplest no-port-forward default but adds an external dependency and requires a configured public hostname. Document direct HTTPS/reverse-proxy hosting for users who already have one; do not add multiple competing quickstarts.
- **Single-user auth:** Signed admin cookies are appropriate for one administrator, not organizations or role-based access. Multi-user SSO is out of scope.
- **JSON durability:** Current file writes and job payloads may contain proprietary source. Backups need the same protection as source code. Atomic-write improvements can be a follow-up; clustering is out of scope.
- **Partial provider writes:** Sticky-comment creation can succeed before inline posting fails. Jobs must fail visibly, and delivery deduplication prevents blind duplicates. Fully transactional provider writes are impossible; idempotent inline posting is a future enhancement if live testing shows duplicates after retries.
- **Remote context scope:** Fetching provider refs may fail for some fork permissions or Bitbucket configurations. Fail clearly rather than implying full scanner coverage. A diff-only manual mode can be added later only with an explicit UI/report warning.
- **Feature-parity wording:** This work preserves the repository's existing CodeRabbit-style features; it does not prove feature-for-feature parity with CodeRabbit's evolving SaaS product. Any broader code-graph, auto-commit, or issue-planning work needs a separate plan.
- **Assumption to confirm only if deployment differs:** the plan assumes 64-bit Pi OS and a Cloudflare-managed hostname. If the user has a 32-bit Pi or no public hostname/tunnel account, choose a different hosting guide before implementation rather than silently changing the architecture.

## Definition of done

Done requires all automated checks green, the real lite container healthy as a non-root user, a local no-key demo working through the authenticated UI, GitHub and Codeberg live PR/chat/synchronize flows verified, docs matching actual env vars/endpoints, and every pre-existing review feature still covered. ARM64 native and full-scanner checks must either pass or be reported as explicit pending limitations; they must never be implied successful without execution output.
