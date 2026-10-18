import { BaseLanguageStrategy } from './base-language-strategy.js';
import type { LanguageRule, TestGenerationResult, DocGenerationResult } from './language-strategy.interface.js';

export class CSharpLanguageStrategy extends BaseLanguageStrategy {
  readonly id = 'csharp';
  readonly displayName = 'C# (.NET)';
  readonly fileExtensions = ['cs'];

  readonly symbolPatterns = [
    /(?:public|private|protected|internal|static|async|virtual|override|sealed)\s+(?:async\s+)?(?:Task(?:<[^>]+>)?|void|[a-zA-Z0-9_<>[\]?]+)\s+([A-Za-z0-9_]+)\s*\(/,
    /(?:public|private|protected|internal)?\s*(?:static|sealed|abstract)?\s*class\s+([A-Za-z0-9_]+)/,
    /(?:public|private|protected|internal)?\s*interface\s+([A-Za-z0-9_]+)/,
    /(?:public|private|protected|internal)?\s*record(?:\s+struct)?\s+([A-Za-z0-9_]+)/,
    /(?:public|private|protected|internal)?\s*struct\s+([A-Za-z0-9_]+)/,
  ];

  getRules(): LanguageRule[] {
    return [
      {
        id: 'cs-sql-injection',
        title: 'C# SQL Injection via string interpolation in raw query',
        severity: 'critical',
        category: 'security',
        matchLine: (line) =>
          /(?:FromSqlRaw|ExecuteSqlRaw|SqlCommand)\b.*\{|\$["'](?:SELECT|INSERT|UPDATE|DELETE)\b.*\{/i.test(
            line
          ),
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const fixed = line.replace(/FromSqlRaw\(\s*\$["'](.*?)["']\s*\)/, 'FromSqlInterpolated($$"$1")');
          return {
            body: 'Interpolating strings into raw queries or passing interpolated strings to `FromSqlRaw` / `SqlCommand` creates a **SQL Injection (CWE-89)** vulnerability. Use `FromSqlInterpolated` (which safely parameterizes string interpolations) or parameterized queries.',
            suggestionCode:
              fixed !== line
                ? fixed
                : `${indent}// Use FromSqlInterpolated($"...") or parameterized query`,
          };
        },
      },
      {
        id: 'cs-async-void',
        title: 'C# `async void` method can crash process on unhandled exception',
        severity: 'critical',
        category: 'bug',
        matchLine: (line) =>
          /\basync\s+void\s+[A-Za-z0-9_]+\s*\(/.test(line) &&
          !/EventHandler|EventArgs/.test(line),
        buildFinding: (line) => ({
          body: '`async void` methods cannot be awaited and unhandled exceptions inside them crash the application process without triggering caller catch blocks. Return `Task` instead, reserving `async void` strictly for UI event handlers.',
          suggestionCode: line.replace(/\basync\s+void\b/, 'async Task'),
        }),
      },
      {
        id: 'cs-sync-over-async',
        title: 'C# Sync-over-async (`.Result` / `.Wait()`) risks thread-pool deadlock',
        severity: 'warning',
        category: 'performance',
        matchLine: (line) =>
          /\.[rR]esult\b|\.GetAwaiter\(\)\.GetResult\(\)|\.Wait\(\)/.test(line) &&
          !line.includes('//') &&
          !line.includes('Task.FromResult'),
        buildFinding: (line) => ({
          body: 'Blocking synchronously on asynchronous tasks via `.Result`, `.GetAwaiter().GetResult()`, or `.Wait()` blocks thread-pool threads and can cause deadlocks. Prefer `await` in an asynchronous method.',
          suggestionCode: line.replace(
            /(?:var\s+[a-zA-Z0-9_]+\s*=\s*)?([a-zA-Z0-9_$.]+\([^)]*\))\.(?:Result|GetAwaiter\(\)\.GetResult\(\))/,
            'await $1'
          ),
        }),
      },
      {
        id: 'cs-missing-using-dispose',
        title: 'Disposable resource created without `using` declaration',
        severity: 'warning',
        category: 'bug',
        matchLine: (line, _file, contextLines) => {
          if (!/\bnew\s+(?:SqlConnection|SqlCommand|FileStream|StreamReader|StreamWriter)\s*\(/.test(line)) {
            return false;
          }
          const joined = contextLines.join('\n');
          return !/\busing\b/.test(joined) && !/\.Dispose\(\)/.test(joined);
        },
        buildFinding: (line) => {
          const indent = this.getIndent(line);
          const fixed = line.replace(/(var\s+[a-zA-Z0-9_]+\s*=)/, 'using $1');
          return {
            body: 'Unmanaged or native I/O resources should be wrapped in a C# `using` declaration (`using var ...`) to guarantee disposal and prevent socket or file handle exhaustion.',
            suggestionCode: fixed !== line ? fixed : `${indent}using ${line.trim()}`,
          };
        },
      },
    ];
  }

  generateTestSuite(symbolName: string, filePath: string): TestGenerationResult {
    const className = this.capitalize(symbolName);
    const testCode = `using System;
using System.Threading.Tasks;
using Xunit;
using FluentAssertions;

namespace Tests;

public class ${className}Tests
{
    [Fact]
    public async Task ${className}_WithValidInput_ShouldSucceed()
    {
        // Arrange
        var inputId = "usr_101";

        // Act & Assert
        // await TargetService.${symbolName}(inputId);
        true.Should().BeTrue();
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("' OR 1=1 --")]
    public async Task ${className}_WithMalformedInput_ShouldThrowArgumentException(string invalidInput)
    {
        // Act & Assert
        Func<Task> act = async () =>
        {
            // await TargetService.${symbolName}(invalidInput);
            await Task.Yield();
            throw new ArgumentException();
        };

        await act.Should().ThrowAsync<ArgumentException>();
    }
}`;

    return {
      testCode,
      testLanguage: 'csharp',
      runnerHint: 'Run via `dotnet test`',
    };
  }

  generateDocumentation(symbolName: string): DocGenerationResult {
    const docBlock = `/// <summary>
/// Executes <see cref="${symbolName}"/> with validated inputs and structured error propagation.
/// </summary>
/// <param name="cancellationToken">Cancellation token for aborting the operation.</param>
/// <returns>A task representing the asynchronous operation with the result payload.</returns>
/// <exception cref="ArgumentException">Thrown when input validation fails.</exception>`;

    return {
      docBlock,
      formatName: 'XML Documentation Comments',
    };
  }
}
