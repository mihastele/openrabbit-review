import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  mergeConfig,
  parseYamlConfig,
  serializeConfigToYaml,
} from '../config/config-loader.js';
import { handlePRChat } from '../core/chat-engine.js';
import { parseUnifiedDiff } from '../core/diff-parser.js';
import { getLocalGitDiff } from '../core/git-utils.js';
import {
  getProvidersStatus,
  resolveActiveProvider,
} from '../core/llm-provider.js';
import { runPullRequestReview } from '../core/review-engine.js';
import {
  handleGitHubWebhookEvent,
  verifyGitHubWebhookSignature,
} from '../integrations/github.js';
import {
  handleGitLabWebhookEvent,
  verifyGitLabWebhookToken,
} from '../integrations/gitlab.js';
import {
  ReviewStore,
  SAMPLE_DIFF_TEMPLATES,
} from '../storage/review-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerInstance {
  server: http.Server;
  store: ReviewStore;
  port: number;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, X-GitHub-Event, X-Hub-Signature-256, X-Gitlab-Event, X-Gitlab-Token',
  });
  res.end(body);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export async function createOpenRabbitServer(options: {
  port?: number;
  workspaceDir?: string;
  storageDir?: string;
} = {}): Promise<ServerInstance> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const store = new ReviewStore(
    options.storageDir || path.join(workspaceDir, 'data')
  );
  await store.init();

  const publicDirCandidates = [
    path.join(workspaceDir, 'public'),
    path.resolve(__dirname, '../../public'),
  ];
  const publicDir =
    publicDirCandidates.find((d) => fs.existsSync(d)) || publicDirCandidates[0];

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type, X-GitHub-Event, X-Hub-Signature-256, X-Gitlab-Event, X-Gitlab-Token',
        });
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // ======================================================================
      // API Routes
      // ======================================================================
      if (pathname === '/api/status' && req.method === 'GET') {
        const { config, configPath } = loadConfig(workspaceDir);
        const activeProvider = resolveActiveProvider(
          config.llm.provider,
          config.llm.model
        );
        const analytics = await store.getAnalyticsSummary();
        sendJson(res, 200, {
          version: '1.0.0',
          activeProvider,
          providers: getProvidersStatus(),
          config,
          configPath,
          yamlConfig: serializeConfigToYaml(config),
          analytics,
          webhooks: {
            githubConfigured: Boolean(process.env.GITHUB_TOKEN),
            gitlabConfigured: Boolean(process.env.GITLAB_TOKEN),
          },
        });
        return;
      }

      if (pathname === '/api/templates' && req.method === 'GET') {
        sendJson(res, 200, { templates: SAMPLE_DIFF_TEMPLATES });
        return;
      }

      if (pathname === '/api/reviews' && req.method === 'GET') {
        const reviews = await store.listReviews();
        const analytics = await store.getAnalyticsSummary();
        sendJson(res, 200, { reviews, analytics });
        return;
      }

      if (pathname.startsWith('/api/reviews/') && req.method === 'GET') {
        const id = pathname.slice('/api/reviews/'.length);
        const review = await store.getReviewById(id);
        if (!review) {
          sendJson(res, 404, { error: 'Review not found' });
          return;
        }
        const parsedDiff = review.rawDiff
          ? parseUnifiedDiff(review.rawDiff)
          : { files: [], totalAdditions: 0, totalDeletions: 0, totalFiles: 0 };
        sendJson(res, 200, { review, parsedDiff });
        return;
      }

      if (pathname === '/api/review' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const diff = String(body.diff || '');
        if (!diff.trim()) {
          sendJson(res, 400, { error: 'Diff content is required.' });
          return;
        }

        const { config: baseConfig } = loadConfig(workspaceDir);
        let effectiveConfig = structuredClone(baseConfig);
        if (body.yamlConfig && typeof body.yamlConfig === 'string') {
          effectiveConfig = parseYamlConfig(body.yamlConfig);
        }
        if (body.profile) {
          effectiveConfig.profile = body.profile;
        }
        if (body.provider) {
          effectiveConfig.llm.provider = body.provider;
        }
        if (body.model) {
          effectiveConfig.llm.model = body.model;
        }

        const review = await runPullRequestReview({
          rawDiff: diff,
          prTitle: body.prTitle || 'Interactive PR Review',
          repository: body.repository || 'local/playground',
          prNumber: body.prNumber ? Number(body.prNumber) : undefined,
          author: body.author || 'developer',
          source: body.source || 'playground',
          config: effectiveConfig,
        });

        await store.addReview(review);
        const parsedDiff = parseUnifiedDiff(diff);
        const analytics = await store.getAnalyticsSummary();

        sendJson(res, 200, { review, parsedDiff, analytics });
        return;
      }

      if (pathname === '/api/review/local' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const localInfo = getLocalGitDiff({
          cwd: workspaceDir,
          staged: Boolean(body.staged),
          baseBranch: body.baseBranch,
        });

        if (!localInfo.diff.trim()) {
          sendJson(res, 200, {
            empty: true,
            message:
              'No uncommitted git changes or commits found in the local repository. Try loading one of the sample PR diffs or modifying a file!',
          });
          return;
        }

        const { config } = loadConfig(workspaceDir);
        const review = await runPullRequestReview({
          rawDiff: localInfo.diff,
          prTitle: `Local Review: ${localInfo.description} (${localInfo.branch})`,
          repository: localInfo.repoName,
          author: localInfo.author,
          headBranch: localInfo.branch,
          source: 'cli',
          config,
        });

        await store.addReview(review);
        const parsedDiff = parseUnifiedDiff(localInfo.diff);
        const analytics = await store.getAnalyticsSummary();

        sendJson(res, 200, { review, parsedDiff, analytics, localInfo });
        return;
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { config } = loadConfig(workspaceDir);
        if (body.provider) {
          config.llm.provider = body.provider;
        }

        const chatResponse = await handlePRChat(
          {
            query: String(body.query || '@openrabbit explain'),
            diff: body.diff,
            file: body.file,
            line: body.line,
            findingContext: body.findingContext,
            prTitle: body.prTitle,
          },
          config
        );

        sendJson(res, 200, chatResponse);
        return;
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        const { config, configPath } = loadConfig(workspaceDir);
        sendJson(res, 200, {
          config,
          configPath,
          yaml: serializeConfigToYaml(config),
        });
        return;
      }

      if (pathname === '/api/config' && req.method === 'PUT') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { config: currentConfig } = loadConfig(workspaceDir);

        const updatedConfig = body.yaml
          ? parseYamlConfig(String(body.yaml))
          : mergeConfig(currentConfig, body.config || {});

        const targetPath = path.join(workspaceDir, '.openrabbit.yaml');
        const yamlString = serializeConfigToYaml(updatedConfig);
        fs.writeFileSync(targetPath, yamlString, 'utf8');

        sendJson(res, 200, {
          saved: true,
          configPath: targetPath,
          config: updatedConfig,
          yaml: yamlString,
        });
        return;
      }

      // ======================================================================
      // GitHub & GitLab Webhook Endpoints
      // ======================================================================
      if (pathname === '/api/webhooks/github' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const sigHeader = req.headers['x-hub-signature-256'] as
          | string
          | undefined;
        const eventName =
          (req.headers['x-github-event'] as string) || 'pull_request';

        if (
          !verifyGitHubWebhookSignature(
            rawBody,
            sigHeader,
            process.env.GITHUB_WEBHOOK_SECRET
          )
        ) {
          sendJson(res, 401, { error: 'Invalid GitHub webhook signature' });
          return;
        }

        const payload = JSON.parse(rawBody || '{}');
        const { config } = loadConfig(workspaceDir);
        const result = await handleGitHubWebhookEvent(eventName, payload, config);
        if (result.reviewResult) {
          await store.addReview(result.reviewResult);
        }
        sendJson(res, 200, result);
        return;
      }

      if (pathname === '/api/webhooks/gitlab' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const tokenHeader = req.headers['x-gitlab-token'] as string | undefined;
        const eventHeader =
          (req.headers['x-gitlab-event'] as string) || 'Merge Request Hook';

        if (
          !verifyGitLabWebhookToken(
            tokenHeader,
            process.env.GITLAB_WEBHOOK_SECRET
          )
        ) {
          sendJson(res, 401, { error: 'Invalid GitLab webhook token' });
          return;
        }

        const payload = JSON.parse(rawBody || '{}');
        const { config } = loadConfig(workspaceDir);
        const result = await handleGitLabWebhookEvent(
          eventHeader,
          payload,
          config
        );
        if (result.reviewResult) {
          await store.addReview(result.reviewResult);
        }
        sendJson(res, 200, result);
        return;
      }

      // ======================================================================
      // Static Files (Web Dashboard & Interactive Playground)
      // ======================================================================
      const safePath = pathname === '/' ? '/index.html' : pathname;
      const resolvedFile = path.join(publicDir, path.normalize(safePath));
      if (
        resolvedFile.startsWith(publicDir) &&
        fs.existsSync(resolvedFile) &&
        fs.statSync(resolvedFile).isFile()
      ) {
        const ext = path.extname(resolvedFile).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(resolvedFile).pipe(res);
        return;
      }

      sendJson(res, 404, { error: `Not found: ${pathname}` });
    } catch (err) {
      console.error('[OpenRabbit Server Error]', err);
      sendJson(res, 500, {
        error: (err as Error).message || 'Internal Server Error',
      });
    }
  });

  const requestedPort =
    options.port !== undefined
      ? options.port
      : Number(process.env.PORT || 3847);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(requestedPort, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === 'object' && addr ? addr.port : requestedPort;
      resolve({
        server,
        store,
        port: actualPort,
        close: () =>
          new Promise<void>((resClose, rejClose) =>
            server.close((e) => (e ? rejClose(e) : resClose()))
          ),
      });
    });
  });
}
