# GitHub integration

OpenRabbit supports GitHub.com and GitHub Enterprise-compatible API endpoints.

## 1. Create a token

Use a fine-grained personal access token for the repositories you want reviewed.
Grant at least:

- Metadata: read
- Contents: read
- Pull requests: read and write
- Issues: read and write (walkthrough and chat comments)

For public repositories, read-only review can work without a token, but posting
comments requires write access. Add the token to `.env`:

```dotenv
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=<same secret as the webhook>
GITHUB_API_URL=https://api.github.com
```

For GitHub Enterprise, set `GITHUB_API_URL` to the instance API endpoint and, if
needed, `GITHUB_WEB_HOST` to the web clone hostname.

## 2. Create the webhook

Repository **Settings → Webhooks → Add webhook**:

- Payload URL: `https://<your-public-host>/api/webhooks/github`
- Content type: `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET`
- SSL verification: enabled
- Events: **Pull requests**, **Pull request review comments**, **Issue comments**

The same URL and event list appear in **Settings → Connections** in the dashboard.

## 3. Test it

1. Use **Test delivery** in GitHub; expected HTTP response: 202 when asynchronous
   webhooks are enabled.
2. Open or synchronize a pull request.
3. Open **Activity → Background review jobs**.
4. Confirm a sticky walkthrough comment and inline findings appear.
5. Comment `@openrabbit explain` and verify the bot replies.

## Expected behavior

- New PRs, synchronizations, reopenings, and ready-for-review events are reviewed.
- Draft PRs are skipped unless `reviews.auto_review.drafts` is true.
- Base branches must be in `reviews.auto_review.base_branches` unless that list is
  empty.
- A repeated delivery ID is deduplicated.
- The walkthrough is a single sticky comment updated on later commits.
- Failures are visible as failed jobs; redeliver after fixing the cause.

## Common errors

### 401 from OpenRabbit

The webhook secret does not match. Check `GITHUB_WEBHOOK_SECRET` and the GitHub
webhook secret, then redeliver.

### 403 from GitHub

The token lacks permission to read the repository, create issue comments, or
create pull-request reviews. Recheck fine-grained permissions and repository
selection.

### Empty diff

The PR has no changes, filters excluded every file, or the API request failed.
Check the job error and `reviews.path_filters`.

### SARIF upload is rejected

SARIF upload from fork PRs can have restricted permissions. The review report is
still written before the severity gate fails; follow GitHub’s code-scanning upload
documentation for fork/security-event permissions.
