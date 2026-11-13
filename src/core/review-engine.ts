import crypto from 'node:crypto';
import {
  DEFAULT_OPENRABBIT_CONFIG,
  getMatchingPathInstructions,
  shouldReviewFile,
} from '../config/config-loader.js';
import type {
  FileDiff,
  InlineFinding,
  OpenRabbitConfig,
  PRWalkthrough,
  ReviewResult,
} from '../types/index.js';
import { formatAnnotatedFileDiff, parseUnifiedDiff } from './diff-parser.js';
import {
  buildHeuristicWalkthrough,
  runHeuristicInlineReview,
} from './heuristic-analyzer.js';
import {
  generateLLMCompletion,
  resolveActiveProvider,
} from './llm-provider.js';
import { formatWalkthroughMarkdown } from './markdown-formatter.js';
import { enrichDiffContext } from './context-enricher.js';
import { loadRepoMemory, resolveMemoryFilePath } from './repo-memory.js';
import { runSecurityScanners } from './security-scanners/index.js';

export interface RunReviewOptions {
  rawDiff: string;
  prTitle?: string;
  repository?: string;
  repoPath?: string;
  memoryFilePath?: string;
  prNumber?: number;
  author?: string;
  baseBranch?: string;
  headBranch?: string;
  commitSha?: string;
  source?: 'cli' | 'github' | 'gitlab' | 'bitbucket' | 'playground';
  config?: OpenRabbitConfig;
  reviewer?: 'hybrid' | 'custom' | 'static-only' | 'llm-only';
  securityScanScope?: { skippedFiles: number };
}

export async function runPullRequestReview(
  options: RunReviewOptions
): Promise<ReviewResult> {
  const startTime = Date.now();
  const config = structuredClone(options.config || DEFAULT_OPENRABBIT_CONFIG);
  if (options.reviewer) {
    config.reviewer = options.reviewer;
  }
  const reviewerMode = config.reviewer || 'hybrid';
  const prTitle = options.prTitle || 'Pull Request Changes';
  const repository = options.repository || 'local/repository';
  const source = options.source || 'cli';

  const parsed = parseUnifiedDiff(options.rawDiff);

  // Filter files according to `.openrabbit.yaml` path_filters
  const filteredFiles = parsed.files.filter((f) =>
    shouldReviewFile(f.newPath, config.reviews.path_filters)
  );

  const activeProviderInfo = resolveActiveProvider(
    config.llm.provider,
    config.llm.model
  );

  const shouldRunStatic =
    reviewerMode !== 'llm-only' &&
    (config.static_analysis ? config.static_analysis.enabled !== false : true);

  if (filteredFiles.length > 0 && !shouldRunStatic &&
      (reviewerMode === 'static-only' || activeProviderInfo.provider === 'heuristic')) {
    throw new Error('No review engine is available: enable static analysis or configure an LLM provider.');
  }

  // Run deterministic static rules (built-in subset + Schema v1 custom rules)
  let findings: InlineFinding[] = shouldRunStatic
    ? runHeuristicInlineReview(filteredFiles, config)
    : [];

  let scannerTelemetry: { scannersRun: string[]; scannersSkipped: string[] } | undefined;
  if (
    options.repoPath &&
    reviewerMode !== 'llm-only' &&
    config.security_scanners?.enabled !== false &&
    filteredFiles.length > 0
  ) {
    const scanResult = await runSecurityScanners({
      repoPath: options.repoPath,
      files: filteredFiles,
      config,
    });
    scannerTelemetry = {
      scannersRun: scanResult.scannersRun,
      scannersSkipped: scanResult.scannersSkipped,
    };
    if (scanResult.findings.length > 0) {
      const existing = new Set(
        findings.map((f) => `${f.file}:${f.startLine}:${f.ruleMatched || f.title}`)
      );
      for (const sf of scanResult.findings) {
        const key = `${sf.file}:${sf.startLine}:${sf.ruleMatched || sf.title}`;
        if (!existing.has(key)) {
          existing.add(key);
          findings.push(sf);
        }
      }
    }
  }

  const repoMemory =
    options.repoPath || options.memoryFilePath
      ? loadRepoMemory(resolveMemoryFilePath(options.repoPath, options.memoryFilePath))
      : { ignoredRules: [], instructions: [], updatedAt: '' };
  const ignoredRuleSet = new Set(repoMemory.ignoredRules);
  const filterIgnored = (items: InlineFinding[]) =>
    ignoredRuleSet.size > 0
      ? items.filter((f) => !(f.ruleMatched && ignoredRuleSet.has(f.ruleMatched)) && !ignoredRuleSet.has(f.id))
      : items;

  findings = filterIgnored(findings);

  if (config.profile === 'security-focused') {
    findings = findings.filter((finding) => finding.category === 'security');
  }

  let walkthrough: PRWalkthrough = buildHeuristicWalkthrough(
    prTitle,
    filteredFiles,
    findings,
    config
  );

  let providerUsed: string =
    reviewerMode === 'custom'
      ? 'custom-static'
      : reviewerMode === 'static-only' ? 'heuristic' : activeProviderInfo.provider;
  let modelUsed: string =
    reviewerMode === 'custom'
      ? 'openrabbit-rules-v1'
      : reviewerMode === 'static-only' ? 'openrabbit-ast-v1' : activeProviderInfo.model;

  const shouldRunLLM =
    reviewerMode !== 'static-only' &&
    activeProviderInfo.provider !== 'heuristic' &&
    filteredFiles.length > 0;

  if (shouldRunLLM) {
    try {
      const crossFileContext = options.repoPath
        ? enrichDiffContext(options.repoPath, filteredFiles).formattedPromptContext
        : '';
      const llmOutput = await runLLMTwoStageReview(
        prTitle,
        filteredFiles,
        config,
        activeProviderInfo.provider,
        activeProviderInfo.model,
        crossFileContext,
        repoMemory.instructions
      );
      const llmFindings = config.profile === 'security-focused'
        ? llmOutput.findings.filter((finding) => finding.category === 'security' && finding.severity !== 'praise')
        : llmOutput.findings;
      if (llmFindings.length > 0) {
        findings = mergeAndSnapFindings(
          findings,
          llmFindings,
          filteredFiles,
          config
        );
      }
      walkthrough = {
        ...walkthrough,
        ...llmOutput.walkthrough,
        fileSummaries:
          llmOutput.walkthrough.fileSummaries &&
          llmOutput.walkthrough.fileSummaries.length > 0
            ? llmOutput.walkthrough.fileSummaries
            : walkthrough.fileSummaries,
        mermaidDiagram:
          llmOutput.walkthrough.mermaidDiagram || walkthrough.mermaidDiagram,
        poem: config.reviews.poem
          ? llmOutput.walkthrough.poem || walkthrough.poem
          : '',
      };
      if (reviewerMode === 'custom') {
        providerUsed = `custom (${llmOutput.provider} + static)`;
        modelUsed = `${llmOutput.model} + schema-v1`;
      } else {
        providerUsed = llmOutput.provider;
        modelUsed = llmOutput.model;
      }
    } catch (err) {
      if (!shouldRunStatic) {
        throw new Error(`LLM review failed and static analysis is disabled: ${(err as Error).message}`, { cause: err });
      }
      console.warn(
        `[OpenRabbit] External LLM provider (${activeProviderInfo.provider}) unavailable, falling back to built-in AST/Heuristic engine:`,
        (err as Error).message
      );
      providerUsed = reviewerMode === 'custom' ? 'custom-static' : 'heuristic';
      modelUsed =
        reviewerMode === 'custom'
          ? 'openrabbit-rules-v1'
          : 'openrabbit-ast-v1 (fallback)';
    }
  }

  findings = filterIgnored(findings);

  if (config.profile === 'security-focused') {
    walkthrough = {
      ...buildHeuristicWalkthrough(prTitle, filteredFiles, findings, config),
      executiveSummary: options.securityScanScope
        ? `Offline security scan of ${filteredFiles.length} tracked working-tree text file(s) found ${findings.length} potential security issue(s); ${options.securityScanScope.skippedFiles} tracked file(s) were skipped. Findings require human verification; this scan does not establish that the repository is secure.`
        : `Security review of ${filteredFiles.length} changed file(s) found ${findings.length} potential security issue(s). Findings require human verification; this diff-based review does not establish that the repository is secure.`,
    };
  }

  const durationMs = Math.max(12, Date.now() - startTime);

  const markdownWalkthrough = formatWalkthroughMarkdown(
    walkthrough,
    findings,
    config,
    {
      provider: providerUsed,
      model: modelUsed,
      durationMs,
    }
  );

  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const suggestionCount = findings.filter((f) => f.severity === 'suggestion').length;
  const nitpickCount = findings.filter((f) => f.severity === 'nitpick').length;
  const praiseCount = findings.filter((f) => f.severity === 'praise').length;

  return {
    id: `rev-${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    source,
    repository,
    prNumber: options.prNumber,
    prTitle,
    author: options.author || 'developer',
    baseBranch: options.baseBranch || 'main',
    headBranch: options.headBranch || 'feat/branch',
    commitSha: options.commitSha || crypto.randomBytes(4).toString('hex'),
    providerUsed,
    modelUsed,
    durationMs,
    stats: {
      filesReviewed: filteredFiles.length,
      additions: filteredFiles.reduce((s, f) => s + f.additions, 0),
      deletions: filteredFiles.reduce((s, f) => s + f.deletions, 0),
      findingsCount: findings.length,
      criticalCount,
      warningCount,
      suggestionCount,
      nitpickCount,
      praiseCount,
    },
    walkthrough,
    findings,
    markdownWalkthrough,
    rawDiff: options.rawDiff,
    ...(scannerTelemetry ? { scannerTelemetry } : {}),
  };
}

async function runLLMTwoStageReview(
  prTitle: string,
  files: FileDiff[],
  config: OpenRabbitConfig,
  provider: Exclude<OpenRabbitConfig['llm']['provider'], 'auto'>,
  model: string,
  crossFileContext: string = '',
  rememberedInstructions: string[] = []
): Promise<{
  walkthrough: Partial<PRWalkthrough>;
  findings: InlineFinding[];
  provider: string;
  model: string;
}> {
  const annotatedFiles = files.map((file) => {
    const matchedRules = getMatchingPathInstructions(
      file.newPath,
      config.reviews.path_instructions
    );
    const rulesText =
      matchedRules.length > 0
        ? `\nPath-Specific Instructions for \`${file.newPath}\`:\n` +
          matchedRules.map((r) => `- (${r.path}): ${r.instructions}`).join('\n')
        : '';
    return formatAnnotatedFileDiff(file) + rulesText;
  });

  const systemPrompt = `You are OpenRabbit, an elite open-source AI code reviewer modeled after the best practices of CodeRabbit.
Profile mode: ${config.profile.toUpperCase()}
Tone instructions: ${config.tone_instructions}
Human Review Language: ${config.language}
${rememberedInstructions.length > 0 ? `\nRepository Team Guidelines (Remembered):\n${rememberedInstructions.map((i) => `- ${i}`).join('\n')}` : ''}
${crossFileContext ? `\n${crossFileContext}` : ''}
${config.profile === 'security-focused' ? `Security review: report only security findings. Examine authorization, trust boundaries, injection, secrets, insecure cryptography, and sensitive data exposure. Cite evidence in the diff, explain prerequisites and uncertainty, and give practical remediation. Do not claim exploitability or repository-wide safety without evidence.` : ''}

Apply deep, language-idiomatic standards across all languages present in the diff:
- Python: check mutable default arguments (def f(x=[])), SQL injection via f-strings/raw formatting, subprocess shell=True, unclosed files/context managers, unhandled exceptions, and blocking async calls.
- Go: check unhandled error returns (if err != nil), missing defer resp.Body.Close(), fmt.Sprintf SQL injection, goroutine/channel leaks, and data races.
- Rust: check unsafe .unwrap() in non-test paths (prefer ? or unwrap_or_default), unannotated unsafe blocks, and unnecessary clones.
- Java/Kotlin: check SQL/HQL concatenation, unclosed AutoCloseable resources, and null safety.
- TypeScript/JavaScript: check async forEach, promise rejection handling, loose equality coercion, and React hook dependencies.
- Shell/Bash: check set -euo pipefail, unquoted expansions, and command injection risks.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "executiveSummary": "Concise 2-3 sentence overview of the PR changes and key risks",
  "effortScore": 3,
  "estimatedMinutes": 5,
  "riskLevel": "low" | "moderate" | "high" | "critical",
  "mermaidDiagram": "sequenceDiagram\\n  autonumber\\n  ...",
  "poem": "4-line rabbit-themed poem about the code changes",
  "findings": [
    {
      "file": "exact file path from diff",
      "startLine": 12,
      "endLine": 12,
      "severity": "critical" | "warning" | "suggestion" | "nitpick" | "praise",
      "category": "security" | "bug" | "performance" | "maintainability" | "type-safety" | "logic",
      "title": "Short actionable title",
      "body": "Clear explanation of the bug or improvement",
      "suggestionCode": "Exact replacement code for the line(s) without surrounding backticks"
    }
  ]
}`;

  const userPrompt = `Pull Request Title: ${prTitle}\n\nAnnotated Unified Diff:\n\n${annotatedFiles.join(
    '\n\n---\n\n'
  )}`;

  const res = await generateLLMCompletion({
    systemPrompt,
    userPrompt,
    temperature: config.llm.temperature,
    jsonMode: true,
    preferredProvider: provider,
    preferredModel: model,
  });

  const cleaned = res.content
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned);

  const llmFindings: InlineFinding[] = (parsed.findings || []).map((f: any) => ({
    id: `finding-${crypto.randomUUID().slice(0, 8)}`,
    file: String(f.file || files[0]?.newPath || ''),
    startLine: Number(f.startLine) || 1,
    endLine: Number(f.endLine || f.startLine) || 1,
    severity: f.severity || 'suggestion',
    category: f.category || 'bug',
    title: String(f.title || 'Code Review Finding'),
    body: String(f.body || ''),
    suggestionCode: f.suggestionCode ? String(f.suggestionCode) : undefined,
  }));

  return {
    walkthrough: {
      executiveSummary: parsed.executiveSummary,
      effortScore: parsed.effortScore,
      estimatedMinutes: parsed.estimatedMinutes,
      riskLevel: parsed.riskLevel,
      mermaidDiagram: parsed.mermaidDiagram,
      poem: parsed.poem,
    },
    findings: llmFindings,
    provider: res.provider,
    model: res.model,
  };
}

/**
 * Ensures all findings reference valid line numbers present in the diff hunks
 * and deduplicates overlapping findings on the same file & line.
 */
function mergeAndSnapFindings(
  heuristicFindings: InlineFinding[],
  llmFindings: InlineFinding[],
  files: FileDiff[],
  config: OpenRabbitConfig
): InlineFinding[] {
  const combined = [...heuristicFindings.filter((f) => f.severity !== 'praise')];
  const existingKeys = new Set(
    combined.map((f) => `${f.file}:${f.startLine}`)
  );

  for (const lf of llmFindings) {
    if (config.profile === 'chill' && lf.severity === 'nitpick') continue;
    const fileObj = files.find((f) => f.newPath === lf.file) || files[0];
    if (!fileObj) continue;

    // Snap line number to nearest valid newLineNumber in file hunks
    const validLines: number[] = [];
    for (const h of fileObj.hunks) {
      for (const l of h.lines) {
        if (l.newLineNumber !== undefined) validLines.push(l.newLineNumber);
      }
    }
    let snappedLine = lf.startLine;
    if (validLines.length > 0 && !validLines.includes(snappedLine)) {
      snappedLine = validLines.reduce((prev, curr) =>
        Math.abs(curr - lf.startLine) < Math.abs(prev - lf.startLine) ? curr : prev
      );
    }

    const key = `${fileObj.newPath}:${snappedLine}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      combined.push({
        ...lf,
        file: fileObj.newPath,
        startLine: snappedLine,
        endLine: Math.max(snappedLine, lf.endLine),
      });
    }
  }

  return combined;
}
