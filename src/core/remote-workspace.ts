import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RemoteWorkspaceOptions {
  cloneUrl: string;
  ref: string;
  providerHost: string;
  auth?: { username: string; password: string };
  timeoutMs?: number;
  allowFileProtocol?: boolean;
}

export interface RemoteWorkspace {
  path: string;
}

function validateRemoteUrl(options: RemoteWorkspaceOptions): URL {
  let url: URL;
  try {
    url = new URL(options.cloneUrl);
  } catch {
    throw new Error('Invalid remote repository URL');
  }

  if (options.allowFileProtocol && url.protocol === 'file:') return url;
  if (url.protocol !== 'https:') {
    throw new Error(`Remote repository protocol is not allowed: ${url.protocol}`);
  }
  if (
    url.hostname !== options.providerHost &&
    url.host !== options.providerHost
  ) {
    throw new Error(
      `Remote repository host is not allowed: ${url.host} (expected ${options.providerHost})`
    );
  }
  if (url.username || url.password) {
    throw new Error('Remote repository URL must not contain credentials');
  }
  return url;
}

function validateRef(ref: string): void {
  if (
    !/^(refs\/[A-Za-z0-9._/-]+|[a-f0-9]{7,64})$/i.test(ref) ||
    ref.includes('..') ||
    ref.startsWith('-')
  ) {
    throw new Error('Invalid remote Git reference');
  }
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<void> {
  try {
    await execFileAsync('git', args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Remote Git checkout failed: ${message.split('\n')[0]}`);
  }
}

export async function withRemoteWorkspace<T>(
  options: RemoteWorkspaceOptions,
  callback: (workspace: RemoteWorkspace) => Promise<T>
): Promise<T> {
  validateRemoteUrl(options);
  validateRef(options.ref);

  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 60_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openrabbit-remote-'));
  const repoPath = path.join(root, 'repo');
  let askpassPath: string | undefined;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
  };

  if (options.auth) {
    askpassPath = path.join(root, 'askpass.sh');
    fs.writeFileSync(
      askpassPath,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$OPENRABBIT_GIT_USERNAME" ;;\n  *) printf "%s\\n" "$OPENRABBIT_GIT_PASSWORD" ;;\nesac\n',
      { mode: 0o700 }
    );
    env.GIT_ASKPASS = askpassPath;
    env.GIT_ASKPASS_REQUIRE = 'force';
    env.OPENRABBIT_GIT_USERNAME = options.auth.username;
    env.OPENRABBIT_GIT_PASSWORD = options.auth.password;
  }

  try {
    fs.mkdirSync(repoPath);
    await git(['init', '--quiet'], repoPath, env, timeoutMs);
    await git(['remote', 'add', 'origin', options.cloneUrl], repoPath, env, timeoutMs);
    await git(
      ['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', options.ref],
      repoPath,
      env,
      timeoutMs
    );
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], repoPath, env, timeoutMs);
    return await callback({ path: repoPath });
  } catch (error) {
    if (options.auth?.password && error instanceof Error) {
      error.message = error.message.replaceAll(options.auth.password, '***');
    }
    throw error;
  } finally {
    if (askpassPath) fs.rmSync(askpassPath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function remoteMemoryFilePath(
  dataDir: string,
  source: string,
  repository: string
): string {
  const key = crypto
    .createHash('sha256')
    .update(`${source}:${repository}`)
    .digest('hex');
  return path.join(dataDir, 'memory', `${key}.json`);
}
