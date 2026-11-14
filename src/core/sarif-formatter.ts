import type { InlineFinding, ReviewResult, ReviewSeverity } from '../types/index.js';

export type FailureThreshold = Exclude<ReviewSeverity, 'praise'> | 'none';

const severityRank: Record<ReviewSeverity, number> = {
  praise: 0, nitpick: 1, suggestion: 2, warning: 3, critical: 4,
};

export function exceedsFailureThreshold(
  findings: InlineFinding[],
  threshold: FailureThreshold
): boolean {
  return threshold !== 'none' && findings.some(
    (finding) => severityRank[finding.severity] >= severityRank[threshold]
  );
}

/** Export actionable findings as SARIF 2.1.0, with repository-relative URIs. */
export function formatSarifReport(review: ReviewResult) {
  const findings = review.findings.filter((finding) => finding.severity !== 'praise');
  const ruleId = (finding: InlineFinding) =>
    finding.ruleMatched || `openrabbit/${finding.category}`;
  const ruleIds = [...new Set(findings.map(ruleId))];
  const results = findings.map((finding) => {
    const normalizedPath = finding.file.replace(/\\/g, '/').replace(/^\.\//, '');
    const startLine = Number.isInteger(finding.startLine) && finding.startLine > 0
      ? finding.startLine : undefined;
    const endLine = startLine && Number.isInteger(finding.endLine) && finding.endLine >= startLine
      ? finding.endLine : startLine;
    return {
      ruleId: ruleId(finding),
      ruleIndex: ruleIds.indexOf(ruleId(finding)),
      level: finding.severity === 'critical' ? 'error'
        : finding.severity === 'warning' ? 'warning' : 'note',
      message: { text: `${finding.title}\n\n${finding.body}` },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: normalizedPath.split('/').map(encodeURIComponent).join('/') },
          ...(startLine ? { region: { startLine, endLine } } : {}),
        },
      }],
      properties: { severity: finding.severity, category: finding.category },
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: {
        name: 'OpenRabbit',
        rules: ruleIds.map((id) => ({ id })),
      } },
      results,
    }],
  };
}
