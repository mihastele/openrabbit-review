# Dashboard guide

The dashboard is intentionally small: four destinations, one review surface, and
settings hidden until you need them.

## Home

Home answers three questions:

- Is the server healthy?
- Which review engine and providers are configured?
- What happened recently?

The setup checklist links directly to the next missing step. **Try a demo review**
creates a local sample review so you can inspect the output before connecting a
provider or model.

## Review

The primary action is **Review a pull request**. Paste a provider URL:

```text
https://github.com/owner/repo/pull/123
https://codeberg.org/owner/repo/pulls/123
https://gitlab.com/group/project/-/merge_requests/45
https://bitbucket.org/workspace/repo/pull-requests/78
```

The parser validates the host, owner, repository, and number. Lookalike hosts are
rejected.

Open **Advanced review options** when you need to:

- paste a diff or patch file;
- review a local repository, commit, range, staged changes, or working tree;
- run a repository security scan;
- choose a profile or provider override for one review.

The result screen contains:

- the rendered walkthrough;
- findings grouped by severity and category;
- committable suggestions where supported;
- scanner telemetry;
- the exact Markdown that would be posted to the provider;
- JSON, Markdown, and SARIF downloads.

## Activity

Activity has two layers:

- **Background review jobs** shows queued, running, completed, and failed webhook
  jobs with attempt counts and errors.
- **Review history** keeps earlier reviews with their findings, walkthroughs, and
  reports.

A failed job is a real failure. OpenRabbit does not mark a review successful when
the provider write, remote checkout, or LLM call fails. Fix the reported cause and
redeliver the webhook or start a new on-demand review.

## Settings

Settings uses progressive disclosure so the common path stays short.

### Connections

Shows provider readiness, the public webhook base URL, copyable endpoint paths,
required environment variables, and a provider-specific setup checklist. Secrets
are never rendered back into the page.

### Local repositories

Registers a repository path, lists commits, and opens commit or range reviews. The
filesystem picker is available when the server runs on the same machine as the
repositories.

### Review behavior and rules

Controls the review profile, path filters, path instructions, built-in rule mode,
severity/category filters, and custom rule files. The raw YAML editor writes
`.openrabbit.yaml` in the server workspace.

### YAML

The raw editor is the source of truth for advanced configuration. Invalid YAML is
rejected rather than silently ignored. Repository-level files can still be
discovered from a checked-out or registered repository.

## Review profiles

- **Chill** — high-signal findings, fewer nitpicks.
- **Assertive** — broader maintainability and test feedback.
- **Security-focused** — security-category findings only.

Profiles change the review posture, not the stored history. Existing reviews keep
the findings they were created with.

## Chat commands

Mention `@openrabbit` in a PR comment or inline thread:

```text
@openrabbit explain
@openrabbit test
@openrabbit fix
@openrabbit docstring
@openrabbit summary
@openrabbit resolve
@openrabbit ignore
@openrabbit remember
```

`ignore` and `remember` update repository memory. The memory is stored in the data
directory, including when the review used a temporary remote checkout.

## When something looks wrong

1. Open **Activity** and read the job error.
2. Check **Settings → Connections** for a missing token or secret.
3. Run `curl -fsS http://127.0.0.1:3847/healthz`.
4. Follow [Troubleshooting](troubleshooting.md).

The dashboard never stores the admin token in browser storage. If the session
expires, sign in again with the token from `.env`.
