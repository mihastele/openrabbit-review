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
If you supply a GitHub App installation token, set `GITHUB_BOT_LOGIN` to the
app's bot login, such as `openrabbit[bot]`. Personal access tokens use the
identity GitHub returns for the authenticated user.

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
- Webhook and on-demand PR reviews read repository configuration from the
  reviewed base commit when a token is configured. The review uses the exact
  base and head commits, with a verified checkout of the head for context.
- Queued webhook events for an older head are skipped. Within one server
  process, OpenRabbit publishes one review per PR at a time and checks the PR
  before posting the walkthrough and inline findings. An on-demand publishing
  request returns HTTP 409 if the PR changes during review.
- A repeated delivery ID is deduplicated.
- The walkthrough is a single sticky comment updated on later commits.
- Webhook, on-demand, and Actions publishing check GitHub for the same
  publisher's walkthrough and submitted inline review before writing. Once
  GitHub exposes an accepted write in its API, a retry reuses it. A different
  base or head commit is a new review snapshot.
- Across pushes, a finding keeps its existing inline comment when GitHub maps
  it to the same source in the current diff and the finding identity and
  severity still match. New occurrences, changed evidence, and outdated
  comments can get fresh inline feedback. Older comments without a finding
  fingerprint may be posted once more after an upgrade.
- Failures are visible as failed jobs; redeliver after fixing the cause.

## GitHub Actions review

OpenRabbit's own repository runs read-only CI on pull requests. After CI passes,
a separate workflow runs the reviewer from the default branch. It uses the
default branch's OpenRabbit configuration and compares the PR's base and head
commits through the GitHub API. It rechecks both commits before posting a
walkthrough and any inline findings.

The publisher receives the GitHub Actions token and any configured OpenAI,
Anthropic, or Gemini secrets. Without a model key, it uses the built-in review
engine. GitHub enables the publisher once its workflow is on the repository's
default branch. The **Checks** status is the aggregate CI check for branch
rules. Use the webhook integration for PR chat and checkout-based review context.

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
