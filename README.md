# 🐇 OpenRabbit

**Self-hosted AI pull request review, security scanning, and `@openrabbit` PR chat.**

OpenRabbit is an open-source, multi-provider, BYOK alternative to hosted review
bots. It runs on your own machine — including a Raspberry Pi — and works with no
LLM key using its built-in static/AST engine. Add an API key when you want deeper
AI review.

- Sticky PR walkthroughs with summaries, file tables, Mermaid diagrams, effort,
  risk, release notes, and an optional rabbit poem
- Inline findings with committable suggestions
- `@openrabbit explain`, `test`, `fix`, `docstring`, `ignore`, `remember`, and
  `resolve` commands
- Automatic reviews on PR updates, with duplicate webhook delivery protection
- Profiles, path filters, path instructions, custom rules, and repository memory
- GitHub, Codeberg/Forgejo, GitLab, and Bitbucket integrations
- Built-in heuristic checks plus optional Semgrep, Trivy, and Gitleaks
- SARIF, JSON, and Markdown reports with CI severity gates
- Local repository, commit, and working-tree reviews
- One authenticated dashboard for reviews, provider setup, jobs, rules, and history

See the full [feature guide](docs/features.md).

## Documentation site

The visual field manual is built from `docs/` into `site/` and deployed by the
GitHub Pages workflow in `.github/workflows/pages.yml`.

- Hosted site: <https://mihastele.github.io/openrabbit-review/>
- Source pages: [`docs/`](docs/)
- Local preview:

```bash
npm ci
npm run docs:build
python3 -m http.server 8089 --directory site
```

Open `http://127.0.0.1:8089`. To publish, enable **Settings → Pages → Build and
deployment → Source: GitHub Actions**, then push to `main` or run the **Deploy
documentation** workflow manually.

## Requirements

- A 64-bit Linux host. Raspberry Pi OS 64-bit on a Pi 4 or Pi 5 is the primary
  supported Pi target. 32-bit ARM is not supported.
- Docker Engine with Compose v2.
- 4 GB RAM recommended for the default `lite` image. Semgrep/Trivy need more.
- Optional: a domain managed by Cloudflare for a public webhook URL without
  router port forwarding.
- Optional: an OpenAI-compatible, Anthropic, Gemini, or Ollama endpoint.

## Quickstart on a Raspberry Pi

```bash
git clone https://github.com/mihastele/openrabbit-review.git openrabbit
cd openrabbit
./scripts/setup-pi.sh
curl -fsS http://127.0.0.1:3847/healthz
```

Expected health response:

```json
{"ok":true}
```

`setup-pi.sh` checks Docker and the CPU architecture, creates a private `.env`
with generated admin and webhook secrets, fixes the data-directory owner, builds
the ARM64 image, starts the container, and prints the admin token **once**. Save
that token in your password manager.

The image is bound to `127.0.0.1` by default. From another computer, forward the
port over SSH instead of exposing it directly:

```bash
ssh -L 3847:127.0.0.1:3847 <pi-user>@<pi-host>
```

Open `http://127.0.0.1:3847`, sign in with your admin token, and click
**Try a demo review**. No LLM key is required for the demo.

For the complete Pi walkthrough, see
[Hosting on a Raspberry Pi](docs/hosting/raspberry-pi.md).

## Public webhooks with Cloudflare Tunnel

A provider must be able to reach the webhook endpoint over HTTPS. The recommended
setup is a named Cloudflare Tunnel.

1. In Cloudflare Zero Trust, create a named tunnel and a public hostname such as
   `review.example.com` pointing to `http://openrabbit:3847`.
2. Put the tunnel token and public URL in `.env`:

```dotenv
CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
OPENRABBIT_PUBLIC_URL=https://review.example.com
```

3. Recreate the app and start the tunnel:

```bash
docker compose up -d --force-recreate
docker compose -f docker-compose.yml -f deploy/docker-compose.tunnel.yml up -d
curl -fsS https://review.example.com/healthz
```

If you already run Caddy, nginx, or another HTTPS reverse proxy, point it at
`127.0.0.1:3847` instead and keep the same public URL value. Do not expose the
dashboard directly without HTTPS.

## Connect GitHub

Add these to `.env`:

```dotenv
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=the-secret-generated-by-setup
OPENRABBIT_PUBLIC_URL=https://review.example.com
```

Then recreate:

```bash
docker compose up -d --force-recreate
```

In the repository: **Settings → Webhooks → Add webhook**.

- Payload URL: `https://review.example.com/api/webhooks/github`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: **Pull requests**, **Pull request review comments**, **Issue comments**

The dashboard's **Settings → Connections** screen shows the same values and
marks whether a provider token is configured. Full instructions and token
permissions are in [GitHub setup](docs/integrations/github.md).

## Connect Codeberg / Forgejo

```dotenv
FORGEJO_TOKEN=your-codeberg-token
FORGEJO_WEBHOOK_SECRET=the-secret-generated-by-setup
FORGEJO_WEB_URL=https://codeberg.org
FORGEJO_API_URL=https://codeberg.org/api/v1
OPENRABBIT_PUBLIC_URL=https://review.example.com
```

Create a **Forgejo** webhook in the repository with:

- Payload URL: `https://review.example.com/api/webhooks/forgejo`
- Content type: `application/json`
- Secret: `FORGEJO_WEBHOOK_SECRET`
- Events: pull requests and pull request comments

For self-hosted Forgejo or compatible Gitea instances, change
`FORGEJO_WEB_URL` and `FORGEJO_API_URL`. See
[Codeberg / Forgejo setup](docs/integrations/codeberg.md).

GitLab and Bitbucket are supported too: [GitLab](docs/integrations/gitlab.md)
and [Bitbucket](docs/integrations/bitbucket.md).

## Choose a review engine

The default is `auto`, with a deterministic fallback to the built-in engine if
no LLM key is available.

```dotenv
# No key: static/AST review works immediately
OPENRABBIT_LLM_PROVIDER=heuristic

# Or configure one provider
OPENRABBIT_LLM_PROVIDER=openai
OPENAI_API_KEY=...
```

Supported providers are OpenAI-compatible endpoints, Anthropic, Gemini, Ollama,
and the built-in heuristic engine. When an external provider is used, the selected
diff and related source context are sent to that provider according to its terms.
For an air-gapped deployment, use `heuristic` or a local Ollama instance.

### Optional full scanner image

The default `lite` image includes the built-in engine and Git. The optional
`full` image adds Semgrep, Trivy, and Gitleaks:

```dotenv
OPENRABBIT_DOCKER_TARGET=full
```

```bash
docker compose up -d --build --force-recreate
```

Scanner availability is shown on each review. A missing scanner is reported as
skipped; it is never silently counted as a successful scan. See
[Security and data](docs/security.md).

## Using the dashboard

- **Home** — server, AI, and provider status; recent reviews; demo and setup actions
- **Review** — paste a GitHub/Codeberg/GitLab/Bitbucket PR URL, or open advanced
  controls for a diff, local repository, commit, or working-tree review
- **Activity** — background webhook jobs, review history, findings, and analytics
- **Settings** — Connections, local repositories, review profiles, rules, and YAML

Background provider reviews return quickly and run through the job queue. If a
job fails, Activity shows the provider, PR, attempt count, and error. Common fixes
are provider token permissions, a missing webhook secret, repository access, or
an unavailable LLM endpoint.

## CLI quick start

```bash
npm ci
npm run build

# Review staged changes in the current repository
npx openrabbit review --staged

# Review a commit or range
npx openrabbit review --repo-path /path/to/repo --commit <sha>
npx openrabbit review --repo-path /path/to/repo --range HEAD~3..HEAD

# Review a live PR
npx openrabbit review --github owner/repo#123
npx openrabbit review --codeberg owner/repo#123
npx openrabbit review --gitlab group/project#45
npx openrabbit review --bitbucket workspace/repo#78

# Interactive commands
npx openrabbit chat "@openrabbit explain"
npx openrabbit chat "@openrabbit generate unit tests"
```

### Security reviews and CI

```bash
npx openrabbit review \
  --base origin/main \
  --profile security-focused \
  --provider heuristic \
  --format sarif \
  --output openrabbit.sarif \
  --fail-on warning
```

`--fail-on` accepts `none`, `critical`, `warning`, `suggestion`, or `nitpick`.
The report is written before the exit code is set, so CI can upload it even when
the gate fails. Findings are candidates for human review; an empty result does
not prove a repository is secure.

## Configuration

OpenRabbit reads `.openrabbit.yaml`, `.openrabbit.yml`, `.coderabbit.yaml`, or
`.coderabbit.yml`:

```yaml
profile: chill # chill | assertive | security-focused
reviews:
  high_level_summary: true
  poem: true
  sequence_diagrams: true
  auto_review:
    enabled: true
    drafts: false
    base_branches: [main, master, develop]
  path_filters:
    - "!dist/**"
    - "!*.lock"
  path_instructions:
    - path: "src/api/**"
      instructions: "Check authorization, validation, rate limits, and parameterized SQL."
chat:
  auto_reply: true
llm:
  provider: auto
  temperature: 0.2
```

See [Configuration](docs/configuration.md) and [Features](docs/features.md).

## Operations and security

- Back up `data/` and `.env`; both may contain source-derived review data and secrets.
- Keep one container writer per `data/` directory.
- Rotate provider tokens and webhook secrets by editing `.env` and recreating containers.
- Keep the dashboard on `127.0.0.1` behind SSH, a tunnel, or an authenticated
  reverse proxy. Public deployments must use HTTPS.
- Provider webhooks require valid signatures/secrets in production.

Read [Operations](docs/operations.md),
[Security and data](docs/security.md), and
[Troubleshooting](docs/troubleshooting.md).

## Development

```bash
npm ci
npm test
npm run build
npm run test:ui
```

The test suite covers review behavior, webhook signatures and routes, job
deduplication, authentication, remote checkout safety, deployment contracts,
documentation contracts, and four browser flows.

## License

MIT
