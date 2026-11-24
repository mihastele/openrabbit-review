import crypto from 'node:crypto';
import type { InlineFinding } from '../../types/index.js';
import {
  checkBinaryAvailable,
  execScannerCommand,
  normalizeScannerPath,
  redactSecret,
  type ExecFileFn,
  type ScanContext,
  type SecurityScannerAdapter,
} from './scanner.interface.js';

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  EndLine?: number;
  Match?: string;
  Secret?: string;
}

/** Parses Gitleaks JSON report output into redacted OpenRabbit `InlineFinding[]`. */
export function parseGitleaksOutput(
  stdout: string,
  repoPath: string
): InlineFinding[] {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === 'null') return [];
  const parsed = JSON.parse(trimmed) as GitleaksFinding[];
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item) => typeof item.File === 'string')
    .map((item) => {
      const ruleId = item.RuleID || 'generic-secret';
      const startLine = Math.max(1, item.StartLine ?? 1);
      const endLine = Math.max(startLine, item.EndLine ?? startLine);
      const redacted = item.Secret ? redactSecret(item.Secret) : '***REDACTED***';

      return {
        id: `gitleaks-${crypto.randomUUID().slice(0, 8)}`,
        file: normalizeScannerPath(item.File!, repoPath),
        startLine,
        endLine,
        severity: 'critical' as const,
        category: 'security' as const,
        title: `Gitleaks: ${item.Description || ruleId}`,
        body: `Potential hardcoded secret detected (\`${redacted}\`). Rotate the credential immediately and move it to a secure secret manager or environment variable.\n\n*Detected by FOSS secret scanner: Gitleaks (\`${ruleId}\`).*`,
        ruleMatched: `gitleaks/${ruleId}`,
      };
    });
}

export const gitleaksAdapter: SecurityScannerAdapter = {
  id: 'gitleaks',
  name: 'Gitleaks (Secrets)',
  category: 'secrets',

  async isAvailable(execFile?: ExecFileFn): Promise<boolean> {
    return checkBinaryAvailable('gitleaks', 'version', execFile);
  },

  async scan(context: ScanContext): Promise<InlineFinding[]> {
    const args = [
      'detect',
      '--no-git',
      '--source',
      '.',
      '--report-format',
      'json',
      '--report-path',
      '-',
    ];
    const stdout = await execScannerCommand(
      'gitleaks',
      args,
      context.repoPath,
      context.timeoutMs,
      [0, 1],
      context.execFile
    );
    return parseGitleaksOutput(stdout, context.repoPath);
  },
};
