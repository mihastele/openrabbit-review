# Hosting on a Raspberry Pi

This is the opinionated single-user setup. It uses Docker Compose, the `lite`
image, a loopback-bound dashboard, and an optional Cloudflare Tunnel for provider
webhooks.

## Before you start

- 64-bit Raspberry Pi OS. Check with:

```bash
uname -m
```

Expected: `aarch64` or `arm64`. `armv7l` means a 32-bit OS and is unsupported.
- Pi 4 or Pi 5 with 4 GB RAM recommended.
- Docker Engine and Compose v2:

```bash
docker --version
docker compose version
```

- For public webhooks: a Cloudflare-managed domain and a named tunnel.
- Do not run Ollama on the same small Pi as the default setup unless you have
  measured the memory and latency impact.

## Install

```bash
git clone https://github.com/mihastele/openrabbit-review.git openrabbit
cd openrabbit
./scripts/setup-pi.sh
```

The script:

1. Rejects 32-bit hosts.
2. Creates `.env` with mode `600` and random 32-byte admin/webhook secrets.
3. Leaves provider and LLM tokens blank for you to fill in.
4. Creates `data/` and ensures UID/GID 1000 ownership for the non-root container.
5. Runs `docker compose up -d --build`.
6. Waits for `/healthz` and prints the dashboard URL and admin token once.

Check the container:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3847/healthz
```

Expected:

```json
{"ok":true}
```

## Access from your laptop

The Compose file publishes only to `127.0.0.1` by default. Use SSH forwarding:

```bash
ssh -L 3847:127.0.0.1:3847 <pi-user>@<pi-host>
```

Then open `http://127.0.0.1:3847`. The dashboard asks for the admin token from
`.env`.

## Public webhook URL

Provider webhooks cannot reach `127.0.0.1`. Use a Cloudflare named tunnel:

1. In Cloudflare Zero Trust, create a tunnel.
2. Add a public hostname such as `review.example.com`.
3. Point the service to `http://openrabbit:3847`. The tunnel container joins the
   Compose network, so `openrabbit` is its service DNS name.
4. Copy the tunnel token into `.env`:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=...
OPENRABBIT_PUBLIC_URL=https://review.example.com
```

5. Restart the app and start the tunnel:

```bash
docker compose up -d --force-recreate
docker compose -f docker-compose.yml -f deploy/docker-compose.tunnel.yml up -d
```

6. Verify from the public URL:

```bash
curl -fsS https://review.example.com/healthz
```

Do not open router ports unless you have a deliberate HTTPS reverse-proxy setup.
If you already run Caddy or nginx, proxy to `127.0.0.1:3847` and make sure the
dashboard and API are authenticated and HTTPS-protected.

## Add provider tokens

Edit `.env`, fill the token and secret for each provider, then:

```bash
docker compose up -d --force-recreate
```

Provider guides:

- [GitHub](../integrations/github.md)
- [Codeberg / Forgejo](../integrations/codeberg.md)
- [GitLab](../integrations/gitlab.md)
- [Bitbucket](../integrations/bitbucket.md)

## Optional full scanner image

The default image uses Git and the built-in static engine. To add Semgrep, Trivy,
and Gitleaks on a Pi with enough RAM and storage:

```dotenv
OPENRABBIT_DOCKER_TARGET=full
```

```bash
docker compose up -d --build --force-recreate
```

Scanner databases and caches live under `data/cache/`. Monitor disk use.

## ARM64 verification

The image build maps `TARGETARCH=arm64` to ARM64 scanner archives. Native Pi
verification is preferred. From a development machine with BuildKit emulation:

```bash
docker buildx build --platform linux/arm64 --target lite --load -t openrabbit:arm64 .
docker run --rm --platform linux/arm64 openrabbit:arm64 uname -m
```

Expected: `aarch64`. Emulation is not a substitute for a native Pi smoke test.

## SD-card and backup warning

Review history and job metadata are JSON files under `data/`. Back up the
directory and `.env`; both may contain proprietary source-derived review data.
SD cards can fail, so copy backups off the Pi. See
[Operations](../operations.md).

## Troubleshooting

Start with [Troubleshooting](../troubleshooting.md). Useful first commands:

```bash
docker compose ps
docker compose logs --tail=100 openrabbit
docker compose logs --tail=100 cloudflared
```
