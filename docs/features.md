# Features

OpenRabbit preserves the CodeRabbit-style review features this project already
advertised while simplifying setup and adding self-hosted operations.

## PR walkthrough

Every review produces a structured walkthrough:

- Executive summary
- Release notes grouped by module
- Changed-file table with additions, deletions, component, impact, and summary
- Mermaid sequence diagram when the diff supports one
- Review-effort score and estimated review minutes
- Risk assessment
- Security advisories
- Optional rabbit poem
- One sticky `<!-- openrabbit-walkthrough -->` comment, updated on new commits

The exact Markdown posted to a provider is available in the review screen.

## Inline review and suggestions

- Findings include severity, category, file, line range, title, explanation, and
  a rule ID where available.
- Committable suggestion blocks are generated for supported languages.
- Supported severities: `critical`, `warning`, `suggestion`, `nitpick`, `praise`.
- Supported categories include security, bug, performance, maintainability, type
  safety, logic, architecture, and testing.
- Severity/category filters change the view; report exports and severity gates use
  the complete review.

## Interactive PR chat

Mention `@openrabbit` in a PR comment or inline thread:

- `explain` — explain the hunk and execution flow
- `test` — generate language-idiomatic tests
- `fix` — produce a replacement patch
- `docstring` — generate language-standard documentation
- `summary` — summarize the change
- `resolve` — resolve the discussion workflow
- `ignore` — remember an ignored rule for the repository
- `remember` — add a persistent repository instruction

Repository `ignore`/`remember` state is stored under the data directory even when
remote reviews use temporary checkouts.

## Automated review behavior

- Handles pull request opened, synchronized, reopened, and ready-for-review events.
- Can skip drafts and filter base branches.
- Handles provider PR comments for chat.
- Queues webhook reviews in the background.
- Deduplicates repeated provider deliveries.
- Retries transient failures with bounded concurrency.
- Shows queued, running, completed, and failed jobs in Activity.
- Posts nothing as “successful” when a provider write or remote checkout fails.

## Language coverage

The deterministic language strategies cover:

- C# / .NET, including raw EF SQL, `async void`, and sync-over-async risks
- C++ raw allocation, unsafe buffer functions, and catch-by-value slicing
- C unchecked allocation and unbounded string operations
- Java/Kotlin raw JDBC/JPA queries, unclosed streams, and unsafe `Optional.get`
- PHP raw PDO/MySQLi queries, reflected XSS, and shell execution
- Ruby ActiveRecord interpolation, unsafe YAML deserialization, and command execution
- TypeScript/JavaScript async `forEach`, loose equality, timer/event leaks, and
  React hook dependency issues
- Python mutable defaults, f-string SQL, `shell=True`, and bare excepts
- Go missing body close, formatted SQL, and ignored errors
- Rust production `unwrap`, undocumented `unsafe`
- Shell strict mode and unquoted expansions

The same strategies generate test scaffolds and documentation comments for
`@openrabbit test` and `@openrabbit docstring`.

## Rules and configuration

- `chill`, `assertive`, and `security-focused` profiles
- Positive and negative glob path filters
- Per-path review instructions
- Built-in rule mode: all, subset, or none
- Built-in severity and category filters
- Custom Schema v1 regex rules with negative patterns and autofix suggestions
- Workspace custom-rule discovery through `.openrabbit-rules.json` or `.openrabbit-rules.yaml`
- `.coderabbit.yaml` compatibility for supported fields
- Repository memory for ignored rules and persistent instructions

## Review engines

- Built-in static/AST engine — no API key
- OpenAI and OpenAI-compatible APIs
- Anthropic
- Google Gemini
- Ollama
- `auto` selection with heuristic fallback
- `hybrid`, `custom`, `static-only`, and `llm-only` reviewer modes

## Security scans

- Offline built-in security rules
- Optional Semgrep SAST
- Optional Trivy dependency and IaC scanning
- Optional Gitleaks secret scanning
- Diff-scoped or repository security scans
- Secret values redacted from Gitleaks findings
- Scanner telemetry visible on the review
- Missing scanners reported as skipped rather than clean
- Remote PR reviews use temporary repository checkouts so repository context and
  optional scanners can run without executing repository code

## Reports and CI

- SARIF 2.1.0
- JSON
- Markdown
- Terminal output
- Severity gates through `--fail-on`
- Download report from the dashboard
- GitHub Actions code-scanning upload example
- Local reviews, commits, ranges, staged changes, and live PRs

## Integrations

- GitHub.com and compatible API endpoints
- Codeberg and Forgejo/Gitea-compatible instances
- GitLab.com and self-hosted GitLab API URLs
- Bitbucket Cloud
- On-demand PR review by URL
- Signed webhooks
- Automatic comments and inline reviews where the provider API supports them
- CI/CLI operation without webhooks

## Local repositories

- Register any local Git repository.
- Browse commits with author, date, and diff stats.
- Review a commit, range, staged changes, or the working tree.
- Run a repository security scan.
- Detect submodules and nested repositories.
- Browse the filesystem through the dashboard picker.
