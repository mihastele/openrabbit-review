# Configuration

OpenRabbit reads repository configuration from the first matching file:

1. `.openrabbit.yaml`
2. `.openrabbit.yml`
3. `openrabbit.yaml`
4. `.coderabbit.yaml`
5. `.coderabbit.yml`

Unsupported CodeRabbit fields are ignored. The dashboard's **Settings → Review
behavior and rules → Raw YAML** editor writes `.openrabbit.yaml` in the server
workspace.

## Example

```yaml
language: en-US
profile: chill
tone_instructions: Be constructive, concise, and high-signal.
reviewer: hybrid
reviews:
  high_level_summary: true
  poem: true
  review_status: true
  collapse_walkthrough: false
  sequence_diagrams: true
  auto_review:
    enabled: true
    drafts: false
    base_branches:
      - main
      - master
      - develop
  path_filters:
    - "!dist/**"
    - "!node_modules/**"
    - "!*.lock"
  path_instructions:
    - path: "src/api/**"
      instructions: "Check authentication, authorization, validation, rate limiting, and SQL safety."
    - path: "tests/**"
      instructions: "Check edge cases, error paths, and brittle timing assumptions."
chat:
  auto_reply: true
llm:
  provider: auto
  temperature: 0.2
security_scanners:
  enabled: true
  semgrep: true
  trivy: true
  gitleaks: true
  timeout_ms: 30000
  diff_only: true
static_analysis:
  enabled: true
  builtinRules:
    mode: all
  customRulesFiles:
    - .openrabbit-rules.json
    - .openrabbit-rules.yaml
```

## Profiles

- `chill` — high-signal findings and no low-value nitpicks
- `assertive` — thorough, including maintainability suggestions
- `security-focused` — only security-category findings

## Reviewer modes

- `hybrid` — deterministic static rules plus an LLM when configured
- `custom` — selected built-in/custom static rules plus an LLM
- `static-only` — no LLM
- `llm-only` — no static findings

## LLM providers

Set `llm.provider` or the `OPENRABBIT_LLM_PROVIDER` environment variable.

| Provider | Required environment |
|---|---|
| `heuristic` | none |
| `openai` | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `ollama` | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` |
| `auto` | first configured provider, otherwise heuristic |

If an external provider fails at review time, OpenRabbit logs the failure and
falls back to the built-in heuristic engine for that review.

## Security scanners

```yaml
security_scanners:
  enabled: true
  semgrep: true
  trivy: true
  gitleaks: true
  timeout_ms: 30000
  diff_only: true
```

The default `lite` image does not include the external scanner binaries. Set
`OPENRABBIT_DOCKER_TARGET=full` and rebuild to enable them. The UI reports which
scanners ran and which were skipped.

## Environment variables

All supported variables are listed in `.env.example`. The most important are:

| Variable | Purpose |
|---|---|
| `OPENRABBIT_ADMIN_TOKEN` | Dashboard login token; required in production |
| `OPENRABBIT_PUBLIC_URL` | Public HTTPS base URL used for webhook instructions |
| `OPENRABBIT_BIND_ADDRESS` | Host interface for the published container port |
| `OPENRABBIT_DATA_DIR` | Persistent reviews, jobs, PR state, memory, and caches |
| `OPENRABBIT_ASYNC_WEBHOOKS` | Queue provider webhooks asynchronously |
| `OPENRABBIT_JOB_CONCURRENCY` | Background review concurrency, clamped to 1–4 |
| `OPENRABBIT_MAX_BODY_BYTES` | HTTP request-body limit |
| `GITHUB_TOKEN` / `GITHUB_WEBHOOK_SECRET` | GitHub integration |
| `FORGEJO_TOKEN` / `FORGEJO_WEBHOOK_SECRET` | Codeberg/Forgejo integration |
| `GITLAB_TOKEN` / `GITLAB_WEBHOOK_SECRET` | GitLab integration |
| `BITBUCKET_TOKEN` / `BITBUCKET_WEBHOOK_SECRET` | Bitbucket integration |
| `CLOUDFLARE_TUNNEL_TOKEN` | Optional named Cloudflare Tunnel |

## Local CLI configuration

The CLI uses the current repository configuration and stores local data under
`data/` by default. Set `OPENRABBIT_DATA_DIR` to share history with a server or
place it on another volume.
