import type {
  InlineFinding,
  OpenRabbitConfig,
  PRWalkthrough,
  ReviewSeverity,
} from '../types/index.js';

export const WALKTHROUGH_COMMENT_MARKER = '<!-- openrabbit-walkthrough -->';

const SEVERITY_BADGES: Record<ReviewSeverity, { icon: string; label: string }> = {
  critical: { icon: '🛑', label: 'Critical' },
  warning: { icon: '⚠️', label: 'Warning' },
  suggestion: { icon: '💡', label: 'Suggestion' },
  nitpick: { icon: '🧹', label: 'Nitpick' },
  praise: { icon: '🙌', label: 'Praise' },
};

export function renderEffortBar(score: 1 | 2 | 3 | 4 | 5): string {
  const filled = '🟦'.repeat(score);
  const empty = '⬜'.repeat(5 - score);
  return `${filled}${empty} (${score}/5)`;
}

export function formatWalkthroughMarkdown(
  walkthrough: PRWalkthrough,
  findings: InlineFinding[],
  config: OpenRabbitConfig,
  meta?: { provider: string; model: string; durationMs: number }
): string {
  const actionableCount = findings.filter((f) => f.severity !== 'praise').length;
  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;

  const lines: string[] = [WALKTHROUGH_COMMENT_MARKER];
  lines.push(`## 🐇 OpenRabbit PR Walkthrough`);
  lines.push('');
  lines.push(walkthrough.executiveSummary);
  lines.push('');

  // Release Notes / Summary by Category
  if (walkthrough.releaseNotes && walkthrough.releaseNotes.length > 0) {
    lines.push(`### 📋 Summary by OpenRabbit`);
    for (const group of walkthrough.releaseNotes) {
      lines.push(`- **${group.category}**`);
      for (const item of group.items) {
        lines.push(`  - ${item}`);
      }
    }
    lines.push('');
  }

  // Review Status & Effort Header
  lines.push(
    `| Metric | Value |`
  );
  lines.push(`| :--- | :--- |`);
  lines.push(`| **Review Effort** | ${renderEffortBar(walkthrough.effortScore)} (~${walkthrough.estimatedMinutes} min) |`);
  lines.push(
    `| **Risk Assessment** | **${walkthrough.riskLevel.toUpperCase()}** ${
      criticalCount > 0
        ? `(${criticalCount} critical, ${warningCount} warnings)`
        : warningCount > 0
        ? `(${warningCount} warnings)`
        : '(No blocking issues)'
    } |`
  );
  lines.push(
    `| **Actionable Comments** | **${actionableCount}** inline finding${
      actionableCount === 1 ? '' : 's'
    } |`
  );
  if (meta) {
    lines.push(
      `| **Engine** | \`${meta.provider}/${meta.model}\` (${(
        meta.durationMs / 1000
      ).toFixed(2)}s) |`
    );
  }
  lines.push('');

  // Collapsible Walkthrough details
  const openAttr = config.reviews.collapse_walkthrough ? '' : ' open';
  lines.push(`<details${openAttr}>`);
  lines.push(`<summary><strong>🧭 Detailed File Walkthrough (${walkthrough.fileSummaries.length} files)</strong></summary>`);
  lines.push('');
  lines.push(`| File | Component | Changes | Impact | Summary |`);
  lines.push(`| :--- | :--- | :---: | :---: | :--- |`);
  for (const f of walkthrough.fileSummaries) {
    const impactIcon =
      f.impact === 'high' ? '🔴 High' : f.impact === 'medium' ? '🟡 Med' : '🟢 Low';
    lines.push(
      `| \`${f.path}\` | ${f.component} | \`+${f.additions}/-${f.deletions}\` | ${impactIcon} | ${f.summary} |`
    );
  }
  lines.push('');
  lines.push(`</details>`);
  lines.push('');

  // Mermaid Sequence Diagram
  if (config.reviews.sequence_diagrams && walkthrough.mermaidDiagram) {
    lines.push(`<details open>`);
    lines.push(`<summary><strong>🔄 Sequence Diagram</strong></summary>`);
    lines.push('');
    lines.push('```mermaid');
    lines.push(walkthrough.mermaidDiagram.trim());
    lines.push('```');
    lines.push('');
    lines.push(`</details>`);
    lines.push('');
  }

  // Security callout if any
  if (walkthrough.securityConcerns && walkthrough.securityConcerns.length > 0) {
    lines.push(`> [!WARNING]`);
    lines.push(`> **Security Advisories Detected**`);
    for (const sec of walkthrough.securityConcerns) {
      lines.push(`> - ${sec}`);
    }
    lines.push('');
  }

  // Poem
  if (config.reviews.poem && walkthrough.poem) {
    lines.push(`### 🥕 Poem`);
    for (const poemLine of walkthrough.poem.split('\n')) {
      lines.push(`> ${poemLine}`);
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(
    `<sub>💬 **Tip:** Mention \`@openrabbit explain\`, \`@openrabbit test\`, \`@openrabbit fix\`, or ask any question in a review comment! Configured via \`.openrabbit.yaml\`.</sub>`
  );

  return lines.join('\n');
}

/**
 * Formats an individual inline finding as a GitHub/GitLab PR review comment
 * with a one-click committable suggestion block.
 */
export function formatInlineCommentMarkdown(
  finding: InlineFinding,
  platform: 'github' | 'gitlab' = 'github'
): string {
  const sev = SEVERITY_BADGES[finding.severity] || SEVERITY_BADGES.suggestion;
  const lines: string[] = [];

  lines.push(
    `${sev.icon} **${sev.label}** · \`[${finding.category}]\` — **${finding.title}**`
  );
  lines.push('');
  lines.push(finding.body);

  if (finding.suggestionCode && finding.suggestionCode.trim().length > 0) {
    lines.push('');
    lines.push('**📝 Committable Suggestion:**');
    if (platform === 'gitlab') {
      lines.push('```suggestion:-0+0');
    } else {
      lines.push('```suggestion');
    }
    lines.push(finding.suggestionCode);
    lines.push('```');
  }

  lines.push('');
  lines.push(
    `<sub>🤖 *OpenRabbit${
      finding.ruleMatched ? ` · Rule \`${finding.ruleMatched}\`` : ''
    } · Reply \`@openrabbit explain\` or \`@openrabbit test\`*</sub>`
  );

  return lines.join('\n');
}
