# GitLab integration

## 1. Create a token

Create a personal, project, or group access token with the `api` scope. The token
must be able to read the project and create merge-request notes.

```dotenv
GITLAB_TOKEN=glpat-...
GITLAB_WEBHOOK_SECRET=<same secret as the webhook>
GITLAB_API_URL=https://gitlab.com/api/v4
```

For self-hosted GitLab, set `GITLAB_API_URL` to the instance’s `/api/v4` root and
optionally `GITLAB_WEB_HOST` to the web clone hostname.

## 2. Create the webhook

Project **Settings → Webhooks**:

- URL: `https://<your-public-host>/api/webhooks/gitlab`
- Secret token: `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events** and **Comments**
- SSL verification: enabled

## 3. Test it

1. Use **Test → Merge request events**.
2. Expected response: 202 when async webhooks are enabled.
3. Open or update a merge request.
4. Check **Activity → Background review jobs**.
5. Verify the merge-request note and inline/finding output.
6. Comment `@openrabbit explain` and verify the reply.

## On-demand review

```bash
npx openrabbit review --gitlab group/project#45
```

The dashboard accepts a GitLab merge-request URL whose project path is before
`/-/merge_requests/<iid>`.

## Expected behavior

- Merge-request open, reopen, and update events are reviewed.
- The walkthrough and findings are posted as merge-request notes.
- Chat commands are answered when the token permits writing notes.
- Failures are visible in the job list.

## Common errors

### 401 invalid GitLab token

The webhook secret token does not match `GITLAB_WEBHOOK_SECRET`. Fix it in the
GitLab webhook and in `.env`, recreate the container, then redeliver.

### 403 from GitLab

The token lacks `api` scope, project access, or permission to create notes.

### Empty diff

Check the merge-request changes, path filters, and job error. A commit-only
on-demand review can be diff-only when no PR ref is available.
