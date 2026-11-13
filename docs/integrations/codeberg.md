# Codeberg / Forgejo integration

Codeberg runs Forgejo. OpenRabbit uses one configurable Forgejo adapter for
Codeberg, self-hosted Forgejo, and compatible Gitea instances.

## 1. Create an access token

In Codeberg: **Profile → Settings → Applications → Manage Access Tokens →
Generate New Token**.

Grant the narrowest access available for the repository and issue/pull-request
operations. Codeberg access tokens are sensitive; store the value only in `.env`.

```dotenv
FORGEJO_TOKEN=...
FORGEJO_WEBHOOK_SECRET=<same secret as the webhook>
FORGEJO_WEB_URL=https://codeberg.org
FORGEJO_API_URL=https://codeberg.org/api/v1
```

For self-hosted Forgejo, for example:

```dotenv
FORGEJO_WEB_URL=https://git.example.com
FORGEJO_API_URL=https://git.example.com/api/v1
```

The web URL host is used for clone-host validation and PR URL parsing. The API URL
must point at the `/api/v1` root.

## 2. Create the webhook

Repository **Settings → Webhooks → Add Webhook → Forgejo**:

- Target URL: `https://<your-public-host>/api/webhooks/forgejo`
- HTTP method: POST
- POST content type: `application/json`
- Secret: `FORGEJO_WEBHOOK_SECRET`
- Trigger: pull request and pull request comment events

`/api/webhooks/codeberg` is an alias for the same endpoint. Use whichever appears
in the dashboard connection guide; both verify the same signature.

Forgejo signs the raw request body with HMAC-SHA256. OpenRabbit accepts
`X-Gitea-Signature` and GitHub-compatible `X-Hub-Signature-256`.

## 3. Test it

1. Add a repository webhook and use the provider’s test delivery.
2. Expected response: 202 when asynchronous webhooks are enabled.
3. Open a PR in a disposable repository.
4. Check **Activity → Background review jobs**.
5. Verify the sticky walkthrough comment, inline findings, and
   `@openrabbit explain` reply.

## On-demand review

The dashboard Review page accepts a Codeberg PR URL:

```text
https://codeberg.org/owner/repo/pulls/123
```

The CLI equivalent:

```bash
npx openrabbit review --codeberg owner/repo#123
# or
npx openrabbit review --forgejo owner/repo#123
```

The target parser rejects lookalike hosts such as `evil-codeberg.org`.

## Expected behavior

- opened, synchronized, reopened, and ready-for-review actions are reviewed.
- draft/base-branch controls apply as in other providers.
- Sticky comments are updated rather than duplicated.
- Inline review payloads use `new_line_num`.
- A duplicate delivery ID is deduplicated.
- Provider or scanner failures become visible failed jobs.

## Common errors

### 401 invalid Codeberg webhook signature

The secret does not match, the request body was modified by a proxy, or the wrong
secret header was configured. Check `FORGEJO_WEBHOOK_SECRET` and redeliver.

### 403 or 404 from the API

The token cannot read the repository or write comments/reviews. Recheck token
scope and repository visibility.

### Inline review fails on a self-hosted Forgejo version

Inline-review API capabilities vary by Forgejo/Gitea version. The job fails
visibly rather than silently downgrading to sticky-only. Check the job error,
confirm the instance version, and verify the token can create pull-request
reviews. The sticky walkthrough and chat can still be tested separately.
