import crypto from 'node:crypto';
import type { InlineFinding, ReviewSeverity } from '../../types/index.js';
import {
  checkBinaryAvailable,
  execScannerCommand,
  normalizeScannerPath,
  type ExecFileFn,
  type ScanContext,
  type SecurityScannerAdapter,
} from './scanner.interface.js';

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  end?: { line?: number };
  extra?: {
    message?: string;
    severity?: string;
    fix?: string;
    metadata?: {
      cwe?: string | string[];
      owasp?: string | string[];
      confidence?: string;
    };
  };
}

function mapSemgrepSeverity(raw?: string): ReviewSeverity {
  const upper = (raw || '').toUpperCase();
  if (upper === 'ERROR' || upper === 'CRITICAL' || upper === 'HIGH') {
    return 'critical';
  }
  if (upper === 'WARNING' || upper === 'MEDIUM') {
    return 'warning';
  }
  return 'suggestion';
}

/** Parses Semgrep `--json` output into normalized OpenRabbit `InlineFinding[]`. */
export function parseSemgrepOutput(
  stdout: string,
  repoPath: string
): InlineFinding[] {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as { results?: SemgrepResult[] };
  if (!Array.isArray(parsed.results)) return [];

  return parsed.results
    .filter((r) => typeof r.path === 'string' && typeof r.start?.line === 'number')
    .map((r) => {
      const checkId = r.check_id || 'semgrep.rule';
      const startLine = Math.max(1, r.start!.line!);
      const endLine = Math.max(startLine, r.end?.line ?? startLine);
      const cweList = Array.isArray(r.extra?.metadata?.cwe)
        ? r.extra!.metadata!.cwe
        : r.extra?.metadata?.cwe
          ? [r.extra.metadata.cwe]
          : [];
      const cweNote = cweList.length > 0 ? ` (${cweList.join(', ')})` : '';
      const message = r.extra?.message || 'Potential security issue detected by Semgrep.';

      return {
        id: `semgrep-${crypto.randomUUID().slice(0, 8)}`,
        file: normalizeScannerPath(r.path!, repoPath),
        startLine,
        endLine,
        severity: mapSemgrepSeverity(r.extra?.severity),
        category: 'security' as const,
        title: `Semgrep: ${checkId}${cweNote}`,
        body: `${message}\n\n*Detected by FOSS SAST scanner: Semgrep (\`${checkId}\`).*`,
        suggestionCode: r.extra?.fix || undefined,
        ruleMatched: `semgrep/${checkId}`,
      };
    });
}

export const semgrepAdapter: SecurityScannerAdapter = {
  id: 'semgrep',
  name: 'Semgrep (SAST)',
  category: 'sast',

  async isAvailable(execFile?: ExecFileFn): Promise<boolean> {
    return checkBinaryAvailable('semgrep', '--version', execFile);
  },

  async scan(context: ScanContext): Promise<InlineFinding[]> {
    const targetPaths = context.diffOnly
      ? context.files
          .filter((f) => f.status !== 'deleted')
          .map((f) => f.newPath)
      : ['.'];

    if (targetPaths.length === 0) return [];

    const args = [
      'scan',
      '--json',
      '--quiet',
      '--config',
      'auto',
      ...targetPaths,
    ];
    const stdout = await execScannerCommand(
      'semgrep',
      args,
      context.repoPath,
      context.timeoutMs,
      [0, 1],
      context.execFile
    );
    return parseSemgrepOutput(stdout, context.repoPath);
  },
};
