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

export interface RunReviewOptions {
  rawDiff: string;
  prTitle?: string;
  repository?: string;
  prNumber?: number;
  author?: string;
  baseBranch?: string;
  headBranch?: string;
  commitSha?: string;
  source?: 'cli' | 'github' | 'gitlab' | 'bitbucket' | 'playground';
  config?: OpenRabbitConfig;
}

export async function runPullRequestReview(
  options: RunReviewOptions
): Promise<ReviewResult> {
  const startTime = Date.now();
  const config = options.config || DEFAULT_OPENRABBIT_CONFIG;
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

  // Always run deterministic heuristic rules first for high-precision security & async bug detection
  let findings: InlineFinding[] = runHeuristicInlineReview(filteredFiles, config);
  let walkthrough: PRWalkthrough = buildHeuristicWalkthrough(
    prTitle,
    filteredFiles,
    findings,
    config
  );
  let providerUsed: string = activeProviderInfo.provider;
  let modelUsed: string = activeProviderInfo.model;

  if (activeProviderInfo.provider !== 'heuristic' && filteredFiles.length > 0) {
    try {
      const llmOutput = await runLLMTwoStageReview(
        prTitle,
        filteredFiles,
        config,
        activeProviderInfo.provider,
        activeProviderInfo.model
      );
      if (llmOutput.findings.length > 0) {
        findings = mergeAndSnapFindings(
          findings,
          llmOutput.findings,
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
      providerUsed = llmOutput.provider;
      modelUsed = llmOutput.model;
    } catch (err) {
      console.warn(
        `[OpenRabbit] External LLM provider (${activeProviderInfo.provider}) unavailable, falling back to built-in AST/Heuristic engine:`,
        (err as Error).message
      );
      providerUsed = 'heuristic';
      modelUsed = 'openrabbit-ast-v1 (fallback)';
    }
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
  };
}

async function runLLMTwoStageReview(
  prTitle: string,
  files: FileDiff[],
  config: OpenRabbitConfig,
  provider: Exclude<OpenRabbitConfig['llm']['provider'], 'auto'>,
  model: string
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
