# Security and data handling

OpenRabbit is designed for a single administrator running their own server. It is
not a multi-tenant review service.

## Dashboard authentication

- In production, `OPENRABBIT_ADMIN_TOKEN` is required at startup.
- Login creates a signed, expiring, HttpOnly, SameSite=Strict session cookie.
- The raw admin token is not stored in the cookie or browser storage.
- Provider webhooks bypass dashboard login but must pass their own signature or
  secret verification.
- `/healthz` is intentionally public and exposes only `{"ok":true}`.

Use HTTPS for any public deployment. The session cookie is marked `Secure` when
`OPENRABBIT_PUBLIC_URL` starts with `https://`.

## Webhook secrets

In production, a missing provider secret rejects webhook requests. Configure:

- `GITHUB_WEBHOOK_SECRET`
- `FORGEJO_WEBHOOK_SECRET`
- `GITLAB_WEBHOOK_SECRET`
- `BITBUCKET_WEBHOOK_SECRET`

Use the same value in the provider webhook settings and in `.env`.

## Tokens

Provider and LLM tokens live in `.env` and are passed to containers as environment
variables. They are not written to review history, job results, URLs, or the UI.
Do not paste tokens into the browser unless using the optional on-demand token
field for a one-off review; browser-entered tokens are not persisted.

Revoke tokens that may have been exposed. Rotate webhook secrets after exposure.
See [Operations](operations.md) for rotation steps.

## Data leaving the server

The built-in heuristic engine runs locally. When an external LLM provider is
configured:

- The selected diff, file summaries, and related source context are sent to that
  provider.
- Provider terms, retention, and regional processing apply.
- Use `heuristic` or a local Ollama endpoint for air-gapped or highly sensitive
  code.

Review history stores diffs and findings under `data/`. Job state stores webhook
payloads. Both can contain proprietary source. Protect backups and the data
volume like source code.

## Untrusted repositories

- Remote PRs are checked out into temporary directories using Git.
- Repository code, build scripts, package installs, tests, and Git hooks are not
  executed by OpenRabbit.
- Git hooks are disabled in temporary checkouts.
- Provider hostnames and protocols are validated before checkout.
- Tokens are supplied through a temporary askpass environment, not a URL.
- Temporary checkout directories are removed after the review.

Static scanners still parse untrusted source. Keep the full scanner image current
and treat scanner findings as candidates for review, not proof of exploitability.

## Scanner limitations

- Semgrep, Trivy, and Gitleaks are optional and only exist in the `full` image.
- Missing binaries are reported as skipped.
- Diff-scoped scans do not prove repository-wide safety.
- Cross-file attack paths and vulnerability databases are not exhaustive.
- A clean result is not a security guarantee.

## Network exposure

- Compose binds the published port to `127.0.0.1` by default.
- Prefer SSH forwarding or a named tunnel.
- If exposing through a tunnel/reverse proxy, enforce HTTPS and keep the dashboard
  authenticated.
- Do not place the service directly on the public internet without a deliberate
  HTTPS/auth design.
- Provider webhooks need public reachability, but the dashboard does not.

## Resource limits

Docker drops Linux capabilities and enables `no-new-privileges` for OpenRabbit.
The container runs as the non-root `node` user. The temporary checkout directory
is under `/tmp`; the Compose file gives it a bounded tmpfs.
