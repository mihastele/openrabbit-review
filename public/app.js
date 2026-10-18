/* global mermaid */
(function () {
  let templates = [];
  let currentReview = null;
  let currentParsedDiff = null;
  let repositories = [];
  let selectedRepository = null;
  let selectedRepoCommits = [];
  let customRules = [];
  let builtinRules = [];
  let currentRulesConfig = null;
  let editingRuleId = null;

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

  function switchToTab(target) {
    const btn = document.querySelector(`.nav-tab[data-tab="${target}"]`);
    if (btn) btn.click();
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
      } else if (target === 'repos') {
        loadRepositories();
      } else if (target === 'rules') {
        loadRulesStudio();
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

      // Load Custom Rules Studio
      await loadRulesStudio();

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
      await loadRepositories();
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
      const reviewer =
        document.getElementById('selectReviewerMode')?.value || 'hybrid';

      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          diff,
          prTitle,
          repository,
          profile,
          provider,
          reviewer,
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

  // =========================================================================
  // Custom Rules & Reviewer Studio (Schema v1)
  // =========================================================================

  async function loadRulesStudio() {
    try {
      const res = await fetch('/api/rules');
      const data = await res.json();
      customRules = data.customRules || [];
      builtinRules = data.builtinCatalog || [];
      currentRulesConfig = data.staticAnalysis || {};

      // Badges
      const customBadge = document.getElementById('customRulesCountBadge');
      if (customBadge) customBadge.textContent = String(customRules.length);
      const builtinBadge = document.getElementById('builtinRulesCountBadge');
      if (builtinBadge) builtinBadge.textContent = String(builtinRules.length);

      // Reviewer and Static Analysis Mode selects
      const revModeSelect = document.getElementById('rulesCfgReviewerMode');
      if (revModeSelect && data.reviewer) {
        revModeSelect.value = data.reviewer;
      }
      const studioRevSelect = document.getElementById('selectReviewerMode');
      if (studioRevSelect && data.reviewer) {
        studioRevSelect.value = data.reviewer;
      }

      const builtinModeSelect = document.getElementById('rulesCfgBuiltinMode');
      if (builtinModeSelect && currentRulesConfig.builtinRules?.mode) {
        builtinModeSelect.value = currentRulesConfig.builtinRules.mode;
      }

      const minSevSelect = document.getElementById('rulesCfgMinSeverity');
      if (minSevSelect && currentRulesConfig.builtinRules?.minSeverity) {
        minSevSelect.value = currentRulesConfig.builtinRules.minSeverity;
      }

      renderCustomRulesTable();
      renderBuiltinRulesCatalog();
      populateTestRuleDropdown();
    } catch (err) {
      console.error('Failed to load rules studio:', err);
    }
  }

  function renderCustomRulesTable() {
    const tbody = document.getElementById('customRulesTableBody');
    const summary = document.getElementById('customRulesSummaryText');
    if (!tbody) return;

    if (summary) {
      summary.textContent = `${customRules.length} rule${customRules.length === 1 ? '' : 's'} loaded (Schema: v1)`;
    }

    if (customRules.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-state">
            No custom rules defined yet.<br/>
            <span style="font-size: 12px; color: var(--text-muted);">
              Define your own static rules above, click <strong>✨ Load Starter Rules</strong>, or import a Schema v1 JSON file.
            </span>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = '';
    customRules.forEach((rule) => {
      const tr = document.createElement('tr');
      const isEnabled = rule.enabled !== false;
      const languages = (rule.languages || []).join(', ') || '*';

      tr.innerHTML = `
        <td>
          <label class="rule-toggle-switch" title="Toggle rule active state">
            <input type="checkbox" class="rule-enabled-toggle" ${isEnabled ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>
          <span class="rule-id-code">${escapeHtml(rule.id)}</span>
          <div style="font-weight: 500; margin-top: 4px; color: var(--text-primary);">${escapeHtml(rule.title)}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(rule.description.slice(0, 90))}...</div>
        </td>
        <td>
          <span class="sev-badge ${rule.severity}">${rule.severity.toUpperCase()}</span>
        </td>
        <td>
          <span class="mono-tag">${escapeHtml(rule.category)}</span>
        </td>
        <td>
          <span class="rule-lang-badge">${escapeHtml(languages)}</span>
        </td>
        <td>
          <code class="rule-pattern-code" title="${escapeHtml(rule.rule?.pattern || '')}">${escapeHtml(rule.rule?.pattern || '')}</code>
        </td>
        <td>
          <div class="rule-actions-cell">
            <button class="btn btn-secondary btn-xs btn-edit-rule" title="Edit Rule">✏️ Edit</button>
            <button class="btn btn-secondary btn-xs btn-test-rule" title="Test in Sandbox">🧪 Test</button>
            <button class="btn btn-secondary btn-xs btn-delete-rule" title="Delete Rule" style="color: #f87171;">✕</button>
          </div>
        </td>
      `;

      tr.querySelector('.rule-enabled-toggle').addEventListener('change', async (e) => {
        rule.enabled = e.target.checked;
        await saveSingleRule(rule);
      });

      tr.querySelector('.btn-edit-rule').addEventListener('click', () => {
        openRuleModal(rule);
      });

      tr.querySelector('.btn-test-rule').addEventListener('click', () => {
        switchToRulesSubtab('tester');
        document.getElementById('selectTestRule').value = rule.id;
        if (!document.getElementById('textareaTestSnippet').value.trim()) {
          document.getElementById('textareaTestSnippet').value = rule.rule.pattern.includes('console')
            ? 'console.log("Debug value:", token);'
            : rule.rule.pattern.includes('http:')
            ? 'const apiEndpoint = "http://api.internal-service.com/v1/auth";'
            : 'const data = eval(userInput);';
        }
      });

      tr.querySelector('.btn-delete-rule').addEventListener('click', async () => {
        if (confirm(`Are you sure you want to delete custom rule "${rule.id}"?`)) {
          await deleteCustomRule(rule.id);
        }
      });

      tbody.appendChild(tr);
    });
  }

  function renderBuiltinRulesCatalog() {
    const tbody = document.getElementById('builtinRulesTableBody');
    if (!tbody) return;

    const query = (document.getElementById('inputSearchBuiltinRules')?.value || '').toLowerCase().trim();
    const catFilter = document.getElementById('filterBuiltinCategory')?.value || '';
    const sevFilter = document.getElementById('filterBuiltinSeverity')?.value || '';

    const enabledSet = new Set(currentRulesConfig.builtinRules?.enabledRuleIds || []);
    const disabledSet = new Set(currentRulesConfig.builtinRules?.disabledRuleIds || []);
    const mode = currentRulesConfig.builtinRules?.mode || 'all';

    const filtered = builtinRules.filter((b) => {
      if (query && !b.id.toLowerCase().includes(query) && !b.title.toLowerCase().includes(query) && !b.description.toLowerCase().includes(query)) {
        return false;
      }
      if (catFilter && b.category !== catFilter) return false;
      if (sevFilter && b.severity !== sevFilter) return false;
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No matching built-in rules found.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    filtered.forEach((b) => {
      const tr = document.createElement('tr');
      const isChecked = mode === 'subset' ? enabledSet.has(b.id) : !disabledSet.has(b.id);

      tr.innerHTML = `
        <td style="text-align: center;">
          <input type="checkbox" class="builtin-rule-checkbox" data-rule-id="${escapeHtml(b.id)}" ${isChecked ? 'checked' : ''} />
        </td>
        <td>
          <span class="rule-id-code">${escapeHtml(b.id)}</span>
        </td>
        <td>
          <div style="font-weight: 500; color: var(--text-primary);">${escapeHtml(b.title)}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${escapeHtml(b.description)}</div>
        </td>
        <td>
          <span class="sev-badge ${b.severity}">${b.severity.toUpperCase()}</span>
        </td>
        <td>
          <span class="mono-tag">${escapeHtml(b.category)}</span>
        </td>
        <td>
          <span class="rule-lang-badge">${escapeHtml(b.languages.join(', '))}</span>
        </td>
      `;

      tbody.appendChild(tr);
    });
  }

  function populateTestRuleDropdown() {
    const select = document.getElementById('selectTestRule');
    if (!select) return;

    select.innerHTML = '';
    if (customRules.length > 0) {
      const optGroupCustom = document.createElement('optgroup');
      optGroupCustom.label = 'Custom Rules (Schema v1)';
      customRules.forEach((r) => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${r.id} — ${r.title}`;
        optGroupCustom.appendChild(opt);
      });
      select.appendChild(optGroupCustom);
    }

    if (builtinRules.length > 0) {
      const optGroupBuiltin = document.createElement('optgroup');
      optGroupBuiltin.label = 'Built-in Rules';
      builtinRules.forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = `${b.id} — ${b.title}`;
        optGroupBuiltin.appendChild(opt);
      });
      select.appendChild(optGroupBuiltin);
    }
  }

  function openRuleModal(rule = null) {
    editingRuleId = rule ? rule.id : null;
    const modal = document.getElementById('modalCustomRule');
    const titleEl = document.getElementById('ruleModalTitle');
    const errEl = document.getElementById('ruleModalError');
    if (errEl) errEl.classList.add('hidden');

    if (titleEl) {
      titleEl.textContent = rule ? `✏️ Edit Custom Rule: ${rule.id}` : '➕ Define Custom Static Analysis Rule';
    }

    document.getElementById('ruleInputId').value = rule ? rule.id : '';
    document.getElementById('ruleInputId').disabled = Boolean(rule);
    document.getElementById('ruleInputTitle').value = rule ? rule.title : '';
    document.getElementById('ruleInputSeverity').value = rule ? rule.severity : 'warning';
    document.getElementById('ruleInputCategory').value = rule ? rule.category : 'bug';
    document.getElementById('ruleInputLanguages').value = rule ? (rule.languages || []).join(', ') : 'typescript, javascript';
    document.getElementById('ruleInputPathFilter').value = rule?.rule?.pathFilter || '';
    document.getElementById('ruleInputPattern').value = rule?.rule?.pattern || '';
    document.getElementById('ruleInputNotPattern').value = rule?.rule?.notPattern || '';
    document.getElementById('ruleInputDescription').value = rule ? rule.description : '';
    document.getElementById('ruleInputSuggestion').value = rule?.rule?.suggestionTemplate || '';
    document.getElementById('ruleInputEnabled').checked = rule ? rule.enabled !== false : true;

    modal.classList.remove('hidden');
  }

  function closeRuleModal() {
    const modal = document.getElementById('modalCustomRule');
    if (modal) modal.classList.add('hidden');
    editingRuleId = null;
  }

  async function saveSingleRule(rule) {
    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule),
      });
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error + (data.errors ? ': ' + data.errors.join(', ') : ''));
      }
      customRules = data.customRules || customRules;
      renderCustomRulesTable();
      populateTestRuleDropdown();
    } catch (err) {
      alert('Failed to save rule: ' + err.message);
    }
  }

  async function deleteCustomRule(id) {
    try {
      const res = await fetch(`/api/rules/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      customRules = data.customRules || [];
      renderCustomRulesTable();
      populateTestRuleDropdown();
      const badge = document.getElementById('customRulesCountBadge');
      if (badge) badge.textContent = String(customRules.length);
    } catch (err) {
      alert('Failed to delete rule: ' + err.message);
    }
  }

  function switchToRulesSubtab(subtabName) {
    document.querySelectorAll('.rules-subnav-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-subtab') === subtabName);
    });
    document.querySelectorAll('.subtab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `subtab-${subtabName}`);
      p.classList.toggle('hidden', p.id !== `subtab-${subtabName}`);
    });
  }

  // Subnav clicks
  document.querySelectorAll('.rules-subnav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const subtab = btn.getAttribute('data-subtab');
      switchToRulesSubtab(subtab);
    });
  });

  // Modal handlers
  document.getElementById('btnOpenNewRuleModal')?.addEventListener('click', () => openRuleModal());
  document.getElementById('btnCloseRuleModal')?.addEventListener('click', closeRuleModal);
  document.getElementById('btnCancelRuleModal')?.addEventListener('click', closeRuleModal);

  document.getElementById('formCustomRule')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('ruleModalError');
    errEl.classList.add('hidden');

    const rawLangs = document.getElementById('ruleInputLanguages').value.split(',').map((s) => s.trim()).filter(Boolean);
    const ruleObj = {
      schemaVersion: 'v1',
      id: document.getElementById('ruleInputId').value.trim(),
      title: document.getElementById('ruleInputTitle').value.trim(),
      description: document.getElementById('ruleInputDescription').value.trim(),
      severity: document.getElementById('ruleInputSeverity').value,
      category: document.getElementById('ruleInputCategory').value,
      languages: rawLangs.length > 0 ? rawLangs : ['*'],
      enabled: document.getElementById('ruleInputEnabled').checked,
      rule: {
        type: 'regex',
        pattern: document.getElementById('ruleInputPattern').value.trim(),
        flags: 'i',
        pathFilter: document.getElementById('ruleInputPathFilter').value.trim() || undefined,
        notPattern: document.getElementById('ruleInputNotPattern').value.trim() || undefined,
        suggestionTemplate: document.getElementById('ruleInputSuggestion').value.trim() || undefined,
      },
    };

    try {
      const res = await fetch('/api/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ruleObj),
      });
      const data = await res.json();
      if (data.error) {
        errEl.textContent = `Error: ${data.error} ${data.errors ? '(' + data.errors.join('; ') + ')' : ''}`;
        errEl.classList.remove('hidden');
        return;
      }
      customRules = data.customRules || [];
      renderCustomRulesTable();
      populateTestRuleDropdown();
      const badge = document.getElementById('customRulesCountBadge');
      if (badge) badge.textContent = String(customRules.length);
      closeRuleModal();
    } catch (err) {
      errEl.textContent = `Failed to save rule: ${err.message}`;
      errEl.classList.remove('hidden');
    }
  });

  // Save Reviewer Settings
  document.getElementById('btnSaveReviewerSettings')?.addEventListener('click', async () => {
    const reviewerMode = document.getElementById('rulesCfgReviewerMode')?.value || 'hybrid';
    const builtinMode = document.getElementById('rulesCfgBuiltinMode')?.value || 'all';
    const minSeverity = document.getElementById('rulesCfgMinSeverity')?.value || 'nitpick';
    const toast = document.getElementById('rulesConfigToast');

    try {
      const res = await fetch('/api/rules/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewer: reviewerMode,
          staticAnalysis: {
            enabled: reviewerMode !== 'llm-only',
            builtinRules: {
              mode: builtinMode,
              minSeverity,
              enabledRuleIds: currentRulesConfig.builtinRules?.enabledRuleIds || [],
              disabledRuleIds: currentRulesConfig.builtinRules?.disabledRuleIds || [],
            },
          },
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }
      toast.className = 'save-toast';
      toast.textContent = `✔ Successfully saved reviewer mode (${reviewerMode}) and static analysis configuration!`;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 3500);

      // Synchronize PR Studio selector
      const studioSelect = document.getElementById('selectReviewerMode');
      if (studioSelect) studioSelect.value = reviewerMode;
    } catch (err) {
      alert('Failed to save reviewer config: ' + err.message);
    }
  });

  // Link from PR Studio sidebar to Rules Studio
  document.getElementById('linkConfigureCustomRules')?.addEventListener('click', (e) => {
    e.preventDefault();
    switchToTab('rules');
  });

  // Load starter rules
  document.getElementById('btnLoadStarterRules')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/rules');
      const data = await res.json();
      const starters = data.starterRules || [];
      if (starters.length === 0) return;

      const importRes = await fetch('/api/rules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: starters }),
      });
      const importData = await importRes.json();
      if (importData.error) {
        alert(importData.error);
        return;
      }
      customRules = importData.customRules || [];
      renderCustomRulesTable();
      populateTestRuleDropdown();
      const badge = document.getElementById('customRulesCountBadge');
      if (badge) badge.textContent = String(customRules.length);
      alert(`✔ Successfully loaded ${importData.importedCount} starter Schema v1 rules!`);
    } catch (err) {
      alert('Failed to load starter rules: ' + err.message);
    }
  });

  // Export JSON
  document.getElementById('btnExportRules')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/rules/export');
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'openrabbit-rules.v1.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Failed to export rules: ' + err.message);
    }
  });

  // Import JSON/YAML
  document.getElementById('btnImportRules')?.addEventListener('click', () => {
    document.getElementById('fileRulesImport')?.click();
  });

  document.getElementById('fileRulesImport')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = String(reader.result || '');
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          alert('Import requires valid JSON (Schema v1).');
          return;
        }
        const res = await fetch('/api/rules/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.error) {
          alert('Import failed: ' + data.error);
          return;
        }
        customRules = data.customRules || [];
        renderCustomRulesTable();
        populateTestRuleDropdown();
        alert(`✔ Successfully imported ${data.importedCount} rules conforming to Schema v1!`);
      } catch (err) {
        alert('Failed to parse file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // Rule Sandbox Live Tester
  document.getElementById('btnExecuteRuleTest')?.addEventListener('click', async () => {
    const ruleId = document.getElementById('selectTestRule')?.value;
    const code = document.getElementById('textareaTestSnippet')?.value || '';
    const filePath = document.getElementById('inputTestFilePath')?.value || 'sample.ts';
    const resultBox = document.getElementById('ruleTestResultBox');
    const badgeEl = document.getElementById('ruleTestStatusBadge');
    const detailsEl = document.getElementById('ruleTestMatchDetails');

    if (!code.trim()) {
      alert('Please enter a code snippet or diff line to test.');
      return;
    }

    let targetRule = customRules.find((r) => r.id === ruleId);
    if (!targetRule) {
      // Find from built-in
      const builtin = builtinRules.find((b) => b.id === ruleId);
      if (builtin) {
        targetRule = {
          schemaVersion: 'v1',
          id: builtin.id,
          title: builtin.title,
          description: builtin.description,
          severity: builtin.severity,
          category: builtin.category,
          languages: builtin.languages,
          rule: {
            type: 'regex',
            pattern: builtin.id === 'sec-hardcoded-secret' ? '(?:api[_-]?key|secret|password|token)\\s*[:=]\\s*[\'"][A-Za-z0-9_\\-./+=]{12,}[\'"]' : 'eval\\s*\\(',
          },
        };
      }
    }

    if (!targetRule && customRules.length > 0) {
      targetRule = customRules[0];
    }

    if (!targetRule) {
      alert('Please select or create a rule to test.');
      return;
    }

    try {
      const res = await fetch('/api/rules/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule: targetRule,
          code,
          filePath,
        }),
      });
      const data = await res.json();
      resultBox.classList.remove('hidden');

      if (data.matched) {
        badgeEl.innerHTML = `<span class="clean-badge" style="background:#22c55e22; color:#4ade80; font-size:13px; font-weight:600;">✔ MATCH DETECTED (${data.matchesCount} match${data.matchesCount === 1 ? '' : 'es'})</span>`;
        detailsEl.innerHTML = data.matches.map((m) => `
          <div class="sandbox-match-item">
            <strong>Line ${m.lineNumber}:</strong> <code>${escapeHtml(m.lineContent)}</code>
          </div>
          ${m.suggestionCode ? `
            <div class="sandbox-match-item suggestion">
              <strong>✨ Committable Autofix:</strong>
              <pre style="margin-top:4px;">${escapeHtml(m.suggestionCode)}</pre>
            </div>
          ` : ''}
        `).join('');
      } else {
        badgeEl.innerHTML = `<span class="dirty-badge" style="background:#eab30822; color:#facc15; font-size:13px; font-weight:600;">○ NO MATCH — Rule pattern did not trigger on this snippet</span>`;
        detailsEl.innerHTML = `<div style="font-size:12px; color:var(--text-dim); margin-top:6px;">Tested against rule <code>${escapeHtml(targetRule.id)}</code> pattern: <code>${escapeHtml(targetRule.rule?.pattern || '')}</code></div>`;
      }
    } catch (err) {
      alert('Test failed: ' + err.message);
    }
  });

  document.getElementById('btnTestLoadSampleCode')?.addEventListener('click', () => {
    const ruleId = document.getElementById('selectTestRule')?.value;
    const rule = customRules.find((r) => r.id === ruleId);
    if (rule?.rule?.pattern?.includes('http')) {
      document.getElementById('textareaTestSnippet').value = 'const clientUrl = "http://internal-billing.acme.com/v1/charge";';
    } else if (rule?.rule?.pattern?.includes('fs')) {
      document.getElementById('textareaTestSnippet').value = 'const fileData = fs.readFileSync("/etc/passwd", "utf8");';
    } else {
      document.getElementById('textareaTestSnippet').value = '+ console.log("User JWT payload:", authToken);';
    }
  });

  // Builtin rules search & filters
  document.getElementById('inputSearchBuiltinRules')?.addEventListener('input', renderBuiltinRulesCatalog);
  document.getElementById('filterBuiltinCategory')?.addEventListener('change', renderBuiltinRulesCatalog);
  document.getElementById('filterBuiltinSeverity')?.addEventListener('change', renderBuiltinRulesCatalog);

  // Select all / Deselect all / Save subset
  document.getElementById('btnSelectAllBuiltinRules')?.addEventListener('click', () => {
    document.querySelectorAll('.builtin-rule-checkbox').forEach((cb) => { cb.checked = true; });
  });

  document.getElementById('btnDeselectAllBuiltinRules')?.addEventListener('click', () => {
    document.querySelectorAll('.builtin-rule-checkbox').forEach((cb) => { cb.checked = false; });
  });

  document.getElementById('btnSaveBuiltinSubset')?.addEventListener('click', async () => {
    const checkedIds = Array.from(document.querySelectorAll('.builtin-rule-checkbox:checked')).map((cb) => cb.getAttribute('data-rule-id'));
    try {
      const res = await fetch('/api/rules/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staticAnalysis: {
            builtinRules: {
              mode: 'subset',
              enabledRuleIds: checkedIds,
            },
          },
        }),
      });
      const data = await res.json();
      currentRulesConfig.builtinRules = data.staticAnalysis?.builtinRules || currentRulesConfig.builtinRules;
      document.getElementById('rulesCfgBuiltinMode').value = 'subset';
      alert(`✔ Saved subset with ${checkedIds.length} active built-in rules!`);
    } catch (err) {
      alert('Failed to save subset: ' + err.message);
    }
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

  document.getElementById('btnSimBitbucketPR')?.addEventListener('click', async () => {
    const out = document.getElementById('webhookSimResult');
    out.textContent = 'Dispatching POST /api/webhooks/bitbucket (X-Event-Key: pullrequest:created)...';
    const tpl = templates[0] || {};
    const res = await fetch('/api/webhooks/bitbucket', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Key': 'pullrequest:created',
      },
      body: JSON.stringify({
        repository: { full_name: 'acme-corp/identity-service' },
        pullrequest: {
          id: 142,
          title: 'feat(auth): add token rotation and admin user lookup endpoint',
          source: { branch: { name: 'feat/auth-rotation' }, commit: { hash: 'e5f6a7b8' } },
          destination: { branch: { name: 'main' } },
          author: { display_name: 'Alex Developer' },
        },
        simulated_diff: tpl.diff,
      }),
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
  });

  // =========================================================================
  // Local Repositories Management & Commit Explorer
  // =========================================================================

  async function loadRepositories() {
    try {
      const res = await fetch('/api/repos');
      const data = await res.json();
      repositories = data.repositories || [];
      renderRepositoriesList();
      populateStudioRepoPicker();

      const hint = document.getElementById('reposCountHint');
      if (hint) {
        hint.textContent = `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`;
      }

      if (!selectedRepository && repositories.length > 0) {
        selectRepository(repositories[0]);
      } else if (selectedRepository) {
        const found = repositories.find((r) => r.id === selectedRepository.id);
        if (found) selectRepository(found, false);
      }
    } catch (err) {
      console.error('Failed to load repositories:', err);
    }
  }

  function renderRepositoriesList() {
    const container = document.getElementById('reposListContainer');
    if (!container) return;
    if (repositories.length === 0) {
      container.innerHTML = '<div class="empty-state">No repositories registered yet. Add one above!</div>';
      return;
    }

    container.innerHTML = '';
    repositories.forEach((repo) => {
      const isSel = selectedRepository && selectedRepository.id === repo.id;
      const card = document.createElement('div');
      card.className = `repo-card-item ${isSel ? 'active' : ''}`;
      card.innerHTML = `
        <div class="repo-item-top">
          <div class="repo-item-name">${escapeHtml(repo.name)}</div>
          <span class="repo-item-branch">${escapeHtml(repo.branch)}</span>
        </div>
        <div class="repo-item-path" title="${escapeHtml(repo.path)}">${escapeHtml(repo.path)}</div>
        <div class="repo-item-meta">
          <span>${repo.isClean ? '<span class="clean-badge">✔ Clean</span>' : '<span class="dirty-badge">● Modified</span>'}</span>
          <span>${repo.lastCommitMessage ? escapeHtml(repo.lastCommitMessage.slice(0, 30)) + '...' : ''}</span>
        </div>
        <div class="repo-item-actions">
          <button class="btn btn-secondary btn-xs btn-view-commits" style="flex: 1;">Commits</button>
          <button class="btn btn-secondary btn-xs btn-review-worktree" style="flex: 1;">⚡ Review</button>
          <button class="btn btn-secondary btn-xs btn-remove-repo" title="Remove" style="color: #f87171;">✕</button>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        selectRepository(repo);
      });

      card.querySelector('.btn-view-commits').addEventListener('click', () => {
        selectRepository(repo);
      });

      card.querySelector('.btn-review-worktree').addEventListener('click', () => {
        reviewRepositoryWorkingTree(repo.id);
      });

      card.querySelector('.btn-remove-repo').addEventListener('click', async () => {
        if (confirm(`Remove repository "${repo.name}" from OpenRabbit?`)) {
          await fetch(`/api/repos/${repo.id}`, { method: 'DELETE' });
          if (selectedRepository && selectedRepository.id === repo.id) {
            selectedRepository = null;
          }
          await loadRepositories();
        }
      });

      container.appendChild(card);
    });
  }

  async function selectRepository(repo, fetchCommits = true) {
    selectedRepository = repo;
    renderRepositoriesList();

    const titleEl = document.getElementById('selectedRepoTitle');
    const subEl = document.getElementById('selectedRepoSub');
    const actionsEl = document.getElementById('commitHeaderActions');

    if (titleEl) titleEl.textContent = `📜 Commits: ${repo.name} (${repo.branch})`;
    if (subEl) subEl.textContent = `${repo.path} · ${repo.isClean ? 'Working tree clean' : 'Uncommitted changes detected'}`;
    if (actionsEl) actionsEl.style.display = 'flex';

    if (fetchCommits) {
      await loadRepoCommits(repo.id);
    }
  }

  async function loadRepoCommits(repoIdOrPath) {
    const tbody = document.getElementById('commitsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 20px; color: var(--text-muted);">Loading commits...</td></tr>';

    try {
      const res = await fetch(`/api/repos/commits?id=${encodeURIComponent(repoIdOrPath)}&maxCount=40`);
      const data = await res.json();
      if (data.error) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 20px; color: #f87171;">Error: ${escapeHtml(data.error)}</td></tr>`;
        return;
      }
      selectedRepoCommits = data.commits || [];
      renderCommitsTable(selectedRepoCommits, repoIdOrPath);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding: 20px; color: #f87171;">Failed to load commits.</td></tr>`;
    }
  }

  function renderCommitsTable(commits, repoIdOrPath) {
    const tbody = document.getElementById('commitsTableBody');
    if (!tbody) return;
    if (commits.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center" style="padding: 20px; color: var(--text-muted);">No commits found in this repository.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    commits.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="commit-hash-pill" title="Click to copy SHA" data-sha="${c.sha}">${escapeHtml(c.shortSha)}</span></td>
        <td>
          <div class="commit-subject">${escapeHtml(c.subject)}</div>
          ${c.body ? `<div class="commit-meta-sub">${escapeHtml(c.body.slice(0, 60))}...</div>` : ''}
        </td>
        <td>${escapeHtml(c.author)}</td>
        <td style="color: var(--text-dim); white-space: nowrap;">${escapeHtml(c.relativeDate || new Date(c.date).toLocaleDateString())}</td>
        <td style="white-space: nowrap;">
          <span style="color: #4ade80;">+${c.additions || 0}</span> /
          <span style="color: #f87171;">-${c.deletions || 0}</span>
        </td>
        <td>
          <button class="btn btn-primary btn-xs btn-review-this-commit" data-sha="${c.sha}">
            🐇 Review Commit
          </button>
        </td>
      `;

      tr.querySelector('.commit-hash-pill').addEventListener('click', () => {
        navigator.clipboard.writeText(c.sha);
      });

      tr.querySelector('.btn-review-this-commit').addEventListener('click', () => {
        reviewRepositoryCommit(repoIdOrPath, c.sha, c.subject);
      });

      tbody.appendChild(tr);
    });
  }

  async function reviewRepositoryCommit(repoIdOrPath, commitSha, subject) {
    const targetRepo = repositories.find((r) => r.id === repoIdOrPath || r.path === repoIdOrPath) || selectedRepository;
    switchToTab('studio');
    document.getElementById('viewPrTitle').textContent = `Reviewing commit ${commitSha.slice(0, 7)}: ${subject || ''}...`;

    try {
      const res = await fetch('/api/repos/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: repoIdOrPath,
          commitSha,
          profile: document.getElementById('selectProfile')?.value,
          provider: document.getElementById('selectProvider')?.value,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
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
    } catch (err) {
      console.error('Failed to review commit:', err);
      alert('Failed to review commit: ' + err.message);
    }
  }

  async function reviewRepositoryWorkingTree(repoIdOrPath) {
    switchToTab('studio');
    try {
      const res = await fetch('/api/repos/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: repoIdOrPath,
          profile: document.getElementById('selectProfile')?.value,
          provider: document.getElementById('selectProvider')?.value,
        }),
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
    } catch (err) {
      console.error('Failed to review repository:', err);
    }
  }

  async function reviewRepositoryStaged(repoIdOrPath) {
    switchToTab('studio');
    try {
      const res = await fetch('/api/repos/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: repoIdOrPath,
          staged: true,
          profile: document.getElementById('selectProfile')?.value,
          provider: document.getElementById('selectProvider')?.value,
        }),
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
    } catch (err) {
      console.error('Failed to review staged changes:', err);
    }
  }

  function populateStudioRepoPicker() {
    const repoSelect = document.getElementById('selectStudioRepo');
    const commitSelect = document.getElementById('selectStudioCommit');
    if (!repoSelect || !commitSelect) return;

    repoSelect.innerHTML = '<option value="">Select registered repo...</option>';
    repositories.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.name} (${r.branch})`;
      repoSelect.appendChild(opt);
    });

    repoSelect.onchange = async () => {
      const repoId = repoSelect.value;
      if (!repoId) {
        commitSelect.innerHTML = '<option value="">Select commit...</option>';
        return;
      }
      commitSelect.innerHTML = '<option value="">Loading commits...</option>';
      try {
        const res = await fetch(`/api/repos/commits?id=${encodeURIComponent(repoId)}&maxCount=25`);
        const data = await res.json();
        const commits = data.commits || [];
        commitSelect.innerHTML = '<option value="">⚡ Working Tree / Uncommitted Changes</option>';
        commits.forEach((c) => {
          const opt = document.createElement('option');
          opt.value = c.sha;
          opt.textContent = `${c.shortSha}: ${c.subject.slice(0, 36)}`;
          commitSelect.appendChild(opt);
        });
      } catch {
        commitSelect.innerHTML = '<option value="">Failed to load commits</option>';
      }
    };
  }

  document.getElementById('btnStudioLoadCommit')?.addEventListener('click', async () => {
    const repoId = document.getElementById('selectStudioRepo')?.value;
    const commitSha = document.getElementById('selectStudioCommit')?.value;
    if (!repoId) {
      alert('Please select a local repository first.');
      return;
    }
    if (!commitSha) {
      const res = await fetch('/api/repos/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: repoId }),
      });
      const data = await res.json();
      if (data.review?.rawDiff) {
        document.getElementById('textareaDiff').value = data.review.rawDiff;
        document.getElementById('inputPrTitle').value = data.review.prTitle;
        document.getElementById('inputRepoName').value = data.review.repository;
        updateDiffLineCounter();
      }
      return;
    }
    const res = await fetch(`/api/repos/commit?id=${encodeURIComponent(repoId)}&sha=${encodeURIComponent(commitSha)}`);
    const data = await res.json();
    if (data.diff) {
      document.getElementById('textareaDiff').value = data.diff;
      document.getElementById('inputPrTitle').value = `Commit ${data.commit.shortSha}: ${data.commit.subject}`;
      const repo = repositories.find((r) => r.id === repoId);
      if (repo) document.getElementById('inputRepoName').value = repo.name;
      updateDiffLineCounter();
    }
  });

  document.getElementById('btnStudioReviewCommit')?.addEventListener('click', () => {
    const repoId = document.getElementById('selectStudioRepo')?.value;
    const commitSha = document.getElementById('selectStudioCommit')?.value;
    if (!repoId) {
      alert('Please select a local repository first.');
      return;
    }
    if (commitSha) {
      reviewRepositoryCommit(repoId, commitSha);
    } else {
      reviewRepositoryWorkingTree(repoId);
    }
  });

  document.getElementById('linkGoToReposTab')?.addEventListener('click', (e) => {
    e.preventDefault();
    switchToTab('repos');
  });

  document.getElementById('btnAddRepo')?.addEventListener('click', async () => {
    const pathInput = document.getElementById('inputRepoPath');
    const nameInput = document.getElementById('inputCustomRepoName');
    const feedback = document.getElementById('addRepoFeedback');
    const repoPath = pathInput.value.trim();
    if (!repoPath) {
      alert('Please enter a repository directory path.');
      return;
    }

    feedback.className = 'save-toast';
    feedback.textContent = 'Validating git repository...';
    feedback.classList.remove('hidden');

    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: repoPath,
          name: nameInput.value.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) {
        feedback.className = 'save-toast error';
        feedback.textContent = `Error: ${data.error}`;
        return;
      }
      feedback.className = 'save-toast';
      feedback.textContent = `✔ Added repository: ${data.repository.name} (${data.repository.branch})`;
      pathInput.value = '';
      nameInput.value = '';
      await loadRepositories();
      selectRepository(data.repository);
    } catch (err) {
      feedback.className = 'save-toast error';
      feedback.textContent = `Failed to add repo: ${err.message}`;
    }
  });

  document.getElementById('btnUseCurrentDir')?.addEventListener('click', () => {
    document.getElementById('inputRepoPath').value = '.';
  });
  document.getElementById('btnRefreshRepos')?.addEventListener('click', () => {
    loadRepositories();
  });
  document.getElementById('btnReviewWorkingTree')?.addEventListener('click', () => {
    if (selectedRepository) reviewRepositoryWorkingTree(selectedRepository.id);
  });
  document.getElementById('btnReviewStaged')?.addEventListener('click', () => {
    if (selectedRepository) reviewRepositoryStaged(selectedRepository.id);
  });

  // On-Demand Integrations Review
  document.getElementById('btnRunIntegrationReview')?.addEventListener('click', async () => {
    const platform = document.getElementById('selectIntegrationPlatform').value;
    const target = document.getElementById('inputIntegrationTarget').value.trim();
    const token = document.getElementById('inputIntegrationToken').value.trim();
    const statusEl = document.getElementById('integrationReviewStatus');

    if (!target) {
      alert('Please enter a Pull Request URL or identifier (e.g. owner/repo#123)');
      return;
    }

    statusEl.className = 'save-toast';
    statusEl.textContent = `Fetching and reviewing remote ${platform} PR...`;
    statusEl.classList.remove('hidden');

    const body = { token: token || undefined };
    if (platform === 'github') {
      const prUrlMatch = target.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      const shortMatch = target.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (prUrlMatch) {
        body.owner = prUrlMatch[1];
        body.repo = prUrlMatch[2];
        body.pullNumber = Number(prUrlMatch[3]);
      } else if (shortMatch) {
        body.owner = shortMatch[1];
        body.repo = shortMatch[2];
        body.pullNumber = Number(shortMatch[3]);
      } else {
        alert('Invalid GitHub PR format. Use: owner/repo#123 or https://github.com/owner/repo/pull/123');
        return;
      }
    } else if (platform === 'gitlab') {
      const mrUrlMatch = target.match(/gitlab\.com\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)/);
      const shortMatch = target.match(/^([^#]+)#(\d+)$/);
      if (mrUrlMatch) {
        body.projectId = mrUrlMatch[1];
        body.mrIid = Number(mrUrlMatch[2]);
      } else if (shortMatch) {
        body.projectId = shortMatch[1];
        body.mrIid = Number(shortMatch[2]);
      } else {
        alert('Invalid GitLab MR format. Use: project#123 or https://gitlab.com/.../-/merge_requests/123');
        return;
      }
    } else if (platform === 'bitbucket') {
      const prUrlMatch = target.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
      const shortMatch = target.match(/^([^/]+)\/([^#]+)#(\d+)$/);
      if (prUrlMatch) {
        body.workspace = prUrlMatch[1];
        body.repoSlug = prUrlMatch[2];
        body.pullRequestId = Number(prUrlMatch[3]);
      } else if (shortMatch) {
        body.workspace = shortMatch[1];
        body.repoSlug = shortMatch[2];
        body.pullRequestId = Number(shortMatch[3]);
      } else {
        alert('Invalid Bitbucket PR format. Use: workspace/repo#123 or https://bitbucket.org/.../pull-requests/123');
        return;
      }
    }

    try {
      const res = await fetch(`/api/integrations/${platform}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        statusEl.className = 'save-toast error';
        statusEl.textContent = `Error: ${data.error}`;
        return;
      }
      statusEl.className = 'save-toast';
      statusEl.textContent = `✔ Review completed successfully! Loading Studio...`;
      switchToTab('studio');
      currentReview = data.review;
      currentParsedDiff = data.parsedDiff;
      if (currentReview.rawDiff) {
        document.getElementById('textareaDiff').value = currentReview.rawDiff;
        document.getElementById('inputPrTitle').value = currentReview.prTitle;
        document.getElementById('inputRepoName').value = currentReview.repository;
        updateDiffLineCounter();
      }
      renderReviewStudio(currentReview, currentParsedDiff);
    } catch (err) {
      statusEl.className = 'save-toast error';
      statusEl.textContent = `Review failed: ${err.message}`;
    }
  });

  initApp();
})();
