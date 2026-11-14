import type { FileDiff, InlineFinding, OpenRabbitConfig } from '../../types/index.js';
import { gitleaksAdapter } from './gitleaks-adapter.js';
import {
  filterFindingsToDiff,
  type ExecFileFn,
  type ScanContext,
  type SecurityScannerAdapter,
} from './scanner.interface.js';
import { semgrepAdapter } from './semgrep-adapter.js';
import { trivyAdapter } from './trivy-adapter.js';

export const DEFAULT_SECURITY_SCANNERS: SecurityScannerAdapter[] = [
  semgrepAdapter,
  trivyAdapter,
  gitleaksAdapter,
];

export interface ScannerRunResult {
  findings: InlineFinding[];
  scannersRun: string[];
  scannersSkipped: string[];
  errors: { scannerId: string; message: string }[];
}

/**
 * Runs configured & available FOSS security scanners in parallel, normalizes
 * findings to diff lines (when `diff_only` is enabled), and deduplicates results.
 */
export async function runSecurityScanners(
  options: {
    repoPath: string;
    files: FileDiff[];
    config: OpenRabbitConfig;
    execFile?: ExecFileFn;
    adapters?: SecurityScannerAdapter[];
  }
): Promise<ScannerRunResult> {
  const scannerCfg = options.config.security_scanners;
  if (scannerCfg && scannerCfg.enabled === false) {
    return {
      findings: [],
      scannersRun: [],
      scannersSkipped: (options.adapters || DEFAULT_SECURITY_SCANNERS).map((a) => a.id),
      errors: [],
    };
  }

  const adapters = options.adapters || DEFAULT_SECURITY_SCANNERS;
  const timeoutMs = scannerCfg?.timeout_ms ?? 30000;
  const diffOnly = scannerCfg?.diff_only ?? true;

  const context: ScanContext = {
    repoPath: options.repoPath,
    files: options.files,
    timeoutMs,
    diffOnly,
    config: options.config,
    execFile: options.execFile,
  };

  const scannersRun: string[] = [];
  const scannersSkipped: string[] = [];
  const errors: { scannerId: string; message: string }[] = [];

  const activeAdapters: SecurityScannerAdapter[] = [];
  for (const adapter of adapters) {
    const enabledForId = scannerCfg ? scannerCfg[adapter.id] !== false : true;
    if (!enabledForId) {
      scannersSkipped.push(adapter.id);
      continue;
    }
    const available = await adapter.isAvailable(options.execFile);
    if (!available) {
      scannersSkipped.push(adapter.id);
      continue;
    }
    activeAdapters.push(adapter);
  }

  const settled = await Promise.allSettled(
    activeAdapters.map(async (adapter) => ({
      id: adapter.id,
      findings: await adapter.scan(context),
    }))
  );

  const rawFindings: InlineFinding[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const adapter = activeAdapters[i];
    if (result.status === 'fulfilled') {
      scannersRun.push(adapter.id);
      rawFindings.push(...result.value.findings);
    } else {
      scannersSkipped.push(adapter.id);
      errors.push({
        scannerId: adapter.id,
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  const scoped = filterFindingsToDiff(rawFindings, options.files, diffOnly);
  const seen = new Set<string>();
  const deduped: InlineFinding[] = [];
  for (const f of scoped) {
    const key = `${f.file}:${f.startLine}:${f.ruleMatched || f.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  return {
    findings: deduped,
    scannersRun,
    scannersSkipped,
    errors,
  };
}
