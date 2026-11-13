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
import {
  getAllBuiltinRulesCatalog,
  testCustomRule,
  validateCustomRuleV1,
  STARTER_SAMPLE_CUSTOM_RULES_V1,
} from '../core/custom-rules/index.js';
import { handlePRChat } from '../core/chat-engine.js';
import { parseUnifiedDiff } from '../core/diff-parser.js';
import {
  browseFilesystem,
  findSubrepos,
  getCommitDiff,
  getLocalGitDiff,
  getRepoCommits,
  getRepoMetadata,
  validateGitRepository,
} from '../core/git-utils.js';
import {
  getProvidersStatus,
  resolveActiveProvider,
} from '../core/llm-provider.js';
import { runPullRequestReview } from '../core/review-engine.js';
import { ReviewJobQueue } from '../core/job-queue.js';
import { buildRepositorySecurityDiff } from '../core/repository-security-scan.js';
import { exceedsFailureThreshold, formatSarifReport, type FailureThreshold } from '../core/sarif-formatter.js';
import {
  clearedSessionCookie,
  isAuthenticated,
  sessionCookie,
  tokensEqual,
} from './auth.js';
import {
  handleBitbucketWebhookEvent,
  runBitbucketOnDemandReview,
  verifyBitbucketWebhook,
} from '../integrations/bitbucket.js';
import {
  handleGitHubWebhookEvent,
  runGitHubOnDemandReview,
  verifyGitHubWebhookSignature,
} from '../integrations/github.js';
import {
  handleForgejoWebhookEvent,
  runForgejoOnDemandReview,
  verifyForgejoWebhookSignature,
} from '../integrations/forgejo.js';
import {
  handleGitLabWebhookEvent,
  runGitLabOnDemandReview,
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

class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function readBody(
  req: http.IncomingMessage,
  maxBytes = Number(process.env.OPENRABBIT_MAX_BODY_BYTES || 2 * 1024 * 1024)
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        tooLarge = true;
        reject(new RequestError(413, 'Request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  applySecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
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
  host?: string;
  workspaceDir?: string;
  storageDir?: string;
} = {}): Promise<ServerInstance> {
  const adminToken = process.env.OPENRABBIT_ADMIN_TOKEN;
  if (process.env.NODE_ENV === 'production' && !adminToken) {
    throw new Error('OPENRABBIT_ADMIN_TOKEN is required when NODE_ENV=production');
  }

  const workspaceDir = options.workspaceDir || process.cwd();
  const resolvedStorageDir =
    options.storageDir ||
    process.env.OPENRABBIT_DATA_DIR ||
    path.join(workspaceDir, 'data');
  const store = new ReviewStore(resolvedStorageDir);
  await store.init();

  interface WebhookJobPayload {
    provider: 'github' | 'gitlab' | 'bitbucket' | 'forgejo';
    eventName: string;
    payload: any;
  }

  const executeWebhook = async (jobPayload: WebhookJobPayload) => {
    const { config } = loadConfig(workspaceDir);
    let result: { handled: boolean; message?: string; reviewResult?: any };
    if (jobPayload.provider === 'github') {
      result = await handleGitHubWebhookEvent(jobPayload.eventName, jobPayload.payload, config);
    } else if (jobPayload.provider === 'gitlab') {
      result = await handleGitLabWebhookEvent(jobPayload.eventName, jobPayload.payload, config);
    } else if (jobPayload.provider === 'forgejo') {
      result = await handleForgejoWebhookEvent(jobPayload.eventName, jobPayload.payload, config);
    } else {
      result = await handleBitbucketWebhookEvent(jobPayload.eventName, jobPayload.payload, config);
    }
    if (result.reviewResult) {
      await store.addReview(result.reviewResult);
      if (result.reviewResult.prNumber && result.reviewResult.commitSha) {
        await store.upsertPRReviewState({
          repository: result.reviewResult.repository,
          prNumber: result.reviewResult.prNumber,
          lastReviewedSha: result.reviewResult.commitSha,
          lastReviewId: result.reviewResult.id,
        });
      }
    }
    return result;
  };

  const jobQueue = new ReviewJobQueue<WebhookJobPayload, { handled: boolean; message?: string; reviewResult?: any }>({
    concurrency: Math.max(
      1,
      Math.min(4, Number(process.env.OPENRABBIT_JOB_CONCURRENCY || 1) || 1)
    ),
    maxAttempts: Math.max(
      1,
      Math.min(5, Number(process.env.OPENRABBIT_JOB_MAX_ATTEMPTS || 3) || 3)
    ),
    retryDelayMs: Math.max(
      0,
      Number(process.env.OPENRABBIT_RETRY_DELAY_MS || 1000) || 1000
    ),
    persistPath: path.join(resolvedStorageDir, 'jobs.json'),
    processor: async (job) => executeWebhook(job.payload),
  });

  const publicDirCandidates = [
    path.join(workspaceDir, 'public'),
    path.resolve(__dirname, '../../public'),
  ];
  const publicDir =
    publicDirCandidates.find((d) => fs.existsSync(d)) || publicDirCandidates[0];

  const server = http.createServer(async (req, res) => {
    try {
      applySecurityHeaders(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Health must stay public for Docker, tunnels, and uptime checks.
      if (pathname === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/session' && req.method === 'POST') {
        let body: { token?: unknown } = {};
        try {
          body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
        } catch (error) {
          if (error instanceof RequestError) throw error;
          sendJson(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const providedToken = typeof body.token === 'string' ? body.token : '';
        if (!adminToken || !tokensEqual(providedToken, adminToken)) {
          sendJson(res, 401, { error: 'Invalid admin token' });
          return;
        }
        const secure =
          process.env.OPENRABBIT_PUBLIC_URL?.startsWith('https://') === true;
        res.setHeader('Set-Cookie', sessionCookie(adminToken, secure));
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === '/api/session' && req.method === 'DELETE') {
        res.setHeader('Set-Cookie', clearedSessionCookie());
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === '/api/session' && req.method === 'GET') {
        sendJson(res, 200, {
          authenticated: isAuthenticated(req, adminToken),
        });
        return;
      }

      // Provider webhooks authenticate with their own signatures below.
      if (
        pathname.startsWith('/api/') &&
        !pathname.startsWith('/api/webhooks/') &&
        !isAuthenticated(req, adminToken)
      ) {
        sendJson(res, 401, { error: 'Authentication required' });
        return;
      }

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
        const repositories = await store.listRepositories();
        sendJson(res, 200, {
          version: '1.0.0',
          publicUrl: process.env.OPENRABBIT_PUBLIC_URL || null,
          activeProvider,
          providers: getProvidersStatus(),
          config,
          configPath,
          yamlConfig: serializeConfigToYaml(config),
          analytics,
          repositoriesCount: repositories.length,
          webhooks: {
            githubConfigured: Boolean(process.env.GITHUB_TOKEN),
            gitlabConfigured: Boolean(process.env.GITLAB_TOKEN),
            bitbucketConfigured: Boolean(process.env.BITBUCKET_TOKEN),
            forgejoConfigured: Boolean(process.env.FORGEJO_TOKEN),
            githubWebhookConfigured: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
            gitlabWebhookConfigured: Boolean(process.env.GITLAB_WEBHOOK_SECRET),
            bitbucketWebhookConfigured: Boolean(process.env.BITBUCKET_WEBHOOK_SECRET),
            forgejoWebhookConfigured: Boolean(process.env.FORGEJO_WEBHOOK_SECRET),
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
        const [id, action, extra] = pathname.slice('/api/reviews/'.length).split('/');
        if (extra || (action && !['export', 'gate'].includes(action))) {
          sendJson(res, 404, { error: 'Review endpoint not found' });
          return;
        }
        const review = await store.getReviewById(id);
        if (!review) {
          sendJson(res, 404, { error: 'Review not found' });
          return;
        }
        if (action === 'export') {
          const format = url.searchParams.get('format') || 'sarif';
          if (!['sarif', 'json', 'markdown'].includes(format)) {
            sendJson(res, 400, { error: 'Invalid format. Use sarif, json, or markdown.' });
            return;
          }
          const content = format === 'sarif' ? JSON.stringify(formatSarifReport(review), null, 2)
            : format === 'json' ? JSON.stringify(review, null, 2) : review.markdownWalkthrough;
          const extension = format === 'markdown' ? 'md' : format;
          res.writeHead(200, {
            'Content-Type': format === 'markdown' ? 'text/markdown; charset=utf-8'
              : format === 'sarif' ? 'application/sarif+json; charset=utf-8' : 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="openrabbit-${review.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.${extension}"`,
          });
          res.end(content + '\n');
          return;
        }
        if (action === 'gate') {
          const threshold = url.searchParams.get('threshold') || 'none';
          if (!['none', 'critical', 'warning', 'suggestion', 'nitpick'].includes(threshold)) {
            sendJson(res, 400, { error: 'Invalid threshold. Use none, critical, warning, suggestion, or nitpick.' });
            return;
          }
          sendJson(res, 200, {
            threshold,
            status: threshold === 'none' ? 'advisory'
              : exceedsFailureThreshold(review.findings, threshold as FailureThreshold) ? 'failed' : 'passed',
          });
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
        if (body.reviewer) {
          effectiveConfig.reviewer = body.reviewer;
        }
        if (body.staticAnalysis) {
          effectiveConfig = mergeConfig(effectiveConfig, {
            static_analysis: body.staticAnalysis,
          });
        }
        if (Array.isArray(body.customRules)) {
          effectiveConfig = mergeConfig(effectiveConfig, {
            custom_rules: body.customRules,
          });
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
          strict: true,
          staged: Boolean(body.staged),
          baseBranch: body.baseBranch,
        });

        if (!localInfo.diff.trim()) {
          sendJson(res, 200, {
            empty: true,
            message:
              'No tracked changes found in the local repository. Modify a tracked file or load a sample diff.',
          });
          return;
        }

        const { config: baseConfig } = loadConfig(workspaceDir);
        let effectiveConfig = structuredClone(baseConfig);
        if (body.yamlConfig) effectiveConfig = parseYamlConfig(body.yamlConfig);
        if (body.profile) effectiveConfig.profile = body.profile;
        if (body.provider) effectiveConfig.llm.provider = body.provider;
        if (body.model) effectiveConfig.llm.model = body.model;
        if (body.reviewer) effectiveConfig.reviewer = body.reviewer;
        if (body.staticAnalysis) {
          effectiveConfig = mergeConfig(effectiveConfig, {
            static_analysis: body.staticAnalysis,
          });
        }
        if (Array.isArray(body.customRules)) {
          effectiveConfig = mergeConfig(effectiveConfig, {
            custom_rules: body.customRules,
          });
        }

        const review = await runPullRequestReview({
          rawDiff: localInfo.diff,
          prTitle: `Local Review: ${localInfo.description} (${localInfo.branch})`,
          repository: localInfo.repoName,
          author: localInfo.author,
          headBranch: localInfo.branch,
          source: 'cli',
          config: effectiveConfig,
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
      // Custom Reviewer & Static Rules Endpoints (Schema v1)
      // ======================================================================
      if (pathname === '/api/rules' && req.method === 'GET') {
        const { config, configPath } = loadConfig(workspaceDir);
        const builtinCatalog = getAllBuiltinRulesCatalog();
        const customRules = config.static_analysis?.customRules || [];
        sendJson(res, 200, {
          schemaVersion: 'v1',
          reviewer: config.reviewer || 'hybrid',
          staticAnalysis: config.static_analysis,
          builtinCatalog,
          customRules,
          starterRules: STARTER_SAMPLE_CUSTOM_RULES_V1,
          configPath,
        });
        return;
      }

      if (pathname === '/api/rules' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const rule = (body && (body.schemaVersion || body.id)) ? body : (body.rule || body);
        const validation = validateCustomRuleV1(rule);
        if (!validation.valid) {
          sendJson(res, 400, {
            error: 'Custom rule validation failed against Schema v1.',
            errors: validation.errors,
          });
          return;
        }

        const { config } = loadConfig(workspaceDir);
        if (!config.static_analysis) {
          config.static_analysis = {
            enabled: true,
            builtinRules: { mode: 'all' },
            customRules: [],
          };
        }
        if (!config.static_analysis.customRules) {
          config.static_analysis.customRules = [];
        }

        const existingIdx = config.static_analysis.customRules.findIndex(
          (r: any) => r.id === rule.id
        );
        if (existingIdx >= 0) {
          config.static_analysis.customRules[existingIdx] = rule;
        } else {
          config.static_analysis.customRules.push(rule);
        }

        const targetPath = path.join(workspaceDir, '.openrabbit.yaml');
        fs.writeFileSync(targetPath, serializeConfigToYaml(config), 'utf8');

        sendJson(res, 200, {
          saved: true,
          rule,
          customRules: config.static_analysis.customRules,
        });
        return;
      }

      if (
        (pathname.startsWith('/api/rules/') &&
          pathname !== '/api/rules/test' &&
          pathname !== '/api/rules/config' &&
          pathname !== '/api/rules/export' &&
          pathname !== '/api/rules/import' &&
          req.method === 'DELETE') ||
        (pathname === '/api/rules' && req.method === 'DELETE')
      ) {
        let id = '';
        if (pathname.startsWith('/api/rules/')) {
          id = pathname.slice('/api/rules/'.length);
        } else {
          id = url.searchParams.get('id') || '';
          if (!id) {
            const rawBody = await readBody(req);
            id = JSON.parse(rawBody || '{}').id || '';
          }
        }

        if (!id) {
          sendJson(res, 400, { error: 'Rule ID is required to delete.' });
          return;
        }

        const { config } = loadConfig(workspaceDir);
        if (config.static_analysis?.customRules) {
          config.static_analysis.customRules = config.static_analysis.customRules.filter(
            (r: any) => r.id !== id
          );
          const targetPath = path.join(workspaceDir, '.openrabbit.yaml');
          fs.writeFileSync(targetPath, serializeConfigToYaml(config), 'utf8');
        }

        sendJson(res, 200, {
          removed: true,
          id,
          customRules: config.static_analysis?.customRules || [],
        });
        return;
      }

      if (pathname === '/api/rules/config' && req.method === 'PUT') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { config } = loadConfig(workspaceDir);

        if (body.reviewer) {
          config.reviewer = body.reviewer;
        }
        if (body.staticAnalysis) {
          config.static_analysis = {
            ...(config.static_analysis || {
              enabled: true,
              builtinRules: { mode: 'all' },
              customRules: [],
            }),
            ...body.staticAnalysis,
          };
        }

        const targetPath = path.join(workspaceDir, '.openrabbit.yaml');
        fs.writeFileSync(targetPath, serializeConfigToYaml(config), 'utf8');

        sendJson(res, 200, {
          saved: true,
          reviewer: config.reviewer,
          staticAnalysis: config.static_analysis,
        });
        return;
      }

      if (pathname === '/api/rules/test' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const rule = body.rule;
        const code = String(body.code || body.snippet || '');
        const filePath = String(body.filePath || 'sample.ts');

        try {
          const testResult = testCustomRule(rule, code, filePath);
          sendJson(res, 200, testResult);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === '/api/rules/export' && req.method === 'GET') {
        const { config } = loadConfig(workspaceDir);
        const customRules = config.static_analysis?.customRules || [];
        sendJson(res, 200, {
          schemaVersion: 'v1',
          name: 'OpenRabbit Custom Rules Export',
          description: 'Exported custom static analysis rules (Schema v1)',
          rules: customRules,
        });
        return;
      }

      if (pathname === '/api/rules/import' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const importedRules: any[] = Array.isArray(body.rules)
          ? body.rules
          : Array.isArray(body)
          ? body
          : [];

        if (importedRules.length === 0) {
          sendJson(res, 400, {
            error: "No rules provided. Expected an array of rules under 'rules' or root.",
          });
          return;
        }

        const validated: any[] = [];
        const invalid: any[] = [];
        for (const item of importedRules) {
          const val = validateCustomRuleV1(item);
          if (val.valid) {
            validated.push(item);
          } else {
            invalid.push({ id: item.id || 'unknown', errors: val.errors });
          }
        }

        if (validated.length === 0) {
          sendJson(res, 400, {
            error: 'None of the provided rules passed Schema v1 validation.',
            details: invalid,
          });
          return;
        }

        const { config } = loadConfig(workspaceDir);
        if (!config.static_analysis) {
          config.static_analysis = {
            enabled: true,
            builtinRules: { mode: 'all' },
            customRules: [],
          };
        }
        if (!config.static_analysis.customRules) {
          config.static_analysis.customRules = [];
        }

        // Merge imported rules
        const map = new Map<string, any>();
        for (const r of config.static_analysis.customRules) {
          map.set(r.id, r);
        }
        for (const r of validated) {
          map.set(r.id, r);
        }
        config.static_analysis.customRules = Array.from(map.values());

        const targetPath = path.join(workspaceDir, '.openrabbit.yaml');
        fs.writeFileSync(targetPath, serializeConfigToYaml(config), 'utf8');

        sendJson(res, 200, {
          importedCount: validated.length,
          invalidCount: invalid.length,
          invalidDetails: invalid,
          customRules: config.static_analysis.customRules,
        });
        return;
      }

      // ======================================================================
      // Filesystem Directory Browser (Folder Selector)
      // ======================================================================
      if (pathname === '/api/fs/browse' && req.method === 'GET') {
        const targetPath = url.searchParams.get('path') || undefined;
        try {
          const browseData = browseFilesystem(targetPath, workspaceDir);
          sendJson(res, 200, browseData);
        } catch (err) {
          sendJson(res, 500, { error: (err as Error).message });
        }
        return;
      }

      // ======================================================================
      // Local Repositories Management & Commit Exploration
      // ======================================================================
      if (pathname === '/api/repos' && req.method === 'GET') {
        const repositories = await store.listRepositories();
        sendJson(res, 200, { repositories });
        return;
      }

      if (pathname === '/api/repos/subrepos' && req.method === 'GET') {
        const targetIdOrPath =
          url.searchParams.get('id') ||
          url.searchParams.get('path') ||
          workspaceDir;
        try {
          const subreposData = await store.getSubrepos(targetIdOrPath);
          sendJson(res, 200, subreposData);
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === '/api/repos/subrepos/register' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const targetIdOrPath = body.rootId || body.rootPath || workspaceDir;
        const subrepoTargets = body.subrepoIds || body.subrepoPaths;

        try {
          const registered = await store.registerSubrepos(
            targetIdOrPath,
            subrepoTargets
          );
          sendJson(res, 200, { registered, count: registered.length });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === '/api/repos' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const repoPath = String(body.path || '').trim();
        if (!repoPath) {
          sendJson(res, 400, { error: 'Repository path is required.' });
          return;
        }

        try {
          const repo = await store.addRepository(repoPath, body.name);
          sendJson(res, 201, { repository: repo });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (
        (pathname.startsWith('/api/repos/') && req.method === 'DELETE') ||
        (pathname === '/api/repos' && req.method === 'DELETE')
      ) {
        let id = '';
        if (pathname.startsWith('/api/repos/')) {
          id = pathname.slice('/api/repos/'.length);
        } else {
          id = url.searchParams.get('id') || '';
          if (!id) {
            const rawBody = await readBody(req);
            id = JSON.parse(rawBody || '{}').id || '';
          }
        }

        if (!id) {
          sendJson(res, 400, { error: 'Repository ID or path is required.' });
          return;
        }

        const removed = await store.removeRepository(id);
        sendJson(res, 200, { removed, id });
        return;
      }

      if (pathname === '/api/repos/commits' && req.method === 'GET') {
        const targetIdOrPath =
          url.searchParams.get('id') ||
          url.searchParams.get('path') ||
          workspaceDir;
        const repo = await store.getRepository(targetIdOrPath);
        const repoDir = repo ? repo.path : path.resolve(targetIdOrPath);

        const validation = validateGitRepository(repoDir);
        if (!validation.valid || !validation.topLevel) {
          sendJson(res, 400, {
            error: validation.error || `Not a valid git repository: ${repoDir}`,
          });
          return;
        }

        const maxCount = Number(url.searchParams.get('maxCount') || 30);
        const branch = url.searchParams.get('branch') || undefined;
        const commits = getRepoCommits(validation.topLevel, { maxCount, branch });
        sendJson(res, 200, {
          repository: repo || getRepoMetadata(validation.topLevel),
          commits,
        });
        return;
      }

      if (pathname === '/api/repos/commit' && req.method === 'GET') {
        const targetIdOrPath =
          url.searchParams.get('id') ||
          url.searchParams.get('path') ||
          workspaceDir;
        const sha = url.searchParams.get('sha');
        if (!sha) {
          sendJson(res, 400, { error: 'sha parameter is required.' });
          return;
        }

        const repo = await store.getRepository(targetIdOrPath);
        const repoDir = repo ? repo.path : path.resolve(targetIdOrPath);

        try {
          const commitData = getCommitDiff(repoDir, sha);
          const parsedDiff = parseUnifiedDiff(commitData.diff);
          sendJson(res, 200, {
            commit: commitData.commit,
            diff: commitData.diff,
            parsedDiff,
          });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (pathname === '/api/repos/review' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const targetIdOrPath = body.id || body.path || workspaceDir;
        const repo = await store.getRepository(targetIdOrPath);
        const repoDir = repo ? repo.path : path.resolve(targetIdOrPath);

        const localInfo = getLocalGitDiff({
          cwd: repoDir,
          commitSha: body.commitSha,
          commitRange: body.commitRange,
          staged: Boolean(body.staged),
          baseBranch: body.baseBranch,
        });

        if (!localInfo.diff.trim()) {
          sendJson(res, 200, {
            empty: true,
            message:
              'No diff or changes detected for the specified commit/options in this repository.',
          });
          return;
        }

        const { config: baseConfig } = loadConfig(repoDir);
        let effectiveConfig = structuredClone(baseConfig);
        if (body.yamlConfig) effectiveConfig = parseYamlConfig(body.yamlConfig);
        if (body.profile) effectiveConfig.profile = body.profile;
        if (body.provider) effectiveConfig.llm.provider = body.provider;
        if (body.model) effectiveConfig.llm.model = body.model;
        if (body.reviewer) effectiveConfig.reviewer = body.reviewer;
        if (body.staticAnalysis) {
          effectiveConfig = mergeConfig(effectiveConfig, {
            static_analysis: body.staticAnalysis,
          });
        }
        if (Array.isArray(body.customRules)) {
          effectiveConfig = mergeConfig(effectiveConfig, {
            custom_rules: body.customRules,
          });
        }

        const prTitle = body.commitSha
          ? `Commit Review: ${localInfo.description} (${repo?.name || localInfo.repoName})`
          : `Local Review: ${localInfo.description} (${localInfo.branch})`;

        const review = await runPullRequestReview({
          rawDiff: localInfo.diff,
          prTitle,
          repository: repo?.name || localInfo.repoName,
          author: localInfo.author,
          headBranch: localInfo.branch,
          commitSha: localInfo.commitSha,
          source: 'cli',
          config: effectiveConfig,
        });

        await store.addReview(review);
        const parsedDiff = parseUnifiedDiff(localInfo.diff);
        const analytics = await store.getAnalyticsSummary();

        sendJson(res, 200, { review, parsedDiff, analytics, localInfo });
        return;
      }

      if (pathname === '/api/repos/security-scan' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const target = body.id || body.path || workspaceDir;
        const repo = await store.getRepository(target);
        const repoDir = repo ? repo.path : path.resolve(target);
        const { config } = loadConfig(repoDir);
        if (config.static_analysis?.enabled === false) throw new Error('Enable static analysis to run a repository security scan.');
        config.profile = 'security-focused';
        config.reviewer = 'static-only';
        const scan = buildRepositorySecurityDiff(repoDir, config.reviews.path_filters);
        const review = await runPullRequestReview({
          rawDiff: scan.diff, prTitle: 'Repository security scan',
          repository: repo?.name || path.basename(repoDir), source: 'playground', config,
          securityScanScope: { skippedFiles: scan.skippedFiles },
        });
        await store.addReview(review);
        sendJson(res, 200, { review, parsedDiff: parseUnifiedDiff(scan.diff), scan: { scannedFiles: scan.scannedFiles, skippedFiles: scan.skippedFiles } });
        return;
      }

      // ======================================================================
      // On-Demand Integrations Review Endpoints (GitHub, GitLab, Bitbucket)
      // ======================================================================
      if (
        pathname === '/api/integrations/github/review' &&
        req.method === 'POST'
      ) {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { owner, repo, pullNumber, commitSha, token, postComment } = body;
        if (!owner || !repo) {
          sendJson(res, 400, { error: 'owner and repo are required.' });
          return;
        }

        try {
          const review = await runGitHubOnDemandReview({
            owner,
            repo,
            pullNumber: pullNumber ? Number(pullNumber) : undefined,
            commitSha,
            token,
            postComment: Boolean(postComment),
          });
          await store.addReview(review);
          const parsedDiff = parseUnifiedDiff(review.rawDiff || '');
          const analytics = await store.getAnalyticsSummary();
          sendJson(res, 200, { review, parsedDiff, analytics });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (
        pathname === '/api/integrations/gitlab/review' &&
        req.method === 'POST'
      ) {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { projectId, mrIid, commitSha, token } = body;
        if (!projectId) {
          sendJson(res, 400, { error: 'projectId is required.' });
          return;
        }

        try {
          const review = await runGitLabOnDemandReview({
            projectId,
            mrIid: mrIid ? Number(mrIid) : undefined,
            commitSha,
            token,
          });
          await store.addReview(review);
          const parsedDiff = parseUnifiedDiff(review.rawDiff || '');
          const analytics = await store.getAnalyticsSummary();
          sendJson(res, 200, { review, parsedDiff, analytics });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (
        pathname === '/api/integrations/bitbucket/review' &&
        req.method === 'POST'
      ) {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { workspace, repoSlug, pullRequestId, commitSha, token } = body;
        if (!workspace || !repoSlug) {
          sendJson(res, 400, {
            error: 'workspace and repoSlug are required.',
          });
          return;
        }

        try {
          const review = await runBitbucketOnDemandReview({
            workspace,
            repoSlug,
            pullRequestId: pullRequestId ? Number(pullRequestId) : undefined,
            commitSha,
            token,
          });
          await store.addReview(review);
          const parsedDiff = parseUnifiedDiff(review.rawDiff || '');
          const analytics = await store.getAnalyticsSummary();
          sendJson(res, 200, { review, parsedDiff, analytics });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (
        pathname === '/api/integrations/forgejo/review' &&
        req.method === 'POST'
      ) {
        const rawBody = await readBody(req);
        const body = JSON.parse(rawBody || '{}');
        const { owner, repo, pullNumber, commitSha, token, postComment } = body;
        if (!owner || !repo) {
          sendJson(res, 400, { error: 'owner and repo are required.' });
          return;
        }

        try {
          const review = await runForgejoOnDemandReview({
            owner,
            repo,
            pullNumber: pullNumber ? Number(pullNumber) : undefined,
            commitSha,
            token,
            postComment: Boolean(postComment),
          });
          await store.addReview(review);
          const parsedDiff = parseUnifiedDiff(review.rawDiff || '');
          const analytics = await store.getAnalyticsSummary();
          sendJson(res, 200, { review, parsedDiff, analytics });
        } catch (err) {
          sendJson(res, 400, { error: (err as Error).message });
        }
        return;
      }

      // ======================================================================
      // Async Review Job Queue Endpoints
      // ======================================================================
      if (pathname === '/api/jobs' && req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || '50');
        sendJson(res, 200, { jobs: jobQueue.listJobs(Number.isFinite(limit) ? limit : 50) });
        return;
      }

      if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
        const jobId = decodeURIComponent(pathname.slice('/api/jobs/'.length));
        const job = jobQueue.getJob(jobId);
        if (!job) {
          sendJson(res, 404, { error: 'Job not found' });
          return;
        }
        sendJson(res, 200, { job });
        return;
      }

      // ======================================================================
      // Webhook Endpoints (GitHub, GitLab, Bitbucket)
      // ======================================================================
      const isAsyncWebhook =
        url.searchParams.get('async') === 'true' ||
        req.headers['x-openrabbit-async'] === 'true' ||
        process.env.OPENRABBIT_ASYNC_WEBHOOKS === 'true';

      const dispatchWebhook = async (
        provider: 'github' | 'gitlab' | 'bitbucket' | 'forgejo',
        eventName: string,
        payload: any,
        dedupKey: string
      ) => {
        if (isAsyncWebhook) {
          const { job, deduplicated } = jobQueue.enqueue(dedupKey, {
            provider,
            eventName,
            payload,
          });
          sendJson(res, 202, {
            accepted: true,
            jobId: job.id,
            status: job.status,
            deduplicated,
          });
          return;
        }
        const result = await executeWebhook({ provider, eventName, payload });
        sendJson(res, 200, result);
      };

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
        const deliveryId = req.headers['x-github-delivery'] as string | undefined;
        const dedupKey = deliveryId
          ? `github:delivery:${deliveryId}`
          : `github:${payload.repository?.full_name || 'unknown'}:${
              payload.pull_request?.number || payload.issue?.number || payload.number || 0
            }:${payload.pull_request?.head?.sha || payload.comment?.id || eventName}`;
        await dispatchWebhook('github', eventName, payload, dedupKey);
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
        const deliveryId = req.headers['x-gitlab-event-uuid'] as string | undefined;
        const dedupKey = deliveryId
          ? `gitlab:delivery:${deliveryId}`
          : `gitlab:${payload.project?.path_with_namespace || 'unknown'}:${
              payload.object_attributes?.iid || payload.merge_request?.iid || 0
            }:${payload.object_attributes?.last_commit?.id || payload.object_attributes?.noteable_id || eventHeader}`;
        await dispatchWebhook('gitlab', eventHeader, payload, dedupKey);
        return;
      }

      if (pathname === '/api/webhooks/bitbucket' && req.method === 'POST') {
        const rawBody = await readBody(req);
        const sigHeader = (req.headers['x-hub-signature'] ||
          req.headers['x-hub-signature-256']) as string | undefined;
        const eventKey =
          (req.headers['x-event-key'] as string) || 'pullrequest:created';

        if (
          !verifyBitbucketWebhook(
            rawBody,
            sigHeader,
            process.env.BITBUCKET_WEBHOOK_SECRET
          )
        ) {
          sendJson(res, 401, { error: 'Invalid Bitbucket webhook signature' });
          return;
        }

        const payload = JSON.parse(rawBody || '{}');
        const deliveryId =
          (req.headers['x-request-uuid'] as string | undefined) ||
          (req.headers['x-hook-uuid'] as string | undefined);
        const dedupKey = deliveryId
          ? `bitbucket:delivery:${deliveryId}:${payload.comment?.id || payload.pullrequest?.id || 0}`
          : `bitbucket:${payload.repository?.full_name || 'unknown'}:${payload.pullrequest?.id || 0}:${payload.pullrequest?.source?.commit?.hash || payload.comment?.id || eventKey}`;
        await dispatchWebhook('bitbucket', eventKey, payload, dedupKey);
        return;
      }

      if (
        (pathname === '/api/webhooks/forgejo' ||
          pathname === '/api/webhooks/codeberg') &&
        req.method === 'POST'
      ) {
        const rawBody = await readBody(req);
        const signature = (req.headers['x-gitea-signature'] ||
          req.headers['x-hub-signature-256']) as string | undefined;
        const eventName =
          (req.headers['x-gitea-event'] as string) ||
          (req.headers['x-github-event'] as string) ||
          'pull_request';

        if (
          !verifyForgejoWebhookSignature(
            rawBody,
            signature,
            process.env.FORGEJO_WEBHOOK_SECRET
          )
        ) {
          sendJson(res, 401, { error: 'Invalid Codeberg webhook signature' });
          return;
        }

        const payload = JSON.parse(rawBody || '{}');
        const deliveryId = req.headers['x-gitea-delivery'] as string | undefined;
        const dedupKey = deliveryId
          ? `forgejo:delivery:${deliveryId}`
          : `forgejo:${payload.repository?.full_name || 'unknown'}:${
              payload.pull_request?.number || payload.issue?.number || payload.number || 0
            }:${payload.pull_request?.head?.sha || payload.comment?.id || eventName}`;
        await dispatchWebhook('forgejo', eventName, payload, dedupKey);
        return;
      }

      // ======================================================================
      // Local frontend vendor assets (no third-party CDN dependency)
      // ======================================================================
      if (pathname === '/vendor/mermaid.min.js' && req.method === 'GET') {
        const mermaidFile = path.resolve(
          __dirname,
          '../../node_modules/mermaid/dist/mermaid.min.js'
        );
        if (fs.existsSync(mermaidFile)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
          });
          fs.createReadStream(mermaidFile).pipe(res);
          return;
        }
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
      if (err instanceof RequestError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
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
    server.listen(
      requestedPort,
      options.host || process.env.HOST || '127.0.0.1',
      () => {
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
