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
  ReviewCategory,
  ReviewResult,
  ReviewSeverity,
} from '../types/index.js';
import { sanitizeSuggestionCode } from './suggestion-validator.js';
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
  source?: 'cli' | 'github' | 'gitlab' | 'bitbucket' | 'forgejo' | 'playground';
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

  let llmTelemetry: LLMTelemetry | undefined;
  if (shouldRunLLM) {
    llmTelemetry = createLLMTelemetry();
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
        repoMemory.instructions,
        llmTelemetry
      );
      llmTelemetry = llmOutput.telemetry;
      const llmFindings = config.profile === 'security-focused'
        ? llmOutput.findings.filter((finding) => finding.category === 'security' && finding.severity !== 'praise')
        : llmOutput.findings;
      if (llmFindings.length > 0) {
        findings = mergeAndSnapFindings(
          findings,
          llmFindings,
          filteredFiles,
          config,
          llmTelemetry
        );
      }
      // Merge only defined LLM fields so a partial model response can never
      // blank out the heuristic walkthrough with `undefined`.
      const llmWalkthrough = Object.fromEntries(
        Object.entries(llmOutput.walkthrough).filter(([, v]) => v !== undefined)
      ) as Partial<PRWalkthrough>;
      walkthrough = {
        ...walkthrough,
        ...llmWalkthrough,
        fileSummaries:
          llmWalkthrough.fileSummaries && llmWalkthrough.fileSummaries.length > 0
            ? llmWalkthrough.fileSummaries
            : walkthrough.fileSummaries,
        mermaidDiagram:
          llmWalkthrough.mermaidDiagram || walkthrough.mermaidDiagram,
        poem: config.reviews.poem
          ? llmWalkthrough.poem || walkthrough.poem
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
      llmTelemetry.fallbackReason = (err as Error).message;
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
    ...(llmTelemetry ? { llmTelemetry } : {}),
  };
}

/** Per-file cap for LLM prompt context; larger diffs are truncated with a marker. */
export const MAX_LLM_CHARS_PER_FILE = 12000;
/** Total cap for LLM prompt context across all files. */
export const MAX_LLM_TOTAL_CHARS = 60000;
/** Maximum distance an LLM line number may drift from a real diff line. */
export const MAX_LLM_LINE_SNAP_DISTANCE = 5;
/** Maximum line span of a single LLM finding; larger ranges are clamped. */
export const MAX_LLM_FINDING_SPAN = 20;

export interface LLMTelemetry {
  parseOk: boolean;
  findingsReceived: number;
  findingsAccepted: number;
  findingsDropped: number;
  dropReasons: Record<string, number>;
  truncatedFiles: number;
  fallbackReason?: string;
}

export function createLLMTelemetry(): LLMTelemetry {
  return {
    parseOk: false,
    findingsReceived: 0,
    findingsAccepted: 0,
    findingsDropped: 0,
    dropReasons: {},
    truncatedFiles: 0,
  };
}

function recordDrop(telemetry: LLMTelemetry | undefined, reason: string): void {
  if (!telemetry) return;
  telemetry.findingsDropped++;
  telemetry.dropReasons[reason] = (telemetry.dropReasons[reason] || 0) + 1;
}

const VALID_SEVERITIES: ReviewSeverity[] = [
  'critical',
  'warning',
  'suggestion',
  'nitpick',
  'praise',
];
const VALID_CATEGORIES: ReviewCategory[] = [
  'security',
  'bug',
  'performance',
  'maintainability',
  'type-safety',
  'logic',
  'architecture',
  'testing',
];
const VALID_RISK_LEVELS: PRWalkthrough['riskLevel'][] = [
  'low',
  'moderate',
  'high',
  'critical',
];

/**
 * Extracts a JSON object from model output that may be wrapped in Markdown
 * fences or trailing prose. Throws when no parseable object exists, in
 * which case the caller falls back to the heuristic engine.
 */
export function extractLLMJsonObject(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const direct = JSON.parse(stripped) as unknown;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
  } catch {
    // Fall through to brace slicing below.
  }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = JSON.parse(stripped.slice(start, end + 1)) as unknown;
    if (sliced && typeof sliced === 'object' && !Array.isArray(sliced)) {
      return sliced as Record<string, unknown>;
    }
  }
  throw new SyntaxError('No JSON object found in LLM response');
}

export interface ParsedLLMReview {
  walkthrough: Partial<PRWalkthrough>;
  findings: InlineFinding[];
}

function asNonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return undefined;
  const floored = Math.floor(num);
  return floored >= 1 ? floored : undefined;
}

/**
 * Parses and shape-validates one LLM review response. Malformed findings
 * are dropped (never defaulted onto unrelated files or lines) so a weak
 * model degrades to fewer comments instead of garbled ones.
 */
export function parseLLMReviewJson(
  content: string,
  telemetry?: LLMTelemetry
): ParsedLLMReview {
  const parsed = extractLLMJsonObject(content);

  const effortScore = asPositiveInt(parsed.effortScore);
  const estimatedMinutes = asPositiveInt(parsed.estimatedMinutes);
  const riskLevel =
    typeof parsed.riskLevel === 'string' &&
    (VALID_RISK_LEVELS as string[]).includes(parsed.riskLevel)
      ? (parsed.riskLevel as PRWalkthrough['riskLevel'])
      : undefined;

  const findings: InlineFinding[] = [];
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  if (telemetry) telemetry.findingsReceived = rawFindings.length;

  for (const raw of rawFindings) {
    const candidate = (raw || {}) as Record<string, unknown>;
    const file = asNonEmptyString(candidate.file, 512);
    const startLine = asPositiveInt(candidate.startLine);
    const endLine = asPositiveInt(candidate.endLine) ?? startLine;
    const title = asNonEmptyString(candidate.title, 200);
    const body = asNonEmptyString(candidate.body, 4000);
    if (!file || !startLine || !endLine || !title || !body) {
      recordDrop(telemetry, 'invalid-shape');
      continue;
    }
    const severity =
      typeof candidate.severity === 'string' &&
      (VALID_SEVERITIES as string[]).includes(candidate.severity)
        ? (candidate.severity as ReviewSeverity)
        : 'suggestion';
    const category =
      typeof candidate.category === 'string' &&
      (VALID_CATEGORIES as string[]).includes(candidate.category)
        ? (candidate.category as ReviewCategory)
        : 'bug';
    const suggestionCode = asNonEmptyString(candidate.suggestionCode, 4000);
    findings.push({
      id: `finding-${crypto.randomUUID().slice(0, 8)}`,
      file,
      startLine,
      endLine: Math.max(startLine, endLine),
      severity,
      category,
      title,
      body,
      suggestionCode: suggestionCode?.replace(/```/g, "'''"),
    });
  }

  if (telemetry) telemetry.parseOk = true;
  return {
    walkthrough: {
      executiveSummary: asNonEmptyString(parsed.executiveSummary, 2000),
      effortScore:
        effortScore !== undefined &&
        effortScore >= 1 &&
        effortScore <= 5
          ? (effortScore as 1 | 2 | 3 | 4 | 5)
          : undefined,
      estimatedMinutes,
      riskLevel,
      mermaidDiagram: asNonEmptyString(parsed.mermaidDiagram, 4000),
      poem: asNonEmptyString(parsed.poem, 1000),
    },
    findings,
  };
}

/**
 * Bounds one file's annotated diff for the LLM prompt, marking truncation
 * explicitly so the model never sees a silently cut-off hunk.
 */
export function boundPromptFileText(
  text: string,
  telemetry?: LLMTelemetry
): string {
  if (text.length <= MAX_LLM_CHARS_PER_FILE) return text;
  if (telemetry) telemetry.truncatedFiles++;
  return (
    text.slice(0, MAX_LLM_CHARS_PER_FILE) +
    `\n[... truncated ${text.length - MAX_LLM_CHARS_PER_FILE} chars from this file ...]`
  );
}

async function runLLMTwoStageReview(
  prTitle: string,
  files: FileDiff[],
  config: OpenRabbitConfig,
  provider: Exclude<OpenRabbitConfig['llm']['provider'], 'auto'>,
  model: string,
  crossFileContext: string = '',
  rememberedInstructions: string[] = [],
  telemetry: LLMTelemetry = createLLMTelemetry()
): Promise<{
  walkthrough: Partial<PRWalkthrough>;
  findings: InlineFinding[];
  provider: string;
  model: string;
  telemetry: LLMTelemetry;
}> {
  const annotatedFiles: string[] = [];
  let promptChars = 0;
  let omittedFiles = 0;
  for (const file of files) {
    const matchedRules = getMatchingPathInstructions(
      file.newPath,
      config.reviews.path_instructions
    );
    const rulesText =
      matchedRules.length > 0
        ? `\nPath-Specific Instructions for \`${file.newPath}\`:\n` +
          matchedRules.map((r) => `- (${r.path}): ${r.instructions}`).join('\n')
        : '';
    const bounded = boundPromptFileText(
      formatAnnotatedFileDiff(file) + rulesText,
      telemetry
    );
    if (
      promptChars + bounded.length > MAX_LLM_TOTAL_CHARS &&
      annotatedFiles.length > 0
    ) {
      omittedFiles++;
      continue;
    }
    annotatedFiles.push(bounded);
    promptChars += bounded.length;
  }
  if (omittedFiles > 0) {
    telemetry.truncatedFiles += omittedFiles;
    annotatedFiles.push(
      `[... ${omittedFiles} more changed file(s) omitted from LLM context by size budget; static analysis still covers them ...]`
    );
  }

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
      "category": "security" | "bug" | "performance" | "maintainability" | "type-safety" | "logic" | "architecture" | "testing",
      "title": "Short actionable title",
      "body": "Clear explanation of the bug or improvement",
      "suggestionCode": "Exact replacement code for the line(s) without surrounding backticks"
    }
  ]
}

Rules for findings: use ONLY file paths shown above; use ONLY the annotated L line numbers (never invent lines); keep suggestionCode a complete replacement for the cited lines, not a fragment.}`;

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

  const llmReview = parseLLMReviewJson(res.content, telemetry);

  return {
    walkthrough: llmReview.walkthrough,
    findings: llmReview.findings,
    provider: res.provider,
    model: res.model,
    telemetry,
  };
}

/**
 * Merges LLM findings onto heuristic findings. Every LLM finding must name
 * a real file from the diff and a line within snapping distance of the
 * diff; anything else is dropped (and counted in telemetry) instead of
 * being misplaced onto an unrelated file or a far-away line.
 */
export function mergeAndSnapFindings(
  heuristicFindings: InlineFinding[],
  llmFindings: InlineFinding[],
  files: FileDiff[],
  config: OpenRabbitConfig,
  telemetry?: LLMTelemetry
): InlineFinding[] {
  const combined = [...heuristicFindings.filter((f) => f.severity !== 'praise')];
  const existingKeys = new Set(
    combined.map((f) => `${f.file}:${f.startLine}`)
  );

  for (const lf of llmFindings) {
    if (config.profile === 'chill' && lf.severity === 'nitpick') continue;
    const fileObj = files.find((f) => f.newPath === lf.file);
    if (!fileObj) {
      recordDrop(telemetry, 'unknown-file');
      continue;
    }

    const lineContents = new Map<number, string>();
    for (const h of fileObj.hunks) {
      for (const l of h.lines) {
        if (l.newLineNumber !== undefined) {
          lineContents.set(l.newLineNumber, l.content);
        }
      }
    }
    const validLines = Array.from(lineContents.keys()).sort((a, b) => a - b);
    if (validLines.length === 0) {
      recordDrop(telemetry, 'no-diff-lines');
      continue;
    }

    let snappedLine = lf.startLine;
    if (!lineContents.has(snappedLine)) {
      const nearest = validLines.reduce((prev, curr) =>
        Math.abs(curr - lf.startLine) < Math.abs(prev - lf.startLine) ? curr : prev
      );
      if (Math.abs(nearest - lf.startLine) > MAX_LLM_LINE_SNAP_DISTANCE) {
        recordDrop(telemetry, 'line-out-of-range');
        continue;
      }
      snappedLine = nearest;
    }

    // Preserve the finding's span instead of stretching ranges across the file.
    const span = Math.min(
      MAX_LLM_FINDING_SPAN,
      Math.max(0, lf.endLine - lf.startLine)
    );
    let endLine = snappedLine + span;
    while (endLine > snappedLine && !lineContents.has(endLine)) {
      endLine--;
    }

    const key = `${fileObj.newPath}:${snappedLine}`;
    if (existingKeys.has(key)) {
      recordDrop(telemetry, 'duplicate');
      continue;
    }
    existingKeys.add(key);
    if (telemetry) telemetry.findingsAccepted++;
    combined.push({
      ...lf,
      file: fileObj.newPath,
      startLine: snappedLine,
      endLine,
      suggestionCode: sanitizeSuggestionCode(
        lf.suggestionCode,
        lineContents.get(snappedLine)
      ),
    });
  }

  return combined;
}
