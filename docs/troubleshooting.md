# Troubleshooting

## Dashboard returns 401 or login fails

**Symptoms:** login says invalid token, or API calls return
`{"error":"Authentication required"}`.

```bash
grep '^OPENRABBIT_ADMIN_TOKEN=' .env | cut -d= -f2- | wc -c
docker compose logs --tail=100 openrabbit | grep -i auth
```

**Fix:** Use the current `.env` token. If it changed, recreate the container and
sign in again. Do not paste the token into a URL or commit it.

## Server exits because the admin token is missing

**Symptom:** logs contain
`OPENRABBIT_ADMIN_TOKEN is required when NODE_ENV=production`.

**Fix:** Set a non-empty `OPENRABBIT_ADMIN_TOKEN` in `.env`, then
`docker compose up -d --force-recreate`.

## Webhook returns 401

**Symptoms:** provider delivery log shows 401 or “Invalid … signature”.

Check:

```bash
docker compose logs --tail=100 openrabbit | grep -i webhook
```

**Fix:** Ensure the provider’s webhook secret exactly matches the corresponding
`*_WEBHOOK_SECRET`. In production a missing secret rejects all webhook requests.
Redeliver the webhook after fixing.

## Webhook returns 404

Check the URL path:

- GitHub: `/api/webhooks/github`
- Codeberg/Forgejo: `/api/webhooks/forgejo` (or `/api/webhooks/codeberg`)
- GitLab: `/api/webhooks/gitlab`
- Bitbucket: `/api/webhooks/bitbucket`

Also confirm `OPENRABBIT_PUBLIC_URL` points to the tunnel and the tunnel is
running.

## Job stays queued or running

Open **Activity → Background review jobs**.

```bash
curl -fsS http://127.0.0.1:3847/api/jobs
docker compose logs --tail=200 openrabbit
```

On a Pi, concurrency is intentionally 1 by default. Long LLM calls and full
scanner runs can take minutes. A running job eventually times out or retries.

## Job failed: provider token or repository access

**Fix:** Verify the token has repository read access and permission to write
issues/pull-request comments or reviews. For private repositories, confirm the
token belongs to an account that can clone the repository.

Redeliver the webhook after fixing the token. A completed delivery is
deduplicated; a failed delivery can be retried.

## Empty diff or “No changes detected”

The provider returned no changed files, the selected commit has no diff, or path
filters excluded everything. Check `reviews.path_filters` and the PR diff. An
empty result is not a clean-security result.

## “No review engine is available”

Static analysis is disabled and the provider resolved to heuristic, or an LLM-only
mode has no provider.

**Fix:** Enable `static_analysis.enabled`, use `provider: heuristic`, or configure
an API key/Ollama endpoint.

## Scanners show skipped

The default `lite` image does not contain Semgrep, Trivy, or Gitleaks. Set
`OPENRABBIT_DOCKER_TARGET=full`, then rebuild:

```bash
docker compose up -d --build --force-recreate
```

Check inside the container:

```bash
docker compose exec openrabbit sh -c 'semgrep --version; trivy --version; gitleaks version'
```

Missing binaries are reported as skipped; they are never silently counted as a
successful scan.

## Cloudflare Tunnel is offline

```bash
docker compose logs --tail=100 cloudflared
```

Verify `CLOUDFLARE_TUNNEL_TOKEN` is set and the tunnel’s public hostname points to
`http://openrabbit:3847`. The app must be healthy before cloudflared starts.

## Port 3847 is unreachable from another machine

Compose publishes to `127.0.0.1` by default. Use SSH forwarding:

```bash
ssh -L 3847:127.0.0.1:3847 <pi-user>@<pi-host>
```

Do not change the bind address to `0.0.0.0` without adding HTTPS and access
controls.

## Permission denied on data

The container runs as UID 1000:

```bash
sudo chown -R 1000:1000 data
docker compose restart openrabbit
```

## HTTP 413 Request body too large

Raise `OPENRABBIT_MAX_BODY_BYTES` in `.env`, recreate the container, and retry.
Very large diffs may be better reviewed through the CLI against a narrower diff.

## LLM timeout or provider error

The review falls back to the built-in engine, but a configured provider may still
be slow or rate-limited.

```bash
docker compose logs --tail=200 openrabbit | grep -i provider
```

Use `OPENRABBIT_LLM_PROVIDER=heuristic` temporarily, or fix the API key/base URL.
Do not put secrets in logs.

## ARM/x64 binary mismatch

```bash
uname -m
docker image inspect openrabbit --format '{{.Architecture}}'
```

Build natively on the Pi or with `--platform linux/arm64`. The full image maps
scanner archives by `TARGETARCH`; a 32-bit OS is unsupported.

## “Invalid Codeberg target”

Use `owner/repo#123` or a URL whose host matches `FORGEJO_WEB_URL`, for example
`https://codeberg.org/owner/repo/pulls/123`. The client rejects lookalike hosts.

## Codeberg inline review fails

Forgejo/Gitea versions may differ in inline-review API behavior. The job will fail
visibly rather than silently downgrade. Check the job error and confirm the token
and Forgejo version. Sticky walkthrough and chat comments can be tested separately.
