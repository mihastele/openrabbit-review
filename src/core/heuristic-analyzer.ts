import crypto from 'node:crypto';
import type {
  FileDiff,
  FileWalkthroughSummary,
  InlineFinding,
  OpenRabbitConfig,
  PRWalkthrough,
  ReviewCategory,
  ReviewSeverity,
} from '../types/index.js';
import { inferComponentName } from './diff-parser.js';
import { LanguageRegistry, type LanguageRule } from './languages/index.js';
import {
  GLOBAL_SECURITY_RULES,
  filterBuiltinRules,
  evaluateCustomRules,
} from './custom-rules/index.js';

export { GLOBAL_SECURITY_RULES };

/**
 * Generates high-signal inline findings by combining universal global rules
 * with language-specific rules from the registered LanguageStrategy,
 * respecting built-in rule filtering and user-defined Schema v1 custom rules.
 */
export function runHeuristicInlineReview(
  files: FileDiff[],
  config: OpenRabbitConfig
): InlineFinding[] {
  const findings: InlineFinding[] = [];
  const seenKeys = new Set<string>();
  const registry = LanguageRegistry.getInstance();

  const staticConfig = config.static_analysis;
  const isStaticEnabled = staticConfig ? staticConfig.enabled !== false : true;

  if (isStaticEnabled) {
    for (const file of files) {
      if (file.status === 'deleted') continue;

      // Strategy Pattern: Resolve language-specific strategy rules for this file
      const strategy = registry.getStrategyForFile(file.newPath);
      let applicableRules: LanguageRule[] = [
        ...GLOBAL_SECURITY_RULES,
        ...strategy.getRules(),
      ];

      // Apply built-in rules subset/exclusion filters if configured
      if (staticConfig?.builtinRules) {
        applicableRules = filterBuiltinRules(
          applicableRules,
          staticConfig.builtinRules
        );
      }

      for (const hunk of file.hunks) {
        const addedLinesWithIndex = hunk.lines
          .map((l, idx) => ({ line: l, idx }))
          .filter((item) => item.line.type === 'add' && item.line.newLineNumber);

        for (const { line, idx } of addedLinesWithIndex) {
          const lineNum = line.newLineNumber!;
          const contextSlice = hunk.lines
            .slice(Math.max(0, idx - 3), Math.min(hunk.lines.length, idx + 4))
            .map((l) => l.content);

          for (const rule of applicableRules) {
            // Filter nitpicks if profile is 'chill'
            if (config.profile === 'chill' && rule.severity === 'nitpick') {
              continue;
            }

            if (rule.matchLine(line.content, file, contextSlice)) {
              const dedupeKey = `${file.newPath}:${rule.id}:${Math.floor(lineNum / 5)}`;
              if (seenKeys.has(dedupeKey)) continue;
              seenKeys.add(dedupeKey);

              const details = rule.buildFinding(
                line.content,
                lineNum,
                file,
                contextSlice
              );

              findings.push({
                id: `finding-${crypto.randomUUID().slice(0, 8)}`,
                file: file.newPath,
                startLine: lineNum,
                endLine: lineNum,
                severity: rule.severity,
                category: rule.category,
                title: rule.title,
                body: details.body,
                suggestionCode: details.suggestionCode,
                originalCode: line.content,
                ruleMatched: rule.id,
              });
            }
          }
        }
      }
    }

    // Evaluate user-defined Custom Rules (Schema v1)
    if (staticConfig?.customRules && staticConfig.customRules.length > 0) {
      const customFindings = evaluateCustomRules(
        files,
        staticConfig.customRules,
        config.profile
      );
      for (const cf of customFindings) {
        const dedupeKey = `${cf.file}:${cf.ruleMatched}:${cf.startLine}`;
        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          findings.push(cf);
        }
      }
    }
  }

  // If a PR has clean additions and no issues were flagged, add a constructive architectural observation or praise
  if (findings.length === 0 && files.length > 0) {
    const primaryFile = files.find((f) => f.hunks.length > 0) || files[0];
    const firstHunk = primaryFile.hunks[0];
    const firstAdd = firstHunk?.lines.find((l) => l.type === 'add');
    const targetLine = firstAdd?.newLineNumber || firstHunk?.newStart || 1;

    findings.push({
      id: `finding-${crypto.randomUUID().slice(0, 8)}`,
      file: primaryFile.newPath,
      startLine: targetLine,
      endLine: targetLine,
      severity: 'praise',
      category: 'architecture',
      title: 'Clean, well-structured implementation with no high-risk anti-patterns',
      body: `Reviewed **+${primaryFile.additions}/-${primaryFile.deletions}** lines in \`${primaryFile.newPath}\`${
        primaryFile.symbolsChanged.length > 0
          ? ` affecting ${primaryFile.symbolsChanged.map((s) => `\`${s}\``).join(', ')}`
          : ''
      }. No security vulnerabilities, unhandled errors, or unsafe resource leaks were detected.`,
    });
  }

  return findings;
}

/**
 * Generates a complete CodeRabbit-style PR Walkthrough (Summary, Release Notes,
 * File Table, Mermaid Sequence Diagram, Poem, and Risk Score) from the parsed diff.
 */
export function buildHeuristicWalkthrough(
  prTitle: string,
  files: FileDiff[],
  findings: InlineFinding[],
  config: OpenRabbitConfig
): PRWalkthrough {
  const fileSummaries: FileWalkthroughSummary[] = files.map((file) => {
    const component = inferComponentName(file.newPath);
    const fileFindings = findings.filter((f) => f.file === file.newPath);
    const hasCritical = fileFindings.some((f) => f.severity === 'critical');
    const hasWarning = fileFindings.some((f) => f.severity === 'warning');
    const churn = file.additions + file.deletions;

    const impact: 'low' | 'medium' | 'high' =
      hasCritical || churn > 80 ? 'high' : hasWarning || churn > 25 ? 'medium' : 'low';

    let summary = '';
    if (file.status === 'added') {
      summary = `Introduces new ${file.language} module${
        file.symbolsChanged.length > 0
          ? ` defining ${file.symbolsChanged.map((s) => `\`${s}\``).join(', ')}`
          : ''
      } (+${file.additions} lines).`;
    } else if (file.status === 'deleted') {
      summary = `Removes legacy ${file.language} file (-${file.deletions} lines).`;
    } else if (file.symbolsChanged.length > 0) {
      summary = `Updates ${file.symbolsChanged.map((s) => `\`${s}\``).join(', ')} in ${component} (+${file.additions}/-${file.deletions}).`;
    } else {
      summary = `Refines ${component.toLowerCase()} logic and configuration (+${file.additions}/-${file.deletions} lines).`;
    }

    return {
      path: file.newPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      component,
      summary,
      impact,
    };
  });

  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);
  const components = Array.from(new Set(fileSummaries.map((f) => f.component)));

  const criticalFindings = findings.filter((f) => f.severity === 'critical');
  const warningFindings = findings.filter((f) => f.severity === 'warning');

  const riskLevel: PRWalkthrough['riskLevel'] =
    criticalFindings.length > 0
      ? 'critical'
      : warningFindings.length >= 2
      ? 'high'
      : warningFindings.length === 1 || totalAdditions + totalDeletions > 150
      ? 'moderate'
      : 'low';

  const totalChurn = totalAdditions + totalDeletions;
  const effortScore: 1 | 2 | 3 | 4 | 5 =
    totalChurn > 400 || criticalFindings.length >= 2
      ? 5
      : totalChurn > 200 || criticalFindings.length === 1
      ? 4
      : totalChurn > 75 || warningFindings.length >= 1
      ? 3
      : totalChurn > 20
      ? 2
      : 1;

  const estimatedMinutes = Math.max(2, Math.min(45, Math.ceil(totalChurn / 18) + findings.length * 2));

  // Build Mermaid sequence diagram reflecting the actual components/files changed
  const mermaidDiagram = generateMermaidDiagramForDiff(files, fileSummaries);

  // Build rabbit poem
  const poem = config.reviews.poem
    ? generateRabbitPoem(files, criticalFindings.length, warningFindings.length)
    : '';

  const executiveSummary = `This pull request modifies **${files.length} file${
    files.length === 1 ? '' : 's'
  }** across **${components.join(', ') || 'the repository'}** (+${totalAdditions}/-${totalDeletions} lines). ${
    criticalFindings.length > 0
      ? `OpenRabbit identified **${criticalFindings.length} critical issue(s)** and **${warningFindings.length} warning(s)** that should be addressed prior to merge.`
      : warningFindings.length > 0
      ? `OpenRabbit surfaced **${warningFindings.length} actionable warning(s)** with committable code suggestions.`
      : `The changes are clean and well-scoped with no blocking defects found.`
  }`;

  const releaseNotes = [
    {
      category: files.some((f) => f.status === 'added') ? 'New Features & Modules' : 'Enhancements & Refactoring',
      items: fileSummaries.slice(0, 5).map((f) => `${f.component}: ${f.summary}`),
    },
  ];

  const securityConcerns = findings
    .filter((f) => f.category === 'security')
    .map((f) => `${f.file}:L${f.startLine} — ${f.title}`);

  return {
    title: prTitle || 'Pull Request Review',
    executiveSummary,
    releaseNotes,
    fileSummaries,
    mermaidDiagram,
    poem,
    effortScore,
    estimatedMinutes,
    riskLevel,
    securityConcerns,
  };
}

function sanitizeMermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+|_+$/g, '') || 'Node';
}

function generateMermaidDiagramForDiff(
  files: FileDiff[],
  summaries: FileWalkthroughSummary[]
): string {
  if (files.length === 0) {
    return `sequenceDiagram\n  participant Dev as Developer\n  participant OR as OpenRabbit\n  Dev->>OR: Submit Pull Request\n  OR-->>Dev: Walkthrough & Inline Review`;
  }

  const lines: string[] = ['sequenceDiagram', '  autonumber', '  actor Caller as Caller / Client'];

  const topFiles = files.slice(0, 4);
  topFiles.forEach((f, idx) => {
    const shortName = f.newPath.split('/').pop() || f.newPath;
    const participantId = `M${idx}_${sanitizeMermaidId(shortName)}`;
    lines.push(`  participant ${participantId} as ${shortName}`);
  });

  for (let i = 0; i < topFiles.length; i++) {
    const f = topFiles[i];
    const shortName = f.newPath.split('/').pop() || f.newPath;
    const participantId = `M${i}_${sanitizeMermaidId(shortName)}`;
    const symbolLabel =
      f.symbolsChanged.length > 0
        ? `${f.symbolsChanged[0]}()`
        : `${summaries[i]?.status || 'update'} (+${f.additions}/-${f.deletions})`;

    if (i === 0) {
      lines.push(`  Caller->>+${participantId}: Invoke ${symbolLabel}`);
    } else {
      const prevShort = topFiles[i - 1].newPath.split('/').pop() || topFiles[i - 1].newPath;
      const prevId = `M${i - 1}_${sanitizeMermaidId(prevShort)}`;
      lines.push(`  ${prevId}->>+${participantId}: Call ${symbolLabel}`);
    }
  }

  for (let i = topFiles.length - 1; i >= 0; i--) {
    const f = topFiles[i];
    const shortName = f.newPath.split('/').pop() || f.newPath;
    const participantId = `M${i}_${sanitizeMermaidId(shortName)}`;
    if (i === 0) {
      lines.push(`  ${participantId}-->>-Caller: Return result`);
    } else {
      const prevShort = topFiles[i - 1].newPath.split('/').pop() || topFiles[i - 1].newPath;
      const prevId = `M${i - 1}_${sanitizeMermaidId(prevShort)}`;
      lines.push(`  ${participantId}-->>-${prevId}: Propagate state`);
    }
  }

  return lines.join('\n');
}

function generateRabbitPoem(
  files: FileDiff[],
  criticalCount: number,
  warningCount: number
): string {
  const firstFile = files[0]?.newPath.split('/').pop() || 'the codebase';
  if (criticalCount > 0) {
    return [
      `A twitch of the ear at \`${firstFile}\` in flight,`,
      `Green lines of ambition, bold changes in sight—`,
      `Yet traps in the burrow lurk under the clover,`,
      `Let's patch up the hazards before hopping over! 🐇🛡️`,
    ].join('\n');
  }
  if (warningCount > 0) {
    return [
      `Through hunks of \`${firstFile}\` the swift rabbit hops,`,
      `Inspecting each promise and loop before stops.`,
      `A few gentle tweaks make the burrow secure—`,
      `Commit the suggestions for code clean and pure! 🐇✨`,
    ].join('\n');
  }
  return [
    `Across \`${firstFile}\` the fresh patches gleam,`,
    `As crisp as a carrot beside a clear stream.`,
    `No tangles or snares in the logic we find—`,
    `Hop onward to merge with a confident mind! 🐇🥕`,
  ].join('\n');
}
