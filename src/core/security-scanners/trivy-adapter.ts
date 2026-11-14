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

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
}

interface TrivyMisconfig {
  ID?: string;
  Title?: string;
  Description?: string;
  Message?: string;
  Resolution?: string;
  Severity?: string;
  CauseMetadata?: {
    StartLine?: number;
    EndLine?: number;
  };
}

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Misconfigurations?: TrivyMisconfig[];
}

function mapTrivySeverity(raw?: string): ReviewSeverity {
  const upper = (raw || '').toUpperCase();
  if (upper === 'CRITICAL' || upper === 'HIGH') return 'critical';
  if (upper === 'MEDIUM') return 'warning';
  return 'suggestion';
}

/** Parses Trivy `fs --format json` output into normalized OpenRabbit `InlineFinding[]`. */
export function parseTrivyOutput(
  stdout: string,
  repoPath: string
): InlineFinding[] {
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as { Results?: TrivyResult[] };
  if (!Array.isArray(parsed.Results)) return [];

  const findings: InlineFinding[] = [];
  for (const result of parsed.Results) {
    if (!result.Target) continue;
    const file = normalizeScannerPath(result.Target, repoPath);

    for (const vuln of result.Vulnerabilities || []) {
      const id = vuln.VulnerabilityID || 'CVE-UNKNOWN';
      const pkg = vuln.PkgName || 'unknown-package';
      const installed = vuln.InstalledVersion ? `@${vuln.InstalledVersion}` : '';
      const fixHint = vuln.FixedVersion
        ? `Upgrade \`${pkg}\` to \`${vuln.FixedVersion}\` or later.`
        : 'No fixed version reported yet; review mitigation or transitive usage.';
      const refLink = vuln.PrimaryURL ? `\nReference: ${vuln.PrimaryURL}` : '';

      findings.push({
        id: `trivy-vuln-${crypto.randomUUID().slice(0, 8)}`,
        file,
        startLine: 1,
        endLine: 1,
        severity: mapTrivySeverity(vuln.Severity),
        category: 'security',
        title: `Trivy SCA: ${id} in ${pkg}${installed}`,
        body: `${vuln.Title || vuln.Description || 'Vulnerable dependency detected.'}\n\n**Remediation:** ${fixHint}${refLink}\n\n*Detected by FOSS SCA scanner: Trivy (\`${id}\`).*`,
        ruleMatched: `trivy/${id}`,
      });
    }

    for (const misconfig of result.Misconfigurations || []) {
      const id = misconfig.ID || 'AVD-UNKNOWN';
      const startLine = Math.max(1, misconfig.CauseMetadata?.StartLine ?? 1);
      const endLine = Math.max(startLine, misconfig.CauseMetadata?.EndLine ?? startLine);

      findings.push({
        id: `trivy-iac-${crypto.randomUUID().slice(0, 8)}`,
        file,
        startLine,
        endLine,
        severity: mapTrivySeverity(misconfig.Severity),
        category: 'security',
        title: `Trivy IaC: ${misconfig.Title || id}`,
        body: `${misconfig.Message || misconfig.Description || 'Infrastructure misconfiguration detected.'}\n\n**Resolution:** ${misconfig.Resolution || 'Review resource configuration.'}\n\n*Detected by FOSS IaC scanner: Trivy (\`${id}\`).*`,
        ruleMatched: `trivy/${id}`,
      });
    }
  }

  return findings;
}

export const trivyAdapter: SecurityScannerAdapter = {
  id: 'trivy',
  name: 'Trivy (SCA & IaC)',
  category: 'sca',

  async isAvailable(execFile?: ExecFileFn): Promise<boolean> {
    return checkBinaryAvailable('trivy', '--version', execFile);
  },

  async scan(context: ScanContext): Promise<InlineFinding[]> {
    const args = [
      'fs',
      '--format',
      'json',
      '--quiet',
      '--scanners',
      'vuln,misconfig',
      '.',
    ];
    const stdout = await execScannerCommand(
      'trivy',
      args,
      context.repoPath,
      context.timeoutMs,
      [0],
      context.execFile
    );
    return parseTrivyOutput(stdout, context.repoPath);
  },
};
