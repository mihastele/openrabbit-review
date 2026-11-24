# Getting started

OpenRabbit is a complete review service in one small container: pull-request
walkthroughs, inline findings, chat commands, security scanners, reports, and a
dashboard. You can run it with no LLM key at all, or connect your preferred model
provider when you want deeper review.

## What you need

- A 64-bit Linux machine, Raspberry Pi 4/5, or any machine that runs Docker.
- Docker Engine with Compose v2.
- 4 GB RAM for the default `lite` image. The optional scanner image needs more.
- Optional: an LLM API key or local Ollama instance.
- Optional: an HTTPS hostname for provider webhooks.

OpenRabbit does not require a managed database, Redis, or a hosted control plane.
Review state lives in JSON files under your data directory.

## Install on a Raspberry Pi

The opinionated setup is one command:

```bash
git clone https://github.com/mihastele/openrabbit-review.git openrabbit
cd openrabbit
./scripts/setup-pi.sh
```

The script refuses 32-bit hosts, creates `.env` with mode `600`, generates the
admin and webhook secrets, prepares data ownership, builds the ARM64 image,
starts Compose, and waits for `/healthz`. It prints the admin token once. Save it
in your password manager.

Verify the service:

```bash
docker compose ps
curl -fsS http://127.0.0.1:3847/healthz
```

Expected response:

```json
{"ok":true}
```

## Install with Docker anywhere

```bash
git clone https://github.com/mihastele/openrabbit-review.git openrabbit
cd openrabbit
cp .env.example .env
```

Set at least:

```dotenv
OPENRABBIT_ADMIN_TOKEN=replace-with-a-long-random-value
```

Then start the stack:

```bash
docker compose up -d --build
```

The dashboard binds to `127.0.0.1:3847`. Use an SSH tunnel, a private network, or
an authenticated HTTPS reverse proxy. Never expose the dashboard directly to the
public internet.

## Open the dashboard

From your laptop:

```bash
ssh -L 3847:127.0.0.1:3847 <pi-user>@<pi-host>
```

Open `http://127.0.0.1:3847` and sign in with `OPENRABBIT_ADMIN_TOKEN`. The session
is an HttpOnly, signed cookie with a 12-hour lifetime.

On first load, choose one of these paths:

1. **Try a demo review** — no key or repository required. It shows the walkthrough,
   findings, suggestions, and report view.
2. **Review a PR URL** — paste a GitHub, Codeberg, GitLab, or Bitbucket pull-request
   URL for an on-demand review.
3. **Connect a provider** — add a token and webhook secret for automatic reviews.

## Run your first real review

The quickest path is a public pull request:

1. Open **Review**.
2. Paste a URL such as `https://github.com/owner/repo/pull/123`.
3. Select **Review pull request**.
4. Open the result to inspect the walkthrough, findings, and exact provider
   Markdown.

Without a provider token, OpenRabbit can read public PRs but cannot post comments.
For private repositories and automatic comments, configure a provider.

## Connect a Git provider

- [GitHub](integrations/github.md)
- [Codeberg / Forgejo](integrations/codeberg.md)
- [GitLab](integrations/gitlab.md)
- [Bitbucket](integrations/bitbucket.md)

Each guide covers token permissions, webhook events, the signing secret, test
delivery, and common errors. The dashboard's **Settings → Connections** page shows
the exact URLs and whether each secret is configured.

## Choose a review engine

The default `auto` mode uses the first configured LLM and falls back to the
built-in deterministic engine when no key is available. To stay fully offline:

```dotenv
OPENRABBIT_LLM_PROVIDER=heuristic
```

Supported engines are OpenAI-compatible APIs, Anthropic, Gemini, Ollama, and the
built-in heuristic engine. See [Configuration](configuration.md) for profiles,
path filters, custom rules, and YAML examples.

## Enable the scanner image

The `lite` image includes Git and the built-in static engine. The `full` image adds
Semgrep, Trivy, and Gitleaks:

```dotenv
OPENRABBIT_DOCKER_TARGET=full
```

```bash
docker compose up -d --build --force-recreate
```

Scanner databases are cached under `data/cache/`. A missing scanner is shown as
skipped, never silently reported as clean.

## Next steps

- Learn the dashboard: [Dashboard guide](dashboard.md)
- Use the terminal and CI: [CLI and CI](cli.md)
- Read every capability: [Features](features.md)
- Harden and back up the service: [Security](security.md) and
  [Operations](operations.md)
- Host it: [Raspberry Pi guide](hosting/raspberry-pi.md)
