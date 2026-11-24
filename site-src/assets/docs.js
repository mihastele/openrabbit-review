(() => {
  const root = document.body.dataset.root || '';
  const storageKey = 'openrabbit-docs-theme';
  const themeButton = document.querySelector('[data-theme-toggle]');

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      /* Storage can be disabled; the current page still changes. */
    }
    if (themeButton) {
      themeButton.setAttribute('aria-pressed', String(theme === 'light'));
      themeButton.setAttribute('aria-label', theme === 'light' ? 'Use dark theme' : 'Use light theme');
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f3eee5' : '#0a0b0d');
  }

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {
    /* Ignore unavailable storage. */
  }
  setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  themeButton?.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  const body = document.body;
  const sidebarButtons = document.querySelectorAll('[data-sidebar-toggle]');
  const sidebarClose = document.querySelectorAll('[data-sidebar-close]');

  function setSidebar(open) {
    body.classList.toggle('sidebar-open', open);
    sidebarButtons.forEach((button) => button.setAttribute('aria-expanded', String(open)));
    if (open) {
      document.querySelector('[data-sidebar] .nav-item')?.focus();
    }
  }

  sidebarButtons.forEach((button) => {
    button.addEventListener('click', () => setSidebar(!body.classList.contains('sidebar-open')));
  });
  sidebarClose.forEach((button) => {
    button.addEventListener('click', () => setSidebar(false));
  });

  // Wrap code blocks with a language label and copy affordance.
  document.querySelectorAll('.doc-content pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('code-block')) return;
    const code = pre.querySelector('code');
    const language =
      code?.className.match(/language-([a-z0-9_+-]+)/i)?.[1]?.toLowerCase() || 'text';
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';
    const label = document.createElement('span');
    label.textContent = language === 'dotenv' ? '.env' : language;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-button';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code block');
    toolbar.append(label, button);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(toolbar, pre);
    button.addEventListener('click', async () => {
      const text = code?.textContent || pre.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      button.textContent = 'Copied';
      button.classList.add('copied');
      window.setTimeout(() => {
        button.textContent = 'Copy';
        button.classList.remove('copied');
      }, 1600);
    });
  });

  // Reveal content as it enters the viewport. Landing sections opt in with .reveal.
  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 }
    );
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('in'));
  }

  // Reading progress for documentation pages.
  const progress = document.querySelector('[data-page-progress]');
  if (progress) {
    const updateProgress = () => {
      const height = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = height > 0 ? Math.min(1, window.scrollY / height) : 0;
      progress.style.width = `${ratio * 100}%`;
    };
    updateProgress();
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress);
  }

  // Highlight the current section in the right-hand table of contents.
  const tocLinks = Array.from(document.querySelectorAll('[data-toc-link]'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(tocLinks.map((link) => [link.dataset.tocLink, link]));
    const tocObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          tocLinks.forEach((link) => link.classList.remove('active'));
          byId.get(entry.target.id)?.classList.add('active');
        });
      },
      { rootMargin: '-15% 0px -72% 0px', threshold: 0 }
    );
    byId.forEach((_, id) => {
      const heading = document.getElementById(id);
      if (heading) tocObserver.observe(heading);
    });
  }

  // Client-side search over the generated index.
  const searchIndex = Array.isArray(window.OPENRABBIT_SEARCH) ? window.OPENRABBIT_SEARCH : [];
  let searchModal;
  let searchInput;
  let searchResults;
  let selected = 0;
  let matches = [];

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function buildSearch() {
    if (searchModal) return;
    searchModal = document.createElement('div');
    searchModal.className = 'search-modal';
    searchModal.innerHTML = `
      <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search documentation">
        <div class="search-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          <input type="search" placeholder="Search guides, features, providers…" autocomplete="off" spellcheck="false">
          <kbd>esc</kbd>
        </div>
        <div class="search-results" role="listbox" aria-label="Search results"></div>
        <div class="search-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>⌘K</kbd> search</span></div>
      </div>`;
    document.body.append(searchModal);
    searchInput = searchModal.querySelector('input');
    searchResults = searchModal.querySelector('.search-results');
    searchInput.addEventListener('input', () => renderSearch(searchInput.value));
    searchModal.addEventListener('click', (event) => {
      if (event.target === searchModal) closeSearch();
    });
    renderSearch('');
  }

  function renderSearch(query) {
    const normalized = query.trim().toLowerCase();
    matches = searchIndex
      .map((page) => {
        const headingHit = page.headings.find((heading) =>
          heading.toLowerCase().includes(normalized)
        );
        const haystack = `${page.title} ${page.group} ${page.description} ${page.headings.join(' ')}`.toLowerCase();
        const score = normalized
          ? page.title.toLowerCase().includes(normalized)
            ? 3
            : headingHit
              ? 2
              : haystack.includes(normalized)
                ? 1
                : 0
          : 1;
        return { page, score, headingHit };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.page);

    selected = Math.min(selected, Math.max(0, matches.length - 1));
    if (!matches.length) {
      searchResults.innerHTML = '<div class="search-empty">No page matches that search.</div>';
      return;
    }
    searchResults.innerHTML = matches
      .map(
        (page, index) => `<a class="search-result${index === selected ? ' selected' : ''}" role="option" aria-selected="${index === selected}" href="${root}${page.href}">
          <strong>${escapeHtml(page.title)}<span>${escapeHtml(page.group)}</span></strong>
          <p>${escapeHtml(page.description)}</p>
        </a>`
      )
      .join('');
  }

  function selectResult(delta) {
    if (!matches.length) return;
    selected = (selected + delta + matches.length) % matches.length;
    renderSearch(searchInput.value);
    searchResults.querySelector('.search-result.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function openSearch() {
    buildSearch();
    searchModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    selected = 0;
    searchInput.value = '';
    renderSearch('');
    window.setTimeout(() => searchInput.focus(), 20);
  }

  function closeSearch() {
    if (!searchModal) return;
    searchModal.classList.remove('open');
    document.body.style.overflow = '';
  }

  document.querySelectorAll('[data-search-open]').forEach((button) => {
    button.addEventListener('click', openSearch);
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '')) {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === 'Escape') {
      if (searchModal?.classList.contains('open')) closeSearch();
      else if (body.classList.contains('sidebar-open')) setSidebar(false);
      return;
    }
    if (!searchModal?.classList.contains('open')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectResult(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectResult(-1);
    } else if (event.key === 'Enter') {
      const target = matches[selected];
      if (target) window.location.href = `${root}${target.href}`;
    }
  });

  // Landing rail: indicate which section is in view.
  const railLinks = Array.from(document.querySelectorAll('.rail-nav a'));
  if (railLinks.length && 'IntersectionObserver' in window) {
    const targets = railLinks
      .map((link) => {
        const id = link.getAttribute('href')?.replace('#', '');
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean);
    const railObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          railLinks.forEach((link) => link.classList.remove('active'));
          railLinks
            .find((link) => link.getAttribute('href') === `#${entry.target.id}`)
            ?.classList.add('active');
        });
      },
      { rootMargin: '-25% 0px -55% 0px', threshold: 0 }
    );
    targets.forEach((target) => railObserver.observe(target));
  }
})();
