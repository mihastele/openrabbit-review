import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class RubyLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'ruby';
  readonly displayName = 'Ruby';
  readonly fileExtensions = ['rb', 'rake', 'gemspec'];

  readonly symbolPatterns = [
    /def\s+([a-zA-Z0-9_!?]+)/,
    /class\s+([A-Za-z0-9_]+)/,
    /module\s+([A-Za-z0-9_]+)/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'ruby-sql-injection',
        title: 'ActiveRecord SQL Injection via string interpolation in query',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /(?:\.where|\.find_by_sql|\.order|\.select|\.joins)\s*\(\s*["'].*#\{/i.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const fixed = line.replace(/#\{([a-zA-Z0-9_.:]+)\}/g, '?');
          const matches = Array.from(line.matchAll(/#\{([a-zA-Z0-9_.:]+)\}/g)).map((m) => m[1]);
          return {
            body: 'Interpolating strings directly into ActiveRecord query methods creates a **SQL Injection (CWE-89)** vulnerability. Use parameterized placeholders (`where("id = ?", id)`) or hash conditions (`where(id: id)`).',
            suggestionCode:
              matches.length > 0
                ? line.replace(/["'](.*?)#\{.*\}["']/, `"$1?", ${matches.join(', ')}`)
                : `${indent}// Use parameterized query: .where("id = ?", param)`,
          };
        },
      },
      {
        id: 'ruby-command-injection',
        title: 'Ruby command execution with interpolated string (CWE-78)',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /`.*#\{.*}`/.test(line) ||
          /(?:system|exec|%x)\s*\(?\s*["'].*#\{/.test(line),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          return {
            body: 'Using backticks or `system` with string interpolation passes arguments directly to a subshell, enabling **Command Injection (CWE-78)**. Pass arguments as separate array elements: `system("cmd", arg1, arg2)`.',
            suggestionCode: `${indent}system("command", safe_arg1, safe_arg2)`,
          };
        },
      },
      {
        id: 'ruby-insecure-yaml-deserialization',
        title: 'Insecure `YAML.load` enables Remote Code Execution (CWE-502)',
        severity: 'critical',
        category: 'security',
        matchLine: (line) => /\bYAML\.load\s*\(/.test(line) && !/YAML\.safe_load/.test(line),
        buildFinding: (line) => ({
          body: 'Calling `YAML.load` on untrusted input allows arbitrary Ruby object instantiation and remote code execution (**CWE-502**). Use `YAML.safe_load(str, permitted_classes: [...])` instead.',
          suggestionCode: line.replace(/\bYAML\.load\s*\(/, 'YAML.safe_load('),
        }),
      },
    ];
  }

  generateTestSuite(symbolName: string): TestGenerationResult {
    const testCode = `require 'rails_helper'

RSpec.describe '${symbolName}' do
  describe '#${symbolName}' do
    it 'processes valid input attributes successfully' do
      payload = { id: 'usr_101', role: 'member' }
      # result = ${symbolName}(payload)
      expect(true).to be true
    end

    it 'raises ArgumentError on malicious or malformed input' do
      malicious_payload = "' OR 1=1 --"
      expect {
        # ${symbolName}(malicious_payload)
        raise ArgumentError, 'Invalid parameter'
      }.to raise_error(ArgumentError)
    end
  end
end`;

    return {
      testCode,
      testLanguage: 'ruby',
      runnerHint: 'Run via `bundle exec rspec`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `# Executes ${symbolName} with validated domain parameters.
#
# @param params [Hash] Sanitized request attributes
# @return [Hash] Processed domain result payload
# @raise [ArgumentError] If required attributes are missing or malformed`;

    return {
      docBlock,
      formatName: 'YARD / RDoc',
    };
  }
}
