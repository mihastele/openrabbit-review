import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileDiff, InlineFinding, OpenRabbitConfig } from '../../types/index.js';

const execFileAsync = promisify(nodeExecFile);

export type ScannerCategory = 'sast' | 'sca' | 'secrets' | 'iac';

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface ScanContext {
  repoPath: string;
  files: FileDiff[];
  timeoutMs: number;
  diffOnly: boolean;
  config?: OpenRabbitConfig;
  execFile?: ExecFileFn;
}

export interface SecurityScannerAdapter {
  readonly id: 'semgrep' | 'trivy' | 'gitleaks';
  readonly name: string;
  readonly category: ScannerCategory;
  isAvailable(execFile?: ExecFileFn): Promise<boolean>;
  scan(context: ScanContext): Promise<InlineFinding[]>;
}

/** Default execFile wrapper with generous buffer for JSON scanner output. */
export const defaultExecFile: ExecFileFn = async (file, args, options) => {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
};

/** Checks whether a CLI scanner binary is callable via `--version` (or `version`). */
export async function checkBinaryAvailable(
  binary: string,
  versionArg: string = '--version',
  execFile: ExecFileFn = defaultExecFile
): Promise<boolean> {
  try {
    await execFile(binary, [versionArg], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes a scanner CLI that may exit non-zero when findings are discovered
 * (e.g., gitleaks returns exit code 1 when leaks are found).
 */
export async function execScannerCommand(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  allowedExitCodes: number[] = [0],
  execFile: ExecFileFn = defaultExecFile
): Promise<string> {
  try {
    const { stdout } = await execFile(binary, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (
      typeof err?.code === 'number' &&
      allowedExitCodes.includes(err.code) &&
      typeof err?.stdout === 'string'
    ) {
      return err.stdout;
    }
    throw err;
  }
}

/** Normalizes a scanner-reported path to a POSIX repo-relative path. */
export function normalizeScannerPath(filePath: string, repoPath: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.relative(repoPath, filePath)
    : filePath;
  return resolved.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Redacts secret values before storing or posting PR comments. */
export function redactSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 6) return '***REDACTED***';
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

/**
 * Filters findings to changed files (and changed lines when `diffOnly` is true
 * and the finding has a specific line number).
 */
export function filterFindingsToDiff(
  findings: InlineFinding[],
  files: FileDiff[],
  diffOnly: boolean
): InlineFinding[] {
  if (!diffOnly) return findings;
  const fileLineMap = new Map<string, Set<number>>();
  for (const f of files) {
    const lineSet = new Set<number>();
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type === 'add' && l.newLineNumber !== undefined) {
          lineSet.add(l.newLineNumber);
        }
      }
    }
    fileLineMap.set(f.newPath.replace(/\\/g, '/').replace(/^\.\//, ''), lineSet);
  }

  return findings.filter((finding) => {
    const norm = finding.file.replace(/\\/g, '/').replace(/^\.\//, '');
    const lineSet = fileLineMap.get(norm);
    if (!lineSet) return false;
    // Lockfile/SCA findings at line 1 apply to the whole modified file
    if (finding.startLine <= 1 && lineSet.size > 0) return true;
    return lineSet.has(finding.startLine);
  });
}
