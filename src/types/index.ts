export type LLMProviderType =
  | 'auto'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'heuristic';

export type ReviewProfile = 'chill' | 'assertive' | 'security-focused';

export type ReviewSeverity =
  | 'critical'
  | 'warning'
  | 'suggestion'
  | 'nitpick'
  | 'praise';

export type ReviewCategory =
  | 'security'
  | 'bug'
  | 'performance'
  | 'maintainability'
  | 'type-safety'
  | 'logic'
  | 'architecture'
  | 'testing';

export interface PathInstruction {
  path: string;
  instructions: string;
}

export interface OpenRabbitConfig {
  language: string;
  profile: ReviewProfile;
  tone_instructions: string;
  early_access?: boolean;
  reviews: {
    high_level_summary: boolean;
    poem: boolean;
    review_status: boolean;
    collapse_walkthrough: boolean;
    sequence_diagrams: boolean;
    auto_review: {
      enabled: boolean;
      drafts: boolean;
      base_branches: string[];
    };
    path_filters: string[];
    path_instructions: PathInstruction[];
  };
  chat: {
    auto_reply: boolean;
  };
  llm: {
    provider: LLMProviderType;
    model?: string;
    temperature: number;
  };
}

export interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  sectionHeading?: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  language: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  rawPatch: string;
  symbolsChanged: string[];
}

export interface ParsedDiff {
  files: FileDiff[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
}

export interface FileWalkthroughSummary {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  component: string;
  summary: string;
  impact: 'low' | 'medium' | 'high';
}

export interface InlineFinding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  title: string;
  body: string;
  suggestionCode?: string;
  originalCode?: string;
  ruleMatched?: string;
}

export interface PRWalkthrough {
  title: string;
  executiveSummary: string;
  releaseNotes: {
    category: string;
    items: string[];
  }[];
  fileSummaries: FileWalkthroughSummary[];
  mermaidDiagram: string;
  poem: string;
  effortScore: 1 | 2 | 3 | 4 | 5;
  estimatedMinutes: number;
  riskLevel: 'low' | 'moderate' | 'high' | 'critical';
  securityConcerns: string[];
}

export interface ReviewResult {
  id: string;
  createdAt: string;
  source: 'cli' | 'github' | 'gitlab' | 'bitbucket' | 'playground';
  repository: string;
  prNumber?: number;
  prTitle: string;
  author?: string;
  baseBranch?: string;
  headBranch?: string;
  commitSha?: string;
  providerUsed: string;
  modelUsed: string;
  durationMs: number;
  stats: {
    filesReviewed: number;
    additions: number;
    deletions: number;
    findingsCount: number;
    criticalCount: number;
    warningCount: number;
    suggestionCount: number;
    nitpickCount: number;
    praiseCount: number;
  };
  walkthrough: PRWalkthrough;
  findings: InlineFinding[];
  markdownWalkthrough: string;
  rawDiff?: string;
}

export type ChatCommandType =
  | 'explain'
  | 'test'
  | 'fix'
  | 'docstring'
  | 'summary'
  | 'config'
  | 'resolve'
  | 'question';

export interface ChatRequest {
  query: string;
  diff?: string;
  file?: string;
  line?: number;
  findingContext?: InlineFinding;
  prTitle?: string;
}

export interface ChatResponse {
  commandDetected: ChatCommandType;
  replyMarkdown: string;
  suggestedCode?: string;
  providerUsed: string;
  modelUsed: string;
}

export interface LocalRepoInfo {
  id: string;
  name: string;
  path: string;
  branch: string;
  remoteUrl?: string;
  isClean: boolean;
  headSha?: string;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  addedAt: string;
}

export interface LocalCommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  relativeDate?: string;
  subject: string;
  body?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

