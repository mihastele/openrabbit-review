# CLI and CI

The CLI uses the same review engine and report formats as the dashboard. It is
useful for local pre-commit review, scripts, and CI jobs that do not need a
long-running webhook server.

## Build the CLI

```bash
npm ci
npm run build
npx openrabbit --help
```

The package exposes the `openrabbit` binary. You can also run the source directly
with `npx tsx src/cli/index.ts`.

## Review local changes

```bash
# Staged changes
npx openrabbit review --staged

# Working tree against a base branch
npx openrabbit review --base main

# A specific commit
npx openrabbit review --repo-path /path/to/repo --commit <sha>

# A commit range
npx openrabbit review --repo-path /path/to/repo --range HEAD~3..HEAD

# A patch file
npx openrabbit review --file changes.diff
```

## Review a live pull request

```bash
npx openrabbit review --github owner/repo#123
npx openrabbit review --codeberg owner/repo#123
npx openrabbit review --gitlab group/project#45
npx openrabbit review --bitbucket workspace/repo#78
```

`--codeberg` is an alias for `--forgejo`. Provider tokens are read from the
environment. Without a token, public reads may work, but posting comments will
not.

## Demo reviews

```bash
npx openrabbit review --demo
npx openrabbit review --demo auth-jwt-sqli
npx openrabbit review --demo react-billing-hook
npx openrabbit review --demo clean-stream-worker
```

Demos are deterministic and require no key.

## Reports and severity gates

```bash
npx openrabbit review --staged --format json --output report.json
npx openrabbit review --staged --format sarif --output openrabbit.sarif
npx openrabbit review --staged --format markdown --output review.md
npx openrabbit review --staged --fail-on warning
```

`--fail-on` accepts `critical`, `warning`, `suggestion`, or `nitpick`. The command
exits with status 1 when a finding at or above that severity exists.

## Security scans

```bash
npx openrabbit review --security-scan
npx openrabbit review --security-scan --format sarif --output security.sarif
```

The offline built-in rules work without external binaries. The `full` Docker image
adds Semgrep, Trivy, and Gitleaks. Scanner availability is reported explicitly;
a missing scanner is skipped, not treated as a clean result.

## Chat from the terminal

```bash
npx openrabbit chat "@openrabbit explain"
npx openrabbit chat "@openrabbit generate unit tests"
npx openrabbit chat "@openrabbit fix"
```

The command uses the configured repository context and review engine.

## Repository management

```bash
npx openrabbit repo list
npx openrabbit repo add /path/to/repo
npx openrabbit repo commits /path/to/repo
npx openrabbit repo remove /path/to/repo
```

## Server and configuration

```bash
npx openrabbit serve --port 3847
npx openrabbit init
npx openrabbit providers
```

`init` writes a `.openrabbit.yaml` template. `providers` prints the supported LLM
providers and whether their required environment variables are present.

## GitHub Actions example

```yaml
name: OpenRabbit review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  security-events: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
      - name: Review
        env:
          OPENRABBIT_LLM_PROVIDER: heuristic
        run: >
          npx openrabbit review
          --repo-path .
          --base "${{ github.base_ref }}"
          --format sarif
          --output openrabbit.sarif
          --fail-on warning
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: openrabbit.sarif
```

Use `heuristic` for a deterministic, keyless CI gate. Add an LLM key only when
the job is allowed to send the selected diff and source context to that provider.

## Exit codes

- `0` — review completed and the severity gate passed.
- `1` — invalid input, a failed review, or a finding at or above `--fail-on`.

Write the report before the gate failure, so CI can still upload SARIF.
