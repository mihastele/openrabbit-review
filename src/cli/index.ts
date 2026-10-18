#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  loadConfig,
  serializeConfigToYaml,
} from '../config/config-loader.js';
import { handlePRChat } from '../core/chat-engine.js';
import { getLocalGitDiff } from '../core/git-utils.js';
import { getProvidersStatus } from '../core/llm-provider.js';
import { renderEffortBar } from '../core/markdown-formatter.js';
import { runPullRequestReview } from '../core/review-engine.js';
import {
  postGitHubInlineReview,
  upsertGitHubWalkthroughComment,
} from '../integrations/github.js';
import { createOpenRabbitServer } from '../server/app.js';
import {
  ReviewStore,
  SAMPLE_DIFF_TEMPLATES,
} from '../storage/review-store.js';
import type {
  LLMProviderType,
  ReviewProfile,
  ReviewResult,
} from '../types/index.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  orange: '\x1b[38;5;208m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

function printBanner(): void {
  console.log(
    `${ANSI.orange}${ANSI.bold}
   (\\(\\     OpenRabbit v1.0.0
   ( -.-)   ${ANSI.reset}${ANSI.cyan}Open-Source AI Pull Request Reviewer & Interactive PR Companion${ANSI.reset}${ANSI.orange}${ANSI.bold}
   o_(")(") ${ANSI.reset}${ANSI.dim}Walkthroughs · Committable Suggestions · @openrabbit Chat · Multi-LLM BYOK${ANSI.reset}\n`
  );
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

export function renderTerminalReview(result: ReviewResult): string {
  const lines: string[] = [];
  const w = result.walkthrough;

  lines.push(
    `${ANSI.bold}${ANSI.orange}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${ANSI.reset}`
  );
  lines.push(
    `${ANSI.bold}🐇 OPENRABBIT PR WALKTHROUGH:${ANSI.reset} ${ANSI.bold}${result.prTitle}${ANSI.reset}`
  );
  lines.push(
    `${ANSI.dim}Repo: ${result.repository} · Engine: ${result.providerUsed}/${result.modelUsed} · Time: ${result.durationMs}ms${ANSI.reset}`
  );
  lines.push(
    `${ANSI.bold}${ANSI.orange}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${ANSI.reset}`
  );
  lines.push('');
  lines.push(`${ANSI.bold}📋 Executive Summary${ANSI.reset}`);
  lines.push(`   ${w.executiveSummary.replace(/\*\*/g, '')}`);
  lines.push('');
  lines.push(
    `   ${ANSI.bold}Effort:${ANSI.reset} ${renderEffortBar(w.effortScore)} (~${
      w.estimatedMinutes
    } min)   ${ANSI.bold}Risk:${ANSI.reset} ${
      w.riskLevel === 'critical'
        ? `${ANSI.red}${ANSI.bold}CRITICAL${ANSI.reset}`
        : w.riskLevel === 'high'
        ? `${ANSI.yellow}${ANSI.bold}HIGH${ANSI.reset}`
        : w.riskLevel === 'moderate'
        ? `${ANSI.yellow}MODERATE${ANSI.reset}`
        : `${ANSI.green}LOW${ANSI.reset}`
    }   ${ANSI.bold}Changes:${ANSI.reset} ${ANSI.green}+${
      result.stats.additions
    }${ANSI.reset}/${ANSI.red}-${result.stats.deletions}${ANSI.reset} (${
      result.stats.filesReviewed
    } files)`
  );
  lines.push('');

  if (w.fileSummaries.length > 0) {
    lines.push(`${ANSI.bold}🧭 File Changes Walkthrough${ANSI.reset}`);
    for (const f of w.fileSummaries) {
      const badge =
        f.impact === 'high'
          ? `${ANSI.red}[HIGH]${ANSI.reset}`
          : f.impact === 'medium'
          ? `${ANSI.yellow}[MED] ${ANSI.reset}`
          : `${ANSI.green}[LOW] ${ANSI.reset}`;
      lines.push(
        `   ${badge} ${ANSI.cyan}${f.path}${ANSI.reset} (${ANSI.green}+${f.additions}${ANSI.reset}/${ANSI.red}-${f.deletions}${ANSI.reset}) — ${f.summary}`
      );
    }
    lines.push('');
  }

  lines.push(
    `${ANSI.bold}🔎 Inline Code Review Findings (${result.findings.length})${ANSI.reset}`
  );
  lines.push('');

  for (const finding of result.findings) {
    const sevBadge =
      finding.severity === 'critical'
        ? `${ANSI.red}${ANSI.bold}🛑 CRITICAL${ANSI.reset}`
        : finding.severity === 'warning'
        ? `${ANSI.yellow}${ANSI.bold}⚠️  WARNING${ANSI.reset}`
        : finding.severity === 'suggestion'
        ? `${ANSI.cyan}${ANSI.bold}💡 SUGGESTION${ANSI.reset}`
        : finding.severity === 'praise'
        ? `${ANSI.green}${ANSI.bold}🙌 PRAISE${ANSI.reset}`
        : `${ANSI.gray}🧹 NITPICK${ANSI.reset}`;

    lines.push(
      `  ┌─ ${sevBadge} ${ANSI.magenta}[${finding.category}]${ANSI.reset} ${ANSI.bold}${finding.title}${ANSI.reset}`
    );
    lines.push(
      `  │  ${ANSI.cyan}${finding.file}:${finding.startLine}${ANSI.reset}`
    );
    lines.push(`  │  ${finding.body.replace(/\*\*/g, '')}`);

    if (finding.originalCode) {
      lines.push(`  │  ${ANSI.red}- ${finding.originalCode.trim()}${ANSI.reset}`);
    }
    if (finding.suggestionCode) {
      for (const sLine of finding.suggestionCode.split('\n')) {
        lines.push(`  │  ${ANSI.green}+ ${sLine.trim()}${ANSI.reset}`);
      }
    }
    lines.push(`  └──────────────────────────────────────────────────────────────`);
  }

  if (w.poem) {
    lines.push('');
    lines.push(`${ANSI.bold}🥕 Rabbit Poem${ANSI.reset}`);
    for (const pLine of w.poem.split('\n')) {
      lines.push(`   ${ANSI.italic}${ANSI.orange}❝ ${pLine}${ANSI.reset}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const flags = parseFlags(argv);

  if (command === 'serve' || command === 'dashboard') {
    printBanner();
    const requestedPort = flags.port
      ? Number(flags.port)
      : Number(process.env.PORT || 3847);
    const instance = await createOpenRabbitServer({ port: requestedPort });
    console.log(
      `${ANSI.green}${ANSI.bold}✔ OpenRabbit Server & Interactive Dashboard running at:${ANSI.reset} ${ANSI.cyan}${ANSI.bold}http://localhost:${instance.port}${ANSI.reset}`
    );
    console.log(
      `${ANSI.dim}  ├─ Web Dashboard & PR Playground : http://localhost:${instance.port}${ANSI.reset}`
    );
    console.log(
      `${ANSI.dim}  ├─ GitHub Webhook Endpoint       : http://localhost:${instance.port}/api/webhooks/github${ANSI.reset}`
    );
    console.log(
      `${ANSI.dim}  └─ GitLab Webhook Endpoint       : http://localhost:${instance.port}/api/webhooks/gitlab${ANSI.reset}\n`
    );
    return;
  }

  if (command === 'init') {
    printBanner();
    const targetYaml = path.join(process.cwd(), '.openrabbit.yaml');
    if (fs.existsSync(targetYaml) && !flags.force) {
      console.log(
        `${ANSI.yellow}ℹ️  .openrabbit.yaml already exists at ${targetYaml} (use --force to overwrite).${ANSI.reset}`
      );
      return;
    }
    fs.writeFileSync(
      targetYaml,
      serializeConfigToYaml(DEFAULT_OPENRABBIT_CONFIG),
      'utf8'
    );
    console.log(
      `${ANSI.green}${ANSI.bold}✔ Created .openrabbit.yaml${ANSI.reset} at ${ANSI.cyan}${targetYaml}${ANSI.reset}`
    );
    console.log(
      `  Customize ${ANSI.bold}profile${ANSI.reset} (chill | assertive | security-focused), ${ANSI.bold}path_instructions${ANSI.reset}, and ${ANSI.bold}llm.provider${ANSI.reset}.`
    );
    return;
  }

  if (command === 'review') {
    const format = String(flags.format || 'terminal');
    if (format === 'terminal') printBanner();

    const { config } = loadConfig(process.cwd());
    if (typeof flags.profile === 'string') {
      config.profile = flags.profile as ReviewProfile;
    }
    if (typeof flags.provider === 'string') {
      config.llm.provider = flags.provider as LLMProviderType;
    }
    if (typeof flags.model === 'string') {
      config.llm.model = flags.model;
    }

    let rawDiff = '';
    let prTitle = String(flags.title || 'Local Pull Request Review');
    let repository = String(flags.repo || 'local/openrabbit');

    if (flags.file && typeof flags.file === 'string') {
      rawDiff = fs.readFileSync(path.resolve(flags.file), 'utf8');
      prTitle = `Patch Review: ${path.basename(flags.file)}`;
    } else if (flags.demo) {
      const tplId =
        typeof flags.demo === 'string' ? flags.demo : SAMPLE_DIFF_TEMPLATES[0].id;
      const tpl =
        SAMPLE_DIFF_TEMPLATES.find((t) => t.id === tplId) ||
        SAMPLE_DIFF_TEMPLATES[0];
      rawDiff = tpl.diff;
      prTitle = tpl.prTitle;
      repository = tpl.repository;
    } else {
      const localGit = getLocalGitDiff({
        staged: Boolean(flags.staged),
        baseBranch: typeof flags.base === 'string' ? flags.base : undefined,
      });
      if (localGit.diff.trim()) {
        rawDiff = localGit.diff;
        prTitle = `Local Review: ${localGit.description}`;
        repository = localGit.repoName;
      } else {
        // Fallback to demo template 1 if repo has no uncommitted changes yet
        const tpl = SAMPLE_DIFF_TEMPLATES[0];
        rawDiff = tpl.diff;
        prTitle = `${tpl.prTitle} (Demo PR — no local uncommitted changes detected)`;
        repository = tpl.repository;
      }
    }

    const result = await runPullRequestReview({
      rawDiff,
      prTitle,
      repository,
      prNumber: flags.pr ? Number(flags.pr) : undefined,
      source: 'cli',
      config,
    });

    const store = new ReviewStore();
    await store.addReview(result);

    // Optional: post directly to a live GitHub PR if --post-github owner/repo#123 is passed
    if (typeof flags['post-github'] === 'string' && process.env.GITHUB_TOKEN) {
      const match = flags['post-github'].match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (match) {
        const [, owner, repo, prNumStr] = match;
        const prNum = Number(prNumStr);
        await upsertGitHubWalkthroughComment(
          owner,
          repo,
          prNum,
          result.markdownWalkthrough,
          process.env.GITHUB_TOKEN
        );
        if (result.findings.length > 0 && result.commitSha) {
          await postGitHubInlineReview(
            owner,
            repo,
            prNum,
            result.commitSha,
            result.findings,
            process.env.GITHUB_TOKEN
          );
        }
        console.log(
          `${ANSI.green}✔ Posted walkthrough & inline comments to GitHub PR ${flags['post-github']}${ANSI.reset}`
        );
      }
    }

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else if (format === 'markdown') {
      console.log(result.markdownWalkthrough);
    } else {
      console.log(renderTerminalReview(result));
    }
    return;
  }

  if (command === 'chat') {
    printBanner();
    const query =
      argv
        .slice(1)
        .filter((a) => !a.startsWith('--'))
        .join(' ') || '@openrabbit explain';
    const { config } = loadConfig(process.cwd());
    const localGit = getLocalGitDiff();
    const diff = localGit.diff.trim() || SAMPLE_DIFF_TEMPLATES[0].diff;

    const res = await handlePRChat({ query, diff }, config);
    console.log(
      `${ANSI.bold}${ANSI.cyan}🤖 @openrabbit (${res.commandDetected} · ${res.providerUsed}/${res.modelUsed}):${ANSI.reset}\n`
    );
    console.log(res.replyMarkdown);
    return;
  }

  if (command === 'providers') {
    printBanner();
    console.log(`${ANSI.bold}Configured LLM Providers (BYOK):${ANSI.reset}\n`);
    for (const p of getProvidersStatus()) {
      const status = p.configured
        ? `${ANSI.green}● Ready${ANSI.reset}`
        : `${ANSI.gray}○ Missing API Key${ANSI.reset}`;
      console.log(
        `  ${status}  ${ANSI.bold}${p.name}${ANSI.reset} (${ANSI.cyan}${p.id}${ANSI.reset}, default: \`${p.defaultModel}\`)`
      );
      console.log(`           ${ANSI.dim}${p.description}${ANSI.reset}`);
    }
    console.log('');
    return;
  }

  // Help output
  printBanner();
  console.log(`${ANSI.bold}Usage:${ANSI.reset}
  ${ANSI.cyan}openrabbit review${ANSI.reset} [options]       Run AI PR walkthrough & line-by-line review
    ${ANSI.dim}--staged${ANSI.reset}                        Review staged git changes
    ${ANSI.dim}--base <branch>${ANSI.reset}                 Review branch diff against base (e.g. main)
    ${ANSI.dim}--file <patch>${ANSI.reset}                  Review a specific .diff / .patch file
    ${ANSI.dim}--demo [id]${ANSI.reset}                     Run against a sample PR diff (auth-jwt-sqli | react-billing-hook | clean-stream-worker)
    ${ANSI.dim}--profile <mode>${ANSI.reset}                Override profile (chill | assertive | security-focused)
    ${ANSI.dim}--provider <llm>${ANSI.reset}                Override LLM (auto | openai | anthropic | gemini | ollama | heuristic)
    ${ANSI.dim}--format <fmt>${ANSI.reset}                  Output format (terminal | markdown | json)

  ${ANSI.cyan}openrabbit chat "<query>"${ANSI.reset}          Ask @openrabbit to explain, write unit tests, or fix code
  ${ANSI.cyan}openrabbit serve${ANSI.reset} [--port 3847]    Start Webhook Bot Server & Interactive Web Dashboard
  ${ANSI.cyan}openrabbit init${ANSI.reset}                   Generate a .openrabbit.yaml config file in current repo
  ${ANSI.cyan}openrabbit providers${ANSI.reset}              List supported BYOK LLM providers and readiness status
`);
}

// Run CLI when invoked directly
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('cli/index.ts') ||
    process.argv[1].endsWith('cli\\index.ts') ||
    process.argv[1].endsWith('cli/index.js') ||
    process.argv[1].endsWith('cli\\index.js'));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(`${ANSI.red}Error:${ANSI.reset}`, err);
    process.exit(1);
  });
}
