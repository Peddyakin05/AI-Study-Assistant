// ============================================================
// AI Study Assistant — Popup Script (Multi-provider)
// ============================================================

const PROVIDER_NAMES = {
  gemini: '🌟 Google Gemini',
  groq: '⚡ Groq',
  openai: '🤖 OpenAI',
  anthropic: '🧠 Anthropic (Claude)'
};

let settings = {};

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadStats();
  await loadLog();
  setupTabs();
  setupProviderCards();
  setupEvents();
  updateStatusBar();
});

// ── Provider Cards ────────────────────────────────────────────
function setupProviderCards() {
  // Expand/collapse on header click
  document.querySelectorAll('.provider-header').forEach(header => {
    header.addEventListener('click', function () {
      const provider = this.dataset.provider;
      if (!provider) return;
      const body = document.getElementById('body-' + provider);
      if (body) body.classList.toggle('open');
    });
  });

  // "Use This" buttons
  document.querySelectorAll('.btn-use').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const provider = this.dataset.btn;
      if (provider) saveProvider(provider);
    });
  });
}

async function saveProvider(p) {
  const keyEl = document.getElementById('key-' + p);
  const modelEl = document.getElementById('model-' + p);
  const apiKey = keyEl?.value?.trim() || '';
  const model = modelEl?.value || '';

  const newSettings = {
    activeProvider: p,
    providers: {
      ...(settings.providers || {}),
      [p]: { apiKey, model }
    }
  };

  await msg({ type: 'UPDATE_SETTINGS', settings: newSettings });
  settings = { ...settings, ...newSettings };
  updateActiveProviderUI(p);
  updateStatusBar();
  showNotice('save-notice-providers');
}

function updateActiveProviderUI(active) {
  for (const p of ['gemini', 'groq', 'openai', 'anthropic']) {
    const badge = document.getElementById('badge-' + p);
    const card = document.getElementById('card-' + p);
    const btn = document.getElementById('btn-' + p);
    if (badge) badge.style.display = p === active ? '' : 'none';
    if (card) card.classList.toggle('active-provider', p === active);
    if (btn) {
      btn.textContent = p === active ? '✓ Active' : 'Use This';
      btn.classList.toggle('active-btn', p === active);
    }
  }
  const nameEl = document.getElementById('active-provider-name');
  if (nameEl) nameEl.textContent = PROVIDER_NAMES[active] || 'None (heuristic fallback)';
}

async function loadSettings() {
  const resp = await msg({ type: 'GET_SETTINGS' });
  settings = resp?.settings || {};
  applySettingsToUI();
}

function applySettingsToUI() {
  const providers = settings.providers || {};
  for (const p of ['gemini', 'groq', 'openai', 'anthropic']) {
    const cfg = providers[p] || {};
    const keyEl = document.getElementById('key-' + p);
    const modelEl = document.getElementById('model-' + p);
    if (keyEl && cfg.apiKey) keyEl.value = cfg.apiKey;
    if (modelEl && cfg.model) {
      // Try to set value, fallback if option doesn't exist
      const opt = modelEl.querySelector(`option[value="${cfg.model}"]`);
      if (opt) modelEl.value = cfg.model;
    }
  }
  updateActiveProviderUI(settings.activeProvider);
  setToggle('toggle-enabled', settings.enabled !== false);
  setToggle('toggle-log', settings.logHistory !== false);
  setVal('overlay-position', settings.overlayPosition || 'top-right');
  setVal('overlay-size', settings.overlaySize || 'medium');
  setVal('scan-interval', (settings.scanInterval || 3000) / 1000);
  setVal('auto-click-count', settings.autoClickCount || 1);
  setVal('auto-click-interval', settings.autoClickIntervalSec || 0.3);
  setVal('hotkey', settings.hotkey || 'Alt+S');
  updateIntervalLabel();
  updateAutoClickLabel();
}

// ── Controls ──────────────────────────────────────────────────
function setupEvents() {
  document.getElementById('toggle-enabled').addEventListener('click', e => e.currentTarget.classList.toggle('on'));
  document.getElementById('toggle-log').addEventListener('click', e => e.currentTarget.classList.toggle('on'));
  document.getElementById('scan-interval').addEventListener('input', updateIntervalLabel);
  document.getElementById('auto-click-interval').addEventListener('input', updateAutoClickLabel);

  document.getElementById('save-controls').addEventListener('click', async () => {
    const newSettings = {
      enabled: document.getElementById('toggle-enabled').classList.contains('on'),
      logHistory: document.getElementById('toggle-log').classList.contains('on'),
      overlayPosition: getVal('overlay-position'),
      overlaySize: getVal('overlay-size'),
      scanInterval: Math.round(parseFloat(getVal('scan-interval')) * 1000),
      autoClickCount: Math.max(1, Math.round(parseFloat(getVal('auto-click-count')) || 1)),
      autoClickIntervalSec: Math.max(0.1, parseFloat(getVal('auto-click-interval')) || 0.3),
      hotkey: getVal('hotkey')
    };
    await msg({ type: 'UPDATE_SETTINGS', settings: newSettings });
    Object.assign(settings, newSettings);
    updateStatusBar();
    showNotice('save-notice-controls');
  });

  document.getElementById('clear-log').addEventListener('click', async () => {
    await msg({ type: 'CLEAR_LOG' });
    await loadLog();
    await loadStats();
  });
}

// ── Tabs ──────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-content').forEach(tc => {
        tc.classList.toggle('active', tc.id === 'tab-' + target);
      });
      if (target === 'log') loadLog();
    });
  });
}

async function loadStats() {
  const stats = await msg({ type: 'GET_STATS' });
  if (!stats) return;
  setText('s-total', stats.totalQuestions || 0);
  setText('s-conf', stats.avgConfidence ? stats.avgConfidence + '%' : '—');
  setText('s-time', stats.avgResponseTime ? stats.avgResponseTime + 'ms' : '—');
}

async function loadLog() {
  const resp = await msg({ type: 'GET_LOG' });
  const log = resp?.log || [];
  const container = document.getElementById('log-list');
  if (!log.length) {
    container.innerHTML = '<div class="empty-log">No questions logged yet.<br>Browse a quiz page to get started!</div>';
    return;
  }
  container.innerHTML = log.slice(0, 20).map(entry => {
    const pct = entry.confidence ? Math.round(entry.confidence * 100) : 0;
    return `
      <div class="log-item">
        <div class="log-q">${esc(entry.question?.slice(0, 80) || '—')}</div>
        <div class="log-a">→ ${esc(entry.answer?.slice(0, 60) || '—')}</div>
        <div class="log-meta">
          <span class="log-conf">${pct}% conf.</span>
          ${entry.responseTime ? `<span class="log-time">⚡ ${entry.responseTime}ms</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────
function updateStatusBar() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const active = settings.enabled !== false;
  dot.className = 'dot ' + (active ? 'active' : 'paused');
  const provider = PROVIDER_NAMES[settings.activeProvider] || 'heuristic fallback';
  text.textContent = active ? 'Active · ' + provider : 'Paused';
}
function updateIntervalLabel() {
  const val = parseFloat(getVal('scan-interval'));
  document.getElementById('interval-val').textContent = val + 's';
}
function updateAutoClickLabel() {
  const val = parseFloat(getVal('auto-click-interval'));
  document.getElementById('auto-click-interval-val').textContent = val + 's';
}
function showNotice(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}
function msg(payload) {
  return new Promise(resolve => chrome.runtime.sendMessage(payload, resp => resolve(resp)));
}
function setToggle(id, on) { document.getElementById(id)?.classList.toggle('on', on); }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function getVal(id) { return document.getElementById(id)?.value || ''; }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function esc(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
