#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  loadConfig,
  serializeConfigToYaml,
} from '../config/config-loader.js';
import { handlePRChat } from '../core/chat-engine.js';
import {
  getCommitDiff,
  getCommitRangeDiff,
  getLocalGitDiff,
  getRepoCommits,
  getRepoMetadata,
  validateGitRepository,
} from '../core/git-utils.js';
import { getProvidersStatus } from '../core/llm-provider.js';
import { renderEffortBar } from '../core/markdown-formatter.js';
import { runPullRequestReview } from '../core/review-engine.js';
import {
  getAllBuiltinRulesCatalog,
  loadRulesFromFile,
  testCustomRule,
} from '../core/custom-rules/index.js';
import { runBitbucketOnDemandReview } from '../integrations/bitbucket.js';
import {
  postGitHubInlineReview,
  runGitHubOnDemandReview,
  upsertGitHubWalkthroughComment,
} from '../integrations/github.js';
import { runGitLabOnDemandReview } from '../integrations/gitlab.js';
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

  if (command === 'repo') {
    printBanner();
    const sub = argv[1] || 'list';
    const store = new ReviewStore();
    await store.init();

    if (sub === 'list') {
      const repos = await store.listRepositories();
      console.log(
        `${ANSI.bold}Registered Local Repositories (${repos.length}):${ANSI.reset}\n`
      );
      if (repos.length === 0) {
        console.log(
          `  ${ANSI.dim}No repositories registered yet. Use: openrabbit repo add <path>${ANSI.reset}\n`
        );
      } else {
        for (const r of repos) {
          const cleanBadge = r.isClean
            ? `${ANSI.green}✔ Clean${ANSI.reset}`
            : `${ANSI.yellow}● Uncommitted Changes${ANSI.reset}`;
          console.log(
            `  📁 ${ANSI.bold}${ANSI.cyan}${r.name}${ANSI.reset}  ${ANSI.dim}[${r.branch}]${ANSI.reset}  ${cleanBadge}`
          );
          console.log(`     Path: ${ANSI.dim}${r.path}${ANSI.reset}`);
          if (r.lastCommitMessage) {
            console.log(
              `     Head: ${ANSI.italic}${r.lastCommitMessage}${ANSI.reset} (${r.lastCommitDate ? new Date(r.lastCommitDate).toLocaleDateString() : ''})`
            );
          }
          console.log('');
        }
      }
      return;
    }

    if (sub === 'add') {
      const targetPath = argv[2] || process.cwd();
      try {
        const added = await store.addRepository(
          targetPath,
          flags.name as string | undefined
        );
        console.log(
          `${ANSI.green}${ANSI.bold}✔ Added local repository:${ANSI.reset} ${ANSI.bold}${added.name}${ANSI.reset}`
        );
        console.log(`  Path:   ${ANSI.cyan}${added.path}${ANSI.reset}`);
        console.log(
          `  Branch: ${added.branch} (${added.isClean ? 'clean' : 'modified changes'})`
        );
        if (added.lastCommitMessage) {
          console.log(`  Head:   ${added.lastCommitMessage}`);
        }
        console.log(
          `\n  ${ANSI.dim}Review changes:${ANSI.reset} ${ANSI.cyan}openrabbit review --repo-path "${added.path}"${ANSI.reset}`
        );
        console.log(
          `  ${ANSI.dim}View commits:${ANSI.reset}   ${ANSI.cyan}openrabbit repo commits "${added.path}"${ANSI.reset}\n`
        );
      } catch (err) {
        console.error(
          `${ANSI.red}Failed to add repository:${ANSI.reset}`,
          (err as Error).message
        );
      }
      return;
    }

    if (sub === 'remove' || sub === 'rm') {
      const target = argv[2];
      if (!target) {
        console.error(
          `${ANSI.red}Please specify repository path, name, or ID to remove.${ANSI.reset}`
        );
        return;
      }
      const removed = await store.removeRepository(target);
      if (removed) {
        console.log(`${ANSI.green}✔ Removed repository:${ANSI.reset} ${target}`);
      } else {
        console.log(`${ANSI.yellow}Repository not found:${ANSI.reset} ${target}`);
      }
      return;
    }

    if (sub === 'commits' || sub === 'log') {
      const target = argv[2] || process.cwd();
      const repo = await store.getRepository(target);
      const repoPath = repo ? repo.path : path.resolve(target);
      const max = Number(flags.max || flags.limit || 15);

      try {
        const commits = getRepoCommits(repoPath, { maxCount: max });
        const repoName = repo ? repo.name : path.basename(repoPath);
        console.log(
          `${ANSI.bold}Recent Commits for ${ANSI.cyan}${repoName}${ANSI.reset} (${commits.length} shown):\n`
        );
        for (const c of commits) {
          console.log(
            `  ${ANSI.yellow}${c.shortSha}${ANSI.reset} ${ANSI.bold}${c.subject}${ANSI.reset}`
          );
          console.log(
            `    ${ANSI.dim}by ${c.author} · ${c.relativeDate} (${ANSI.green}+${c.additions || 0}${ANSI.reset}/${ANSI.red}-${c.deletions || 0}${ANSI.reset})${ANSI.reset}`
          );
        }
        console.log(
          `\n  ${ANSI.dim}Review a commit:${ANSI.reset} ${ANSI.cyan}openrabbit review --repo-path "${repoPath}" --commit <sha>${ANSI.reset}\n`
        );
      } catch (err) {
        console.error(
          `${ANSI.red}Failed to list commits:${ANSI.reset}`,
          (err as Error).message
        );
      }
      return;
    }
  }

  // ========================================================================
  // Rules Management Subcommand (Built-in + Custom Schema v1)
  // ========================================================================
  if (command === 'rules') {
    const sub = argv[1] || 'list';
    if (sub === 'list') {
      const builtin = getAllBuiltinRulesCatalog();
      const { config } = loadConfig(process.cwd());
      const custom = config.static_analysis?.customRules || [];

      console.log(
        `${ANSI.orange}${ANSI.bold}🐇 OpenRabbit Static Rules Catalog (Built-in + Custom Schema v1)${ANSI.reset}\n`
      );
      console.log(
        `${ANSI.bold}${ANSI.cyan}📦 Built-in Static Analysis Rules (${builtin.length}):${ANSI.reset}`
      );
      for (const b of builtin) {
        const sevColor =
          b.severity === 'critical'
            ? ANSI.red
            : b.severity === 'warning'
            ? ANSI.yellow
            : ANSI.cyan;
        console.log(
          `  ${ANSI.bold}${b.id}${ANSI.reset} [${sevColor}${b.severity.toUpperCase()}${ANSI.reset}] (${b.category}) · Lang: ${b.languages.join(', ')}`
        );
        console.log(`    ${ANSI.dim}${b.title}${ANSI.reset}`);
      }

      console.log(
        `\n${ANSI.bold}${ANSI.green}🛠️ Custom Rules (${custom.length}) [Schema v1]:${ANSI.reset}`
      );
      if (custom.length === 0) {
        console.log(
          `  ${ANSI.dim}No custom rules configured yet. Create one via Web GUI or add to .openrabbit-rules.json${ANSI.reset}\n`
        );
      } else {
        for (const c of custom) {
          const sevColor =
            c.severity === 'critical'
              ? ANSI.red
              : c.severity === 'warning'
              ? ANSI.yellow
              : ANSI.cyan;
          console.log(
            `  ${ANSI.bold}${c.id}${ANSI.reset} [${sevColor}${c.severity.toUpperCase()}${ANSI.reset}] (${c.category}) · Lang: ${c.languages.join(', ')}`
          );
          console.log(`    ${ANSI.dim}${c.title}${ANSI.reset}`);
          console.log(`    ${ANSI.gray}Pattern: ${c.rule.pattern}${ANSI.reset}`);
        }
        console.log('');
      }
      return;
    }

    if (sub === 'test') {
      const ruleId = typeof flags.rule === 'string' ? flags.rule : '';
      const snippet =
        typeof flags.snippet === 'string'
          ? flags.snippet
          : typeof flags.code === 'string'
          ? flags.code
          : '';
      if (!snippet) {
        console.error(
          `${ANSI.red}Please provide code snippet using --snippet "<code to test>"${ANSI.reset}`
        );
        return;
      }
      const { config } = loadConfig(process.cwd());
      const customRules = config.static_analysis?.customRules || [];
      const targetRule = customRules.find((r) => r.id === ruleId) || customRules[0];
      if (!targetRule) {
        console.error(
          `${ANSI.red}Rule '${ruleId || '(first rule)'}' not found in custom rules.${ANSI.reset}`
        );
        return;
      }

      try {
        const result = testCustomRule(targetRule, snippet);
        console.log(
          `\n${ANSI.bold}Test Result for ${ANSI.cyan}${targetRule.id}${ANSI.reset}: ${
            result.matched
              ? `${ANSI.green}${ANSI.bold}MATCHED (${result.matchesCount})${ANSI.reset}`
              : `${ANSI.yellow}NO MATCH${ANSI.reset}`
          }\n`
        );
        if (result.matched) {
          for (const m of result.matches) {
            console.log(`  Line ${m.lineNumber}: ${m.lineContent}`);
            if (m.suggestionCode) {
              console.log(
                `  ${ANSI.green}Suggestion:${ANSI.reset} ${m.suggestionCode}`
              );
            }
          }
          console.log('');
        }
      } catch (err) {
        console.error(`${ANSI.red}Rule test error:${ANSI.reset}`, (err as Error).message);
      }
      return;
    }
  }

  if (command === 'review') {
    const format = String(flags.format || 'terminal');
    if (format === 'terminal') printBanner();

    const store = new ReviewStore();
    await store.init();

    // Determine target local repo path
    let targetRepoPath = process.cwd();
    if (flags['repo-path'] && typeof flags['repo-path'] === 'string') {
      const found = await store.getRepository(flags['repo-path']);
      targetRepoPath = found ? found.path : path.resolve(flags['repo-path']);
    }

    const { config } = loadConfig(targetRepoPath);
    if (typeof flags.profile === 'string') {
      config.profile = flags.profile as ReviewProfile;
    }
    if (typeof flags.provider === 'string') {
      config.llm.provider = flags.provider as LLMProviderType;
    }
    if (typeof flags.model === 'string') {
      config.llm.model = flags.model;
    }
    if (typeof flags.reviewer === 'string') {
      config.reviewer = flags.reviewer as any;
    }
    if (typeof flags['static-mode'] === 'string') {
      if (!config.static_analysis) {
        config.static_analysis = {
          enabled: true,
          builtinRules: { mode: 'all' },
          customRules: [],
        };
      }
      config.static_analysis.builtinRules.mode = flags['static-mode'] as any;
    }
    if (typeof flags.rules === 'string') {
      const loaded = loadRulesFromFile(path.resolve(flags.rules));
      if (loaded.rules.length > 0) {
        if (!config.static_analysis) {
          config.static_analysis = {
            enabled: true,
            builtinRules: { mode: 'all' },
            customRules: [],
          };
        }
        config.static_analysis.customRules = [
          ...(config.static_analysis.customRules || []),
          ...loaded.rules,
        ];
      }
    }

    // 1. Live GitHub on-demand review
    const ghInput = flags.github || flags['github-url'];
    if (typeof ghInput === 'string') {
      let owner = '';
      let repo = '';
      let prNumber: number | undefined = undefined;
      let commitSha: string | undefined = undefined;

      const prUrlMatch = ghInput.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      const commitUrlMatch = ghInput.match(/github\.com\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)/i);
      const shortPrMatch = ghInput.match(/^([^/]+)\/([^#@]+)#(\d+)$/);
      const shortCommitMatch = ghInput.match(/^([^/]+)\/([^#@]+)@([a-f0-9]+)$/i);

      if (prUrlMatch) {
        [, owner, repo] = prUrlMatch;
        prNumber = Number(prUrlMatch[3]);
      } else if (commitUrlMatch) {
        [, owner, repo, commitSha] = commitUrlMatch;
      } else if (shortPrMatch) {
        [, owner, repo] = shortPrMatch;
        prNumber = Number(shortPrMatch[3]);
      } else if (shortCommitMatch) {
        [, owner, repo, commitSha] = shortCommitMatch;
      }

      if (owner && repo) {
        const ghResult = await runGitHubOnDemandReview({
          owner,
          repo,
          pullNumber: prNumber,
          commitSha,
          token: process.env.GITHUB_TOKEN,
          postComment: Boolean(flags['post-github'] || flags['post-comment']),
          config,
        });
        await store.addReview(ghResult);
        if (format === 'json') {
          console.log(JSON.stringify(ghResult, null, 2));
        } else if (format === 'markdown') {
          console.log(ghResult.markdownWalkthrough);
        } else {
          console.log(renderTerminalReview(ghResult));
        }
        return;
      }
    }

    // 2. Live GitLab on-demand review
    const glInput = flags.gitlab || flags['gitlab-url'];
    if (typeof glInput === 'string') {
      let projectId: string | number = '';
      let mrIid: number | undefined = undefined;
      let commitSha: string | undefined = undefined;

      const mrUrlMatch = glInput.match(/gitlab\.com\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)/);
      const commitUrlMatch = glInput.match(/gitlab\.com\/([^/]+(?:\/[^/]+)+)\/-\/commit\/([a-f0-9]+)/i);
      const shortMrMatch = glInput.match(/^([^#@]+)#(\d+)$/);
      const shortCommitMatch = glInput.match(/^([^#@]+)@([a-f0-9]+)$/i);

      if (mrUrlMatch) {
        projectId = mrUrlMatch[1];
        mrIid = Number(mrUrlMatch[2]);
      } else if (commitUrlMatch) {
        projectId = commitUrlMatch[1];
        commitSha = commitUrlMatch[2];
      } else if (shortMrMatch) {
        projectId = shortMrMatch[1];
        mrIid = Number(shortMrMatch[2]);
      } else if (shortCommitMatch) {
        projectId = shortCommitMatch[1];
        commitSha = shortCommitMatch[2];
      }

      if (projectId) {
        const glResult = await runGitLabOnDemandReview({
          projectId,
          mrIid,
          commitSha,
          token: process.env.GITLAB_TOKEN,
          config,
        });
        await store.addReview(glResult);
        if (format === 'json') {
          console.log(JSON.stringify(glResult, null, 2));
        } else if (format === 'markdown') {
          console.log(glResult.markdownWalkthrough);
        } else {
          console.log(renderTerminalReview(glResult));
        }
        return;
      }
    }

    // 3. Live Bitbucket on-demand review
    const bbInput = flags.bitbucket || flags['bitbucket-url'];
    if (typeof bbInput === 'string') {
      let workspace = '';
      let repoSlug = '';
      let pullRequestId: number | undefined = undefined;
      let commitSha: string | undefined = undefined;

      const prUrlMatch = bbInput.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
      const commitUrlMatch = bbInput.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/commits\/([a-f0-9]+)/i);
      const shortPrMatch = bbInput.match(/^([^/]+)\/([^#@]+)#(\d+)$/);
      const shortCommitMatch = bbInput.match(/^([^/]+)\/([^#@]+)@([a-f0-9]+)$/i);

      if (prUrlMatch) {
        [, workspace, repoSlug] = prUrlMatch;
        pullRequestId = Number(prUrlMatch[3]);
      } else if (commitUrlMatch) {
        [, workspace, repoSlug, commitSha] = commitUrlMatch;
      } else if (shortPrMatch) {
        [, workspace, repoSlug] = shortPrMatch;
        pullRequestId = Number(shortPrMatch[3]);
      } else if (shortCommitMatch) {
        [, workspace, repoSlug, commitSha] = shortCommitMatch;
      }

      if (workspace && repoSlug) {
        const bbResult = await runBitbucketOnDemandReview({
          workspace,
          repoSlug,
          pullRequestId,
          commitSha,
          token: process.env.BITBUCKET_TOKEN,
          config,
        });
        await store.addReview(bbResult);
        if (format === 'json') {
          console.log(JSON.stringify(bbResult, null, 2));
        } else if (format === 'markdown') {
          console.log(bbResult.markdownWalkthrough);
        } else {
          console.log(renderTerminalReview(bbResult));
        }
        return;
      }
    }

    let rawDiff = '';
    let prTitle = String(flags.title || 'Local Pull Request Review');
    let repository = String(flags.repo || 'local/openrabbit');
    let commitSha: string | undefined = undefined;

    if (flags.file && typeof flags.file === 'string') {
      rawDiff = fs.readFileSync(path.resolve(flags.file), 'utf8');
      prTitle = `Patch Review: ${path.basename(flags.file)}`;
    } else if (flags.commit && typeof flags.commit === 'string') {
      const commitData = getCommitDiff(targetRepoPath, flags.commit);
      rawDiff = commitData.diff;
      commitSha = commitData.commit.sha;
      prTitle = `Commit ${commitData.commit.shortSha}: ${commitData.commit.subject}`;
      const repoMeta = getRepoMetadata(targetRepoPath);
      repository = repoMeta.name;
    } else if (flags.range && typeof flags.range === 'string') {
      const rangeData = getCommitRangeDiff(targetRepoPath, flags.range);
      rawDiff = rangeData.diff;
      prTitle = rangeData.title;
      const repoMeta = getRepoMetadata(targetRepoPath);
      repository = repoMeta.name;
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
        cwd: targetRepoPath,
        staged: Boolean(flags.staged),
        baseBranch: typeof flags.base === 'string' ? flags.base : undefined,
      });
      if (localGit.diff.trim()) {
        rawDiff = localGit.diff;
        prTitle = `Local Review: ${localGit.description}`;
        repository = localGit.repoName;
        commitSha = localGit.commitSha;
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
      commitSha,
      source: 'cli',
      config,
    });

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
    ${ANSI.dim}--repo-path <dir>${ANSI.reset}              Review repository at a specific local path
    ${ANSI.dim}--commit <sha>${ANSI.reset}                 Review a specific commit in the repository
    ${ANSI.dim}--range <from..to>${ANSI.reset}             Review a commit range (e.g. main..feat/auth)
    ${ANSI.dim}--staged${ANSI.reset}                        Review staged git changes
    ${ANSI.dim}--base <branch>${ANSI.reset}                 Review branch diff against base (e.g. main)
    ${ANSI.dim}--file <patch>${ANSI.reset}                  Review a specific .diff / .patch file
    ${ANSI.dim}--demo [id]${ANSI.reset}                     Run against a sample PR diff (auth-jwt-sqli | react-billing-hook | clean-stream-worker)
    ${ANSI.dim}--github <owner/repo#pr>${ANSI.reset}       Review a live GitHub Pull Request or commit
    ${ANSI.dim}--gitlab <project#mr>${ANSI.reset}          Review a live GitLab Merge Request or commit
    ${ANSI.dim}--bitbucket <workspace/repo#pr>${ANSI.reset} Review a live Bitbucket Pull Request or commit
    ${ANSI.dim}--profile <mode>${ANSI.reset}                Override profile (chill | assertive | security-focused)
    ${ANSI.dim}--provider <llm>${ANSI.reset}                Override LLM (auto | openai | anthropic | gemini | ollama | heuristic)
    ${ANSI.dim}--format <fmt>${ANSI.reset}                  Output format (terminal | markdown | json)

  ${ANSI.cyan}openrabbit repo list${ANSI.reset}                 List registered local repositories
  ${ANSI.cyan}openrabbit repo add <path>${ANSI.reset}           Add a repository from local file system
  ${ANSI.cyan}openrabbit repo remove <path|id>${ANSI.reset}     Remove a registered local repository
  ${ANSI.cyan}openrabbit repo commits [path]${ANSI.reset}       List recent commits with author & stats

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
