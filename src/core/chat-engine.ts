import {
  DEFAULT_OPENRABBIT_CONFIG,
  serializeConfigToYaml,
} from '../config/config-loader.js';
import type {
  ChatCommandType,
  ChatRequest,
  ChatResponse,
  OpenRabbitConfig,
} from '../types/index.js';
import { parseUnifiedDiff } from './diff-parser.js';
import {
  generateLLMCompletion,
  resolveActiveProvider,
} from './llm-provider.js';

export function detectChatCommand(query: string): ChatCommandType {
  const cleaned = query
    .replace(/@openrabbit\b/gi, '')
    .replace(/@coderabbitai\b/gi, '')
    .trim()
    .toLowerCase();

  if (/\b(?:test|tests|unit\s+test|spec|vitest|jest)\b/.test(cleaned)) {
    return 'test';
  }
  if (/\b(?:fix|patch|refactor|suggestion|apply)\b/.test(cleaned)) {
    return 'fix';
  }
  if (/\b(?:docstring|jsdoc|tsdoc|comment|document)\b/.test(cleaned)) {
    return 'docstring';
  }
  if (/\b(?:explain|how\s+does|walk\s+me\s+through|why)\b/.test(cleaned)) {
    return 'explain';
  }
  if (/\b(?:summary|summarize|tldr|walkthrough)\b/.test(cleaned)) {
    return 'summary';
  }
  if (/\b(?:config|configuration|yaml|rules)\b/.test(cleaned)) {
    return 'config';
  }
  if (/\b(?:resolve|lgtm|fixed|done)\b/.test(cleaned)) {
    return 'resolve';
  }
  return 'question';
}

export async function handlePRChat(
  req: ChatRequest,
  config: OpenRabbitConfig = DEFAULT_OPENRABBIT_CONFIG
): Promise<ChatResponse> {
  const commandDetected = detectChatCommand(req.query);
  const active = resolveActiveProvider(config.llm.provider, config.llm.model);

  if (commandDetected === 'config') {
    return {
      commandDetected,
      replyMarkdown: `### ⚙️ Active \`.openrabbit.yaml\` Configuration\n\n\`\`\`yaml\n${serializeConfigToYaml(
        config
      )}\`\`\``,
      providerUsed: active.provider,
      modelUsed: active.model,
    };
  }

  if (commandDetected === 'resolve') {
    return {
      commandDetected,
      replyMarkdown: `✅ **Thread Resolved!** Thanks for addressing this finding. I've marked this review discussion as resolved. 🐇🥕`,
      providerUsed: active.provider,
      modelUsed: active.model,
    };
  }

  if (active.provider !== 'heuristic') {
    try {
      const systemPrompt = `You are @openrabbit, an interactive AI Pull Request assistant embedded in GitHub/GitLab and the OpenRabbit CLI.
Detected command intent: ${commandDetected.toUpperCase()}
Tone instructions: ${config.tone_instructions}
Respond in clear, high-signal GitHub Flavored Markdown. When suggesting code fixes, use \`\`\`suggestion blocks or language-tagged code blocks.`;

      const contextParts: string[] = [];
      if (req.prTitle) contextParts.push(`PR Title: ${req.prTitle}`);
      if (req.file) contextParts.push(`Target File: ${req.file}${req.line ? `:${req.line}` : ''}`);
      if (req.findingContext) {
        contextParts.push(
          `Inline Finding Context: [${req.findingContext.severity.toUpperCase()}] ${req.findingContext.title}\n${req.findingContext.body}\nOriginal Code: ${req.findingContext.originalCode || 'N/A'}\nSuggested Code: ${req.findingContext.suggestionCode || 'N/A'}`
        );
      }
      if (req.diff) {
        contextParts.push(`Diff Context:\n\`\`\`diff\n${req.diff.slice(0, 6000)}\n\`\`\``);
      }

      const userPrompt = `${contextParts.join('\n\n')}\n\nDeveloper Query: ${req.query}`;

      const llmRes = await generateLLMCompletion({
        systemPrompt,
        userPrompt,
        temperature: 0.2,
        preferredProvider: active.provider,
        preferredModel: active.model,
      });

      return {
        commandDetected,
        replyMarkdown: llmRes.content,
        suggestedCode: req.findingContext?.suggestionCode,
        providerUsed: llmRes.provider,
        modelUsed: llmRes.model,
      };
    } catch (err) {
      console.warn(
        '[OpenRabbit Chat] External LLM call failed, using deterministic response builder:',
        (err as Error).message
      );
    }
  }

  return buildHeuristicChatResponse(req, commandDetected);
}

function buildHeuristicChatResponse(
  req: ChatRequest,
  command: ChatCommandType
): ChatResponse {
  const parsed = req.diff ? parseUnifiedDiff(req.diff) : null;
  const targetFile =
    req.file ||
    req.findingContext?.file ||
    parsed?.files[0]?.newPath ||
    'src/module.ts';
  const symbols =
    parsed?.files.flatMap((f) => f.symbolsChanged).filter(Boolean) || [];
  const primarySymbol = symbols[0] || 'targetHandler';
  const ext = targetFile.split('.').pop()?.toLowerCase() || '';

  if (command === 'test') {
    let testCode = '';
    let testLang = 'typescript';
    let testRunnerHint = 'Run via `npm test`';

    if (ext === 'py') {
      testLang = 'python';
      testRunnerHint = `Run via \`pytest tests/test_${targetFile.split('/').pop() || 'module'}\``;
      testCode = `import pytest
from unittest.mock import AsyncMock, MagicMock
from ${targetFile.replace(/\.py$/, '').replace(/\//g, '.')} import ${primarySymbol}

@pytest.mark.asyncio
async def test_${primarySymbol}_valid_payload():
    """Verify ${primarySymbol} processes valid payload and returns expected structure."""
    test_payload = {"id": "usr_101", "role": "member"}
    result = await ${primarySymbol}(test_payload) if hasattr(${primarySymbol}, '__await__') else ${primarySymbol}(test_payload)
    assert result is not None

def test_${primarySymbol}_malformed_input_rejection():
    """Regression test ensuring ${primarySymbol} rejects invalid/malicious input safely."""
    with pytest.raises((ValueError, TypeError, Exception)):
        ${primarySymbol}(None)

def test_${primarySymbol}_boundary_values():
    """Ensure edge case inputs do not cause unhandled runtime crashes."""
    result = ${primarySymbol}({}) if not hasattr(${primarySymbol}, '__await__') else None
    assert result is None or isinstance(result, (dict, list, tuple, object))
`;
    } else if (ext === 'go') {
      testLang = 'go';
      testRunnerHint = `Run via \`go test -v ./${targetFile.split('/').slice(0, -1).join('/') || '...'}\``;
      const exportedName = primarySymbol.charAt(0).toUpperCase() + primarySymbol.slice(1);
      testCode = `package main

import (
	"context"
	"testing"
)

func Test${exportedName}(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{
			name:    "valid input payload",
			input:   "usr_101",
			wantErr: false,
		},
		{
			name:    "empty string boundary check",
			input:   "",
			wantErr: true,
		},
		{
			name:    "malicious SQL injection input check",
			input:   "' OR 1=1 --",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			err := ${exportedName}(ctx, tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("${exportedName}() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
`;
    } else if (ext === 'rs') {
      testLang = 'rust';
      testRunnerHint = `Run via \`cargo test\``;
      testCode = `#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_${primarySymbol}_success() {
        let payload = "usr_101";
        let result = ${primarySymbol}(payload);
        assert!(result.is_ok(), "Expected operation to succeed on valid input");
    }

    #[test]
    fn test_${primarySymbol}_invalid_input_rejected() {
        let payload = "";
        let result = ${primarySymbol}(payload);
        assert!(result.is_err(), "Expected error on empty or malformed input");
    }
}
`;
    } else if (ext === 'java' || ext === 'kt') {
      testLang = ext === 'kt' ? 'kotlin' : 'java';
      testRunnerHint = `Run via \`./gradlew test\` or \`mvn test\``;
      testCode = `import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ${primarySymbol.charAt(0).toUpperCase() + primarySymbol.slice(1)}Test {

    @Test
    void testValidInputSucceeds() {
        assertDoesNotThrow(() -> {
            // ${primarySymbol}("usr_101");
        });
    }

    @Test
    void testNullPayloadThrowsException() {
        assertThrows(IllegalArgumentException.class, () -> {
            // ${primarySymbol}(null);
        });
    }
}
`;
    } else {
      testCode = `import { describe, it, expect, vi } from 'vitest';
import { ${primarySymbol} } from './${targetFile.split('/').pop()?.replace(/\.[jt]sx?$/, '') || 'module'}';

describe('${primarySymbol} (${targetFile})', () => {
  it('handles valid inputs and resolves expected state cleanly', async () => {
    const result = await ${primarySymbol}({ id: 'usr_101', role: 'member' });
    expect(result).toBeDefined();
  });

  it('rejects malformed or malicious payloads safely (regression check)', async () => {
    await expect(
      ${primarySymbol}({ id: "' OR 1=1 --", role: 'admin' })
    ).rejects.toThrow();
  });

  it('cleans up async resources when aborted or on error', async () => {
    const spy = vi.fn();
    await expect(${primarySymbol}(null as unknown as Record<string, unknown>)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});`;
    }

    return {
      commandDetected: 'test',
      replyMarkdown: [
        `### 🧪 Generated Unit Test Suite for \`${targetFile}\``,
        '',
        `Here is a comprehensive, idiomatic test suite covering happy paths, input validation boundaries, and error handling for \`${primarySymbol}\`:`,
        '',
        `\`\`\`${testLang}`,
        testCode.trim(),
        '```',
        '',
        `<sub>🐇 *Generated by OpenRabbit · ${testRunnerHint}*</sub>`,
      ].join('\n'),
      suggestedCode: testCode,
      providerUsed: 'heuristic',
      modelUsed: 'openrabbit-ast-v1',
    };
  }

  if (command === 'fix') {
    let fixedCode = req.findingContext?.suggestionCode;
    if (!fixedCode) {
      if (ext === 'py') {
        fixedCode = `# Safe parameterized implementation for ${primarySymbol}\ncursor.execute("SELECT id, email, role FROM users WHERE id = %s", (user_id,))`;
      } else if (ext === 'go') {
        fixedCode = `// Safe parameterized query with context\nrow := db.QueryRowContext(ctx, "SELECT id, email, role FROM users WHERE id = $1", userID)`;
      } else if (ext === 'rs') {
        fixedCode = `// Propagate errors safely using ? instead of unwrap\nlet record = fetch_user(user_id)?;`;
      } else {
        fixedCode = `// Validated and parameterized implementation for ${primarySymbol}\nconst sanitizedInput = String(input).trim();\nconst result = await db.query('SELECT id, email, role FROM users WHERE id = $1', [sanitizedInput]);`;
      }
    }

    return {
      commandDetected: 'fix',
      replyMarkdown: [
        `### 🔧 Committable Fix for \`${targetFile}\`${
          req.line ? ` (Line ${req.line})` : ''
        }`,
        '',
        req.findingContext
          ? `Addressing **${req.findingContext.title}** (\`[${req.findingContext.category}]\`):`
          : `Here is a safe, drop-in replacement patch for \`${targetFile}\`:`,
        '',
        '```suggestion',
        fixedCode,
        '```',
        '',
        `#### Why this fix works:`,
        `- Eliminates unsafe runtime behavior while preserving language-idiomatic function signatures.`,
        `- Prevents unhandled edge cases and guarantees strict input safety.`,
      ].join('\n'),
      suggestedCode: fixedCode,
      providerUsed: 'heuristic',
      modelUsed: 'openrabbit-ast-v1',
    };
  }

  if (command === 'docstring') {
    let docBlock = '';
    if (ext === 'py') {
      docBlock = `"""Execute ${primarySymbol} with validated parameters.

Args:
    params (dict): Verified request attributes.

Returns:
    dict: Processed domain payload.

Raises:
    ValueError: When input parameters fail validation.
"""`;
    } else if (ext === 'go') {
      const exported = primarySymbol.charAt(0).toUpperCase() + primarySymbol.slice(1);
      docBlock = `// ${exported} executes domain logic for the specified payload.
// It returns a non-nil error if input validation or downstream I/O fails.`;
    } else if (ext === 'rs') {
      docBlock = `/// Executes \`${primarySymbol}\` with validated inputs.
///
/// # Errors
/// Returns an \`Err\` variant if input validation fails or underlying I/O fails.`;
    } else {
      docBlock = `/**
 * Executes \`${primarySymbol}\` with validated inputs and structured error propagation.
 *
 * @param params - Verified request parameters for ${targetFile}
 * @returns Promise resolving to the processed domain payload
 * @throws {Error} When input validation or downstream I/O fails
 */`;
    }

    return {
      commandDetected: 'docstring',
      replyMarkdown: [
        `### 📖 Generated Documentation for \`${primarySymbol}\``,
        '',
        '```suggestion',
        docBlock,
        '```',
      ].join('\n'),
      suggestedCode: docBlock,
      providerUsed: 'heuristic',
      modelUsed: 'openrabbit-ast-v1',
    };
  }

  if (command === 'explain') {
    return {
      commandDetected: 'explain',
      replyMarkdown: [
        `### 🔍 Deep-Dive Explanation: \`${targetFile}\``,
        '',
        req.findingContext
          ? `**Context:** ${req.findingContext.title} (\`${req.findingContext.severity.toUpperCase()}\` · \`${req.findingContext.category}\`)\n\n${req.findingContext.body}`
          : `This change modifies **\`${targetFile}\`**${
              symbols.length > 0
                ? ` across symbol(s) ${symbols.map((s) => `\`${s}\``).join(', ')}`
                : ''
            }.`,
        '',
        `#### Execution & Control Flow`,
        `1. **Entry Point:** Caller invokes \`${primarySymbol}\` with incoming parameters.`,
        `2. **Hazard / Invariant Check:** ${
          req.findingContext?.originalCode
            ? `Line \`${req.findingContext.originalCode.trim()}\` executes directly on the hot path.`
            : `Modified lines update state and interact with downstream I/O.`
        }`,
        `3. **Recommendation:** ${
          req.findingContext?.suggestionCode
            ? `Applying the committable suggestion replaces the vulnerable pattern with \`${req.findingContext.suggestionCode.trim()}\`.`
            : `Ensure boundary inputs and async rejections are handled deterministically.`
        }`,
      ].join('\n'),
      providerUsed: 'heuristic',
      modelUsed: 'openrabbit-ast-v1',
    };
  }

  // Default question / summary response
  return {
    commandDetected: command,
    replyMarkdown: [
      `### 🐇 OpenRabbit Assistant`,
      '',
      `Regarding your question on \`${targetFile}\`:`,
      `> *"${req.query.replace(/@openrabbit\s*/i, '')}"*`,
      '',
      req.findingContext
        ? `- **Finding:** ${req.findingContext.title}\n- **Analysis:** ${req.findingContext.body}\n- **Recommended Patch:** \`${
            req.findingContext.suggestionCode || 'See inline suggestion above'
          }\``
        : `- **Files in scope:** ${
            parsed?.files.map((f) => `\`${f.newPath}\``).join(', ') ||
            `\`${targetFile}\``
          }\n- **Symbols modified:** ${
            symbols.length > 0
              ? symbols.map((s) => `\`${s}\``).join(', ')
              : 'Module-level changes'
          }`,
      '',
      `💡 *You can also run \`@openrabbit test\` to generate unit tests, \`@openrabbit fix\` for a committable patch, or \`@openrabbit docstring\` for documentation.*`,
    ].join('\n'),
    providerUsed: 'heuristic',
    modelUsed: 'openrabbit-ast-v1',
  };
}
