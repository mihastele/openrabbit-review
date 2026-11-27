# Operations

## Inspect and restart

```bash
docker compose ps
docker compose logs -f --tail=100 openrabbit
docker compose restart openrabbit
```

Health check:

```bash
curl -fsS http://127.0.0.1:3847/healthz
```

Expected: `{"ok":true}`.

## Update

```bash
cd openrabbit
git pull
docker compose up -d --build
curl -fsS http://127.0.0.1:3847/healthz
```

Review the release notes before updating. Back up `data/` first for major
changes.

## Backup

Stop the container before copying JSON state so files are not changing mid-copy:

```bash
docker compose stop openrabbit
tar -czf "openrabbit-backup-$(date +%Y%m%d).tar.gz" data .env .openrabbit.yaml
docker compose start openrabbit
```

Store backups somewhere other than the Pi's SD card. The archive contains review
history, source diffs, job payloads, repository memory, and secrets. Protect it
accordingly.

## Restore

```bash
docker compose stop openrabbit
tar -xzf openrabbit-backup-YYYYMMDD.tar.gz
sudo chown -R 1000:1000 data
docker compose start openrabbit
```

## Single-writer rule

`data/` uses JSON files. Run exactly one OpenRabbit container per data directory.
Do not mount the same directory into multiple replicas. This is a single-user,
single-process design; it is not a clustered database.

## Rotate secrets

1. Generate a new value, for example:

```bash
openssl rand -hex 32
```

2. Update the matching value in `.env`.
3. Recreate the app:

```bash
docker compose up -d --force-recreate
```

4. Update the same secret in the Git provider’s webhook settings.
5. For the dashboard admin token, sign out and back in with the new value.
6. Revoke the old provider token at the provider.

## Inspect jobs

Use **Activity → Background review jobs**, or:

```bash
curl -fsS http://127.0.0.1:3847/api/jobs
```

Authenticated browser sessions use an HttpOnly cookie. Direct API requests need
that cookie; this project does not expose provider tokens through the API.

The async webhook endpoint returns HTTP 202 after saving the job. If saving
fails and the endpoint returns HTTP 503, restore writable queue storage and
redeliver the webhook.

Pending jobs resume when the service starts. Retries use exponential backoff
starting at `OPENRABBIT_RETRY_DELAY_MS`. The `nextAttemptAt` time shown by the jobs API
survives a restart.
An interrupted attempt counts toward `OPENRABBIT_JOB_MAX_ATTEMPTS`. If it was the
last allowed attempt, the job appears as failed. If the process stops after a
provider write, a resumed attempt can repeat that write.

The queue keeps every pending job and up to 200 completed or failed jobs. If the
saved queue cannot be read on startup, restore a valid `jobs.json` from backup
before restarting the service.

## Data locations

- `data/reviews.json` — review results and source diff metadata
- `data/jobs.json` — webhook job queue state and payloads
- `data/repositories.json` — registered local repositories
- `data/pr-states.json` — last-reviewed SHA per PR
- `data/memory/` — persistent remote repository instructions/ignored rules
- `data/cache/` — optional scanner caches
- `.env` — secrets and deployment configuration
- `.openrabbit.yaml` — repository review configuration

## Upgrade the scanner image

The full image pins Semgrep, Trivy, and Gitleaks versions in the `Dockerfile`.
Treat a version bump as a reviewed change: rebuild, verify the three binaries,
and check `security_scanners` behavior before deploying.
