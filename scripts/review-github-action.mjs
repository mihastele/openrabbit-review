import { readFileSync } from 'node:fs';
import { loadConfig } from '../dist/config/config-loader.js';
import { reviewGitHubWorkflowRun } from '../dist/integrations/github-actions.js';

const { GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
if (!GITHUB_EVENT_PATH || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
  throw new Error('GitHub Actions event, repository, and token are required.');
}

const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
const { config } = loadConfig();
console.log(await reviewGitHubWorkflowRun({
  run: event.workflow_run,
  repository: GITHUB_REPOSITORY,
  token: GITHUB_TOKEN,
  config,
}));
