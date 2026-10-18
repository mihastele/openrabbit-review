/* global mermaid */
(function () {
  let templates = [];
  let currentReview = null;
  let currentParsedDiff = null;

  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatInlineMarkdown(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  // Tab Navigation
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`tab-${target}`);
      if (panel) panel.classList.add('active');
      if (target === 'history') {
        loadHistoryAndAnalytics();
      }
    });
  });

  async function initApp() {
    try {
      const [statusRes, tplRes, revRes] = await Promise.all([
        fetch('/api/status').then((r) => r.json()),
        fetch('/api/templates').then((r) => r.json()),
        fetch('/api/reviews').then((r) => r.json()),
      ]);

      // Engine badge
      const engineEl = document.getElementById('activeEngineText');
      if (statusRes.activeProvider) {
        engineEl.textContent = `Engine: ${statusRes.activeProvider.provider}/${statusRes.activeProvider.model}`;
      }

      // Populate Rules & Providers tab
      renderProvidersStatus(statusRes.providers || []);
      populateConfigForm(statusRes.config, statusRes.yamlConfig);

      // Populate Sample Templates
      templates = tplRes.templates || [];
      renderTemplatePills();

      // Load first template into editor & show initial seeded review
      if (templates.length > 0) {
        selectTemplate(templates[0], false);
      }

      if (revRes.reviews && revRes.reviews.length > 0) {
        await loadReviewById(revRes.reviews[0].id);
      } else if (templates.length > 0) {
        await executeReview();
      }

      renderAnalyticsAndHistory(revRes.reviews || [], revRes.analytics || {});
    } catch (err) {
      console.error('Failed to initialize OpenRabbit UI:', err);
    }
  }

  function renderTemplatePills() {
    const container = document.getElementById('templatePills');
    container.innerHTML = '';
    templates.forEach((tpl, index) => {
      const btn = document.createElement('button');
      btn.className = `template-pill ${index === 0 ? 'active' : ''}`;
      btn.setAttribute('data-tpl-id', tpl.id);
      btn.innerHTML = `
        <div class="template-pill-title">
          <span>${escapeHtml(tpl.name)}</span>
          <span class="mono-hint">#${tpl.prNumber}</span>
        </div>
        <div class="template-pill-desc">${escapeHtml(tpl.description)}</div>
      `;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.template-pill').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        selectTemplate(tpl, true);
      });
      container.appendChild(btn);
    });
  }

  function selectTemplate(tpl, autoRun) {
    document.getElementById('inputPrTitle').value = tpl.prTitle;
    document.getElementById('inputRepoName').value = tpl.repository;
    const diffArea = document.getElementById('textareaDiff');
    diffArea.value = tpl.diff;
    updateDiffLineCounter();
    if (autoRun) {
      executeReview();
    }
  }

  function updateDiffLineCounter() {
    const val = document.getElementById('textareaDiff').value || '';
    const count = val.trim() ? val.split('\n').length : 0;
    document.getElementById('diffLineStats').textContent = `${count} lines`;
  }

  document
    .getElementById('textareaDiff')
    .addEventListener('input', updateDiffLineCounter);

  async function executeReview() {
    const btn = document.getElementById('btnRunReview');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Analyzing Diff & Generating Walkthrough...';

    try {
      const diff = document.getElementById('textareaDiff').value;
      const prTitle = document.getElementById('inputPrTitle').value;
      const repository = document.getElementById('inputRepoName').value;
      const profile = document.getElementById('selectProfile').value;
      const provider = document.getElementById('selectProvider').value;

      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diff,
          prTitle,
          repository,
          profile,
          provider,
          source: 'playground',
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      currentReview = data.review;
      currentParsedDiff = data.parsedDiff;
      renderReviewStudio(currentReview, currentParsedDiff);
    } catch (err) {
      console.error('Review error:', err);
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }

  document.getElementById('btnRunReview').addEventListener('click', executeReview);

  document.getElementById('btnReviewLocalGit').addEventListener('click', async () => {
    const btn = document.getElementById('btnReviewLocalGit');
    btn.textContent = '⏳ Reading git diff...';
    try {
      const res = await fetch('/api/review/local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.empty) {
        alert(data.message);
        return;
      }
      if (data.review) {
        document.getElementById('inputPrTitle').value = data.review.prTitle;
        document.getElementById('inputRepoName').value = data.review.repository;
        document.getElementById('textareaDiff').value = data.review.rawDiff || '';
        updateDiffLineCounter();
        currentReview = data.review;
        currentParsedDiff = data.parsedDiff;
        renderReviewStudio(currentReview, currentParsedDiff);
      }
    } finally {
      btn.textContent = '📂 Review Local Git Diff';
    }
  });

  async function loadReviewById(id) {
    const res = await fetch(`/api/reviews/${encodeURIComponent(id)}`);
    if (!res.ok) return;
    const data = await res.json();
    currentReview = data.review;
    currentParsedDiff = data.parsedDiff;
    if (currentReview.rawDiff) {
      document.getElementById('textareaDiff').value = currentReview.rawDiff;
      document.getElementById('inputPrTitle').value = currentReview.prTitle;
      document.getElementById('inputRepoName').value = currentReview.repository;
      updateDiffLineCounter();
    }
    renderReviewStudio(currentReview, currentParsedDiff);
  }

  async function renderReviewStudio(review, parsedDiff) {
    const w = review.walkthrough;
    document.getElementById('viewPrTitle').textContent = review.prTitle;
    document.getElementById('viewRepoTag').textContent = `${review.repository}${
      review.prNumber ? ` #${review.prNumber}` : ''
    }`;
    document.getElementById('viewEngineTag').textContent = `${review.providerUsed}/${review.modelUsed} (${review.durationMs}ms)`;

    document.getElementById('kpiEffort').textContent = `Effort: ${w.effortScore}/5 (~${w.estimatedMinutes}m)`;
    const kpiRisk = document.getElementById('kpiRisk');
    kpiRisk.textContent = `Risk: ${w.riskLevel.toUpperCase()}`;
    kpiRisk.style.color =
      w.riskLevel === 'critical'
        ? '#fb7185'
        : w.riskLevel === 'high'
        ? '#fbbf24'
        : '#4ade80';

    document.getElementById('kpiFindings').textContent = `${review.findings.length} Finding${
      review.findings.length === 1 ? '' : 's'
    }`;

    document.getElementById('viewExecutiveSummary').innerHTML = formatInlineMarkdown(
      w.executiveSummary
    );

    document.getElementById('rawMarkdownPre').textContent =
      review.markdownWalkthrough || '';

    // File Walkthrough Table
    const tbody = document.getElementById('viewFileWalkthroughTable');
    document.getElementById('viewFileCountHint').textContent = `${w.fileSummaries.length} file(s) changed (+${review.stats.additions}/-${review.stats.deletions})`;
    tbody.innerHTML = w.fileSummaries
      .map((f) => {
        const impactBadge =
          f.impact === 'high'
            ? '<span class="sev-badge critical">HIGH</span>'
            : f.impact === 'medium'
            ? '<span class="sev-badge warning">MED</span>'
            : '<span class="sev-badge praise">LOW</span>';
        return `
          <tr>
            <td><code>${escapeHtml(f.path)}</code></td>
            <td>${escapeHtml(f.component)}</td>
            <td><span style="color:#4ade80">+${f.additions}</span> / <span style="color:#fb7185">-${f.deletions}</span></td>
            <td>${impactBadge}</td>
            <td>${formatInlineMarkdown(f.summary)}</td>
          </tr>
        `;
      })
      .join('');

    // Poem & Security Advisories
    document.getElementById('viewPoem').textContent =
      w.poem || 'Hop onward to merge with a confident mind! 🐇🥕';

    const secBox = document.getElementById('viewSecurityBox');
    const secList = document.getElementById('viewSecurityList');
    if (w.securityConcerns && w.securityConcerns.length > 0) {
      secBox.classList.remove('hidden');
      secList.innerHTML = w.securityConcerns
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('');
    } else {
      secBox.classList.add('hidden');
    }

    // Render Mermaid Diagram
    const mermaidEl = document.getElementById('mermaidContainer');
    if (w.mermaidDiagram && typeof mermaid !== 'undefined') {
      try {
        const renderId = `mermaid-svg-${Date.now()}`;
        const { svg } = await mermaid.render(renderId, w.mermaidDiagram);
        mermaidEl.innerHTML = svg;
      } catch {
        mermaidEl.innerHTML = `<pre class="code-preview">${escapeHtml(
          w.mermaidDiagram
        )}</pre>`;
      }
    } else {
      mermaidEl.innerHTML = `<pre class="code-preview">${escapeHtml(
        w.mermaidDiagram || ''
      )}</pre>`;
    }

    // Severity breakdown legend
    document.getElementById('viewSeverityBreakdown').innerHTML = `
      <span class="sev-badge critical">${review.stats.criticalCount} Critical</span>
      <span class="sev-badge warning">${review.stats.warningCount} Warning</span>
      <span class="sev-badge suggestion">${review.stats.suggestionCount} Suggestion</span>
      <span class="sev-badge nitpick">${review.stats.nitpickCount} Nitpick</span>
    `;

    // Render Annotated Diff with Inline Findings
    renderAnnotatedDiffWithFindings(parsedDiff, review.findings);
  }

  function renderAnnotatedDiffWithFindings(parsedDiff, findings) {
    const container = document.getElementById('annotatedDiffContainer');
    container.innerHTML = '';

    if (!parsedDiff || !parsedDiff.files || parsedDiff.files.length === 0) {
      container.innerHTML = `<div class="code-preview">No diff hunks available to display.</div>`;
      return;
    }

    parsedDiff.files.forEach((file) => {
      const fileBlock = document.createElement('div');
      fileBlock.className = 'diff-file-block';

      const fileFindings = (findings || []).filter((f) => f.file === file.newPath);

      fileBlock.innerHTML = `
        <div class="diff-file-header">
          <div>
            <strong>📄 ${escapeHtml(file.newPath)}</strong>
            <span class="mono-hint" style="margin-left:8px">${escapeHtml(file.language)}</span>
            ${
              file.symbolsChanged && file.symbolsChanged.length > 0
                ? `<span class="mono-tag" style="margin-left:8px">Symbols: ${escapeHtml(
                    file.symbolsChanged.join(', ')
                  )}</span>`
                : ''
            }
          </div>
          <div>
            <span style="color:#4ade80">+${file.additions}</span>
            <span style="color:#fb7185; margin-left:6px">-${file.deletions}</span>
            <span class="mono-tag" style="margin-left:8px">${fileFindings.length} comment(s)</span>
          </div>
        </div>
      `;

      const linesWrap = document.createElement('div');

      file.hunks.forEach((hunk) => {
        const hunkHeader = document.createElement('div');
        hunkHeader.className = 'diff-hunk-header';
        hunkHeader.textContent = hunk.header;
        linesWrap.appendChild(hunkHeader);

        hunk.lines.forEach((line) => {
          const row = document.createElement('div');
          row.className = `diff-line-row ${line.type}`;
          const oldLn = line.oldLineNumber !== undefined ? line.oldLineNumber : '';
          const newLn = line.newLineNumber !== undefined ? line.newLineNumber : '';
          const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

          row.innerHTML = `
            <span class="diff-ln">${oldLn}</span>
            <span class="diff-ln">${newLn}</span>
            <span class="diff-sign">${sign}</span>
            <span class="diff-code">${escapeHtml(line.content)}</span>
          `;
          linesWrap.appendChild(row);

          // Check if any InlineFinding attaches to this newLineNumber
          if (line.type !== 'del' && line.newLineNumber !== undefined) {
            const matching = fileFindings.filter(
              (f) => f.startLine === line.newLineNumber
            );
            matching.forEach((finding) => {
              linesWrap.appendChild(createInlineFindingCard(finding));
            });
          }
        });
      });

      fileBlock.appendChild(linesWrap);
      container.appendChild(fileBlock);
    });
  }

  function createInlineFindingCard(finding) {
    const thread = document.createElement('div');
    thread.className = `inline-finding-thread sev-${finding.severity}`;

    const hasSuggestion =
      finding.suggestionCode && finding.suggestionCode.trim().length > 0;

    thread.innerHTML = `
      <div class="finding-header">
        <div class="finding-title-group">
          <span>🐇 <strong>openrabbit[bot]</strong></span>
          <span class="sev-badge ${finding.severity}">${escapeHtml(
      finding.severity
    )}</span>
          <span class="mono-tag">[${escapeHtml(finding.category)}]</span>
          <strong>${escapeHtml(finding.title)}</strong>
        </div>
        <span class="mono-hint">${escapeHtml(finding.file)}:L${finding.startLine}</span>
      </div>

      <div class="finding-body">${formatInlineMarkdown(finding.body)}</div>

      ${
        hasSuggestion
          ? `
        <div class="suggestion-box">
          <div class="suggestion-header">
            <span>📝 Committable Suggestion (<code>\`\`\`suggestion</code>)</span>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-secondary btn-xs btn-copy-sug">Copy Patch</button>
              <button class="btn btn-primary btn-xs btn-apply-sug">✨ Apply Fix to Diff &amp; Re-Verify</button>
            </div>
          </div>
          <div class="suggestion-code-block">${escapeHtml(
            finding.suggestionCode
          )}</div>
        </div>
      `
          : ''
      }

      <div class="thread-actions">
        <button class="chip-btn" data-thread-cmd="@openrabbit explain">🔍 @openrabbit explain</button>
        <button class="chip-btn" data-thread-cmd="@openrabbit test">🧪 @openrabbit test</button>
        <button class="chip-btn" data-thread-cmd="@openrabbit fix">🔧 @openrabbit fix</button>
        <button class="chip-btn" data-thread-cmd="@openrabbit resolve">✅ Resolve</button>
      </div>
      <div class="chat-response-box hidden thread-reply-output"></div>
    `;

    if (hasSuggestion) {
      const copyBtn = thread.querySelector('.btn-copy-sug');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(finding.suggestionCode);
        copyBtn.textContent = '✔ Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy Patch'), 1500);
      });

      const applyBtn = thread.querySelector('.btn-apply-sug');
      applyBtn.addEventListener('click', () => {
        const diffArea = document.getElementById('textareaDiff');
        if (finding.originalCode && diffArea.value.includes(`+${finding.originalCode}`)) {
          const replacementLines = finding.suggestionCode
            .split('\n')
            .map((l) => `+${l}`)
            .join('\n');
          diffArea.value = diffArea.value.replace(
            `+${finding.originalCode}`,
            replacementLines
          );
          updateDiffLineCounter();
          executeReview();
        } else {
          navigator.clipboard.writeText(finding.suggestionCode);
          applyBtn.textContent = '✔ Copied to clipboard!';
        }
      });
    }

    const replyOutput = thread.querySelector('.thread-reply-output');
    thread.querySelectorAll('[data-thread-cmd]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cmd = btn.getAttribute('data-thread-cmd');
        replyOutput.classList.remove('hidden');
        replyOutput.textContent = `🐇 @openrabbit is thinking (${cmd})...`;

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: cmd,
            file: finding.file,
            line: finding.startLine,
            findingContext: finding,
            diff: document.getElementById('textareaDiff').value,
            prTitle: document.getElementById('inputPrTitle').value,
          }),
        });
        const data = await res.json();
        replyOutput.textContent = data.replyMarkdown || 'No response';
      });
    });

    return thread;
  }

  // Raw Markdown Drawer Toggle & Copy
  document.getElementById('btnToggleRawMarkdown').addEventListener('click', () => {
    document.getElementById('rawMarkdownCard').classList.toggle('hidden');
  });

  document.getElementById('btnCopyMarkdown').addEventListener('click', () => {
    const md = document.getElementById('rawMarkdownPre').textContent;
    navigator.clipboard.writeText(md);
    const btn = document.getElementById('btnCopyMarkdown');
    btn.textContent = '✔ Copied!';
    setTimeout(() => (btn.textContent = 'Copy Markdown'), 1500);
  });

  // Global @openrabbit PR Chat
  async function sendGlobalChat(queryText) {
    const output = document.getElementById('globalChatOutput');
    output.classList.remove('hidden');
    output.textContent = '🐇 @openrabbit is analyzing your PR context...';

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryText,
        diff: document.getElementById('textareaDiff').value,
        prTitle: document.getElementById('inputPrTitle').value,
        findingContext:
          currentReview && currentReview.findings
            ? currentReview.findings[0]
            : undefined,
      }),
    });
    const data = await res.json();
    output.textContent = data.replyMarkdown || '';
  }

  document.getElementById('btnSendGlobalChat').addEventListener('click', () => {
    const val = document.getElementById('globalChatInput').value.trim();
    if (val) sendGlobalChat(val);
  });

  document.getElementById('globalChatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val) sendGlobalChat(val);
    }
  });

  document.querySelectorAll('[data-chat]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const q = chip.getAttribute('data-chat');
      document.getElementById('globalChatInput').value = q;
      sendGlobalChat(q);
    });
  });

  // History & Analytics Tab
  async function loadHistoryAndAnalytics() {
    const res = await fetch('/api/reviews');
    const data = await res.json();
    renderAnalyticsAndHistory(data.reviews || [], data.analytics || {});
  }

  function renderAnalyticsAndHistory(reviews, analytics) {
    const kpiGrid = document.getElementById('analyticsKpiGrid');
    kpiGrid.innerHTML = `
      <div class="stat-card">
        <div class="stat-card-label">Total Pull Requests Reviewed</div>
        <div class="stat-card-value">${analytics.totalReviews || 0}</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Critical Security &amp; Bugs Caught</div>
        <div class="stat-card-value" style="color:#fb7185">${
          (analytics.criticalCaught || 0) + (analytics.warningsCaught || 0)
        }</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Committable Suggestions</div>
        <div class="stat-card-value" style="color:#38bdf8">${
          analytics.totalFindings || 0
        }</div>
      </div>
      <div class="stat-card">
        <div class="stat-card-label">Estimated Engineering Hours Saved</div>
        <div class="stat-card-value" style="color:#4ade80">${
          analytics.estimatedHoursSaved || 0
        }h</div>
      </div>
    `;

    const tbody = document.getElementById('historyTableBody');
    tbody.innerHTML = reviews
      .map((r) => {
        const riskClass =
          r.walkthrough.riskLevel === 'critical'
            ? 'critical'
            : r.walkthrough.riskLevel === 'high'
            ? 'warning'
            : 'praise';
        return `
          <tr>
            <td><strong>${escapeHtml(r.prTitle)}</strong></td>
            <td><code>${escapeHtml(r.repository)}</code></td>
            <td><span class="mono-tag">${escapeHtml(r.source)}</span></td>
            <td><code>${escapeHtml(r.providerUsed)}</code></td>
            <td><span style="color:#4ade80">+${r.stats.additions}</span> / <span style="color:#fb7185">-${r.stats.deletions}</span></td>
            <td>${r.stats.findingsCount}</td>
            <td><span class="sev-badge ${riskClass}">${escapeHtml(
          r.walkthrough.riskLevel
        )}</span></td>
            <td><button class="btn btn-secondary btn-xs" data-open-review="${
              r.id
            }">Inspect</button></td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('[data-open-review]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-open-review');
        await loadReviewById(id);
        document.querySelector('[data-tab="studio"]').click();
      });
    });

    // Category Breakdown
    const catContainer = document.getElementById('categoryChartContainer');
    const breakdown = analytics.categoryBreakdown || {};
    const entries = Object.entries(breakdown);
    const maxCount = Math.max(1, ...entries.map(([, c]) => c));
    catContainer.innerHTML =
      entries.length > 0
        ? entries
            .map(
              ([cat, count]) => `
            <div class="cat-row">
              <div class="cat-label-row">
                <strong>${escapeHtml(cat.toUpperCase())}</strong>
                <span class="mono-hint">${count} finding(s)</span>
              </div>
              <div class="cat-bar-track">
                <div class="cat-bar-fill" style="width:${Math.round(
                  (count / maxCount) * 100
                )}%"></div>
              </div>
            </div>
          `
            )
            .join('')
        : '<div class="mono-hint">No findings recorded yet.</div>';
  }

  // Rules & Providers Studio
  function renderProvidersStatus(providers) {
    const container = document.getElementById('providersListContainer');
    container.innerHTML = providers
      .map(
        (p) => `
        <div class="provider-card">
          <div class="provider-card-top">
            <strong>${escapeHtml(p.name)} (<code>${escapeHtml(p.id)}</code>)</strong>
            <span class="sev-badge ${p.configured ? 'praise' : 'nitpick'}">
              ${p.configured ? '● Ready' : '○ Optional API Key'}
            </span>
          </div>
          <div class="card-subtitle">${escapeHtml(p.description)}</div>
          <div class="mono-hint" style="margin-top:4px">Default model: <code>${escapeHtml(
            p.defaultModel
          )}</code></div>
        </div>
      `
      )
      .join('');
  }

  function populateConfigForm(config, yamlString) {
    if (!config) return;
    document.getElementById('cfgProfile').value = config.profile || 'chill';
    document.getElementById('cfgProvider').value = config.llm?.provider || 'auto';
    document.getElementById('cfgTone').value = config.tone_instructions || '';
    document.getElementById('cfgHighLevelSummary').checked = Boolean(
      config.reviews?.high_level_summary
    );
    document.getElementById('cfgSequenceDiagrams').checked = Boolean(
      config.reviews?.sequence_diagrams
    );
    document.getElementById('cfgPoem').checked = Boolean(config.reviews?.poem);
    document.getElementById('cfgCollapseWalkthrough').checked = Boolean(
      config.reviews?.collapse_walkthrough
    );
    document.getElementById('textareaYamlConfig').value = yamlString || '';
  }

  document.getElementById('btnSaveYamlConfig').addEventListener('click', async () => {
    const yaml = document.getElementById('textareaYamlConfig').value;
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
    const data = await res.json();
    const toast = document.getElementById('configSaveStatus');
    toast.classList.remove('hidden');
    toast.textContent = `✔ Saved configuration to ${data.configPath}`;
    setTimeout(() => toast.classList.add('hidden'), 3500);
  });

  // Webhook Simulator
  document.getElementById('btnSimGithubPR').addEventListener('click', async () => {
    const out = document.getElementById('webhookSimResult');
    out.textContent = 'Dispatching POST /api/webhooks/github (X-GitHub-Event: pull_request)...';
    const tpl = templates[0] || {};
    const res = await fetch('/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'opened',
        number: 501,
        repository: { full_name: 'openrabbit/demo-service' },
        pull_request: {
          number: 501,
          title: 'feat(Webhook): simulated GitHub PR event',
          user: { login: 'octocat' },
          base: { ref: 'main' },
          head: { ref: 'feat/webhook-sim', sha: 'a1b2c3d4' },
        },
        simulated_diff: tpl.diff,
      }),
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  });

  document.getElementById('btnSimGithubChat').addEventListener('click', async () => {
    const out = document.getElementById('webhookSimResult');
    out.textContent = 'Dispatching POST /api/webhooks/github (X-GitHub-Event: issue_comment)...';
    const tpl = templates[0] || {};
    const res = await fetch('/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'openrabbit/demo-service' },
        issue: { number: 501, title: 'feat(auth): session token endpoint' },
        comment: {
          body: '@openrabbit generate unit tests for lookupUserByEmail',
        },
        simulated_diff: tpl.diff,
      }),
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  });

  document.getElementById('btnSimGitlabMR').addEventListener('click', async () => {
    const out = document.getElementById('webhookSimResult');
    out.textContent = 'Dispatching POST /api/webhooks/gitlab (X-Gitlab-Event: Merge Request Hook)...';
    const tpl = templates[1] || templates[0] || {};
    const res = await fetch('/api/webhooks/gitlab', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Event': 'Merge Request Hook',
      },
      body: JSON.stringify({
        object_kind: 'merge_request',
        user: { username: 'gitlab-dev' },
        project: { id: 99, path_with_namespace: 'gitlab-org/billing-ui' },
        object_attributes: {
          iid: 88,
          action: 'open',
          title: 'feat(billing): invoice status polling banner',
          target_branch: 'main',
          source_branch: 'feat/polling',
          last_commit: { id: '99887766' },
        },
        simulated_diff: tpl.diff,
      }),
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  });

  initApp();
})();
