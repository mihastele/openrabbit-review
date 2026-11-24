# Bitbucket integration

## 1. Create a token

Create a Bitbucket Cloud workspace or repository access token with permission to
read repositories and pull requests and create pull-request comments. The current
client sends the value as a Bearer token, so use a token type that supports Bearer
API authentication. A Basic-auth app password is not the same credential format.

```dotenv
BITBUCKET_TOKEN=...
BITBUCKET_WEBHOOK_SECRET=<same secret as the webhook>
BITBUCKET_API_URL=https://api.bitbucket.org/2.0
```

## 2. Create the webhook

Repository **Settings → Webhooks → Add webhook**:

- URL: `https://<your-public-host>/api/webhooks/bitbucket`
- Secret: `BITBUCKET_WEBHOOK_SECRET`
- Triggers: pull request created, updated, and comment created
- Active: enabled

Bitbucket signs the body with HMAC-SHA256. OpenRabbit accepts the signature in
`X-Hub-Signature` or `X-Hub-Signature-256`.

## 3. Test it

1. Trigger a test delivery; expected HTTP response is 202 for async webhooks.
2. Open a pull request.
3. Check **Activity → Background review jobs**.
4. Verify the walkthrough and comment output.
5. Reply with `@openrabbit explain`.

## On-demand review

```bash
npx openrabbit review --bitbucket workspace/repo#78
```

A full PR URL in the dashboard is also accepted.

## Expected behavior

- Created and updated pull requests are reviewed.
- Pull-request comments support `@openrabbit` commands.
- Walkthrough and findings are posted as PR comments.
- Remote checkout uses the source repository clone URL and branch/commit metadata
  supplied by Bitbucket. If the ref cannot be fetched, the job fails visibly rather
  than reducing scanner scope silently.

## Common errors

### 401 invalid Bitbucket signature

Check the webhook secret in Bitbucket and `BITBUCKET_WEBHOOK_SECRET`. Ensure a
proxy is not changing the raw body.

### 403 from Bitbucket

The token lacks repository read, pull-request read, or comment write permission.
A Basic-auth app password may not work with Bearer API requests; create an
appropriate access token.

### Remote checkout fails

Bitbucket fork/source-repository permissions or a missing HTTPS clone link can
prevent checkout. Check the job error, token access to the source repository, and
the PR’s source branch. Do not treat a diff-only fallback as full repository
scanner coverage.
