import fs from 'node:fs';
import path from 'node:path';

export interface RepoMemory {
  ignoredRules: string[];
  instructions: string[];
  updatedAt: string;
}

export const MEMORY_FILENAME = '.openrabbit-memory.json';

export function resolveMemoryFilePath(repoPath?: string, explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  return path.join(repoPath || process.cwd(), MEMORY_FILENAME);
}

export function loadRepoMemory(filePath: string): RepoMemory {
  if (!fs.existsSync(filePath)) {
    return { ignoredRules: [], instructions: [], updatedAt: new Date().toISOString() };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RepoMemory>;
    return {
      ignoredRules: Array.isArray(parsed.ignoredRules)
        ? parsed.ignoredRules.filter((x): x is string => typeof x === 'string')
        : [],
      instructions: Array.isArray(parsed.instructions)
        ? parsed.instructions.filter((x): x is string => typeof x === 'string')
        : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { ignoredRules: [], instructions: [], updatedAt: new Date().toISOString() };
  }
}

export function saveRepoMemory(filePath: string, memory: RepoMemory): RepoMemory {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const updated: RepoMemory = {
    ignoredRules: [...new Set(memory.ignoredRules)],
    instructions: [...new Set(memory.instructions)],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function addIgnoredRuleToMemory(filePath: string, ruleId: string): RepoMemory {
  const current = loadRepoMemory(filePath);
  const trimmed = ruleId.trim();
  if (trimmed && !current.ignoredRules.includes(trimmed)) {
    current.ignoredRules.push(trimmed);
  }
  return saveRepoMemory(filePath, current);
}

export function addInstructionToMemory(filePath: string, instruction: string): RepoMemory {
  const current = loadRepoMemory(filePath);
  const trimmed = instruction.trim();
  if (trimmed && !current.instructions.includes(trimmed)) {
    current.instructions.push(trimmed);
  }
  return saveRepoMemory(filePath, current);
}
