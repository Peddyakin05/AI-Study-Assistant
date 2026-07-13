// ============================================================
// AI Study Assistant — Content Script
// ============================================================
// Injected into every page. Detects questions, triggers AI,
// renders the overlay, never auto-clicks anything.
// ============================================================

(function () {
  'use strict';

  // ── Guard: prevent double injection ───────────────────────
  if (window.__asaLoaded) return;
  window.__asaLoaded = true;

  // ── State ─────────────────────────────────────────────────
  let settings = {};
  let scanTimer = null;
  let lastQuestionHash = '';
  let isEnabled = true;
  let overlay = null;
  let isDragging = false;
  let isResizing = false;
  let dragOffset = { x: 0, y: 0 };
  let resizeState = null;
  let pendingRequest = false;
  let mutationDebounceTimer = null;
  let navigationScanTimer = null;
  let mutationMissedDuringPending = false; // track mutations that fired while a request was in flight
  let detectedQuestions = [];   // all questions found on page
  let currentQuestionIndex = 0; // which one is shown
  let autoSelectEnabled = true;  // auto-select correct answer (on by default)
  let lastDetected = null;       // last detected question+result pair
  let autoSelectTimer = null;
  let analysisGeneration = 0;
  let suppressNavigationClickUntil = 0;
  const MUTATION_SCAN_DEBOUNCE_MS = 350;
  const NAVIGATION_SCAN_DELAY_MS = 650;

  const EXCLUDED_SELECTOR = [
    '#asa-overlay',
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'nav',
    'header',
    'footer',
    '[aria-hidden="true"]',
    '[hidden]'
  ].join(',');

  const QUESTION_CONTAINER_SELECTOR = [
    'fieldset',
    'form',
    '[role="group"]',
    '[role="radiogroup"]',
    '[class*="question" i]',
    '[id*="question" i]',
    '[class*="quiz" i]',
    '[class*="assessment" i]',
    '[class*="problem" i]',
    '[data-testid*="question" i]',
    '[data-automation-id*="question" i]',
    'multiple-choice-question'  // NotebookLM
  ].join(',');

  const CHOICE_SELECTOR = [
    'input[type="radio"]',
    'input[type="checkbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="option"]',
    'button',
    'label',
    '[class*="choice" i]',
    '[class*="option" i]',
    '[class*="answer" i]'
  ].join(',');

  // ── Bootstrap ─────────────────────────────────────────────
  init();

  async function init() {
    const resp = await sendMessage({ type: 'GET_SETTINGS' });
    if (resp?.settings) {
      settings = resp.settings;
      isEnabled = settings.enabled;
      autoSelectEnabled = settings.autoSelectEnabled !== false;
    }

    createOverlay();
    registerHotkey();
    startScanLoop();
    registerClickDetection();

    // Watch for dynamically loaded content (SPAs like Canvas, Coursera)
    new MutationObserver((mutations) => {
      if (mutations.every(shouldIgnoreMutation)) return;
      if (mutations.every(isTimerOnlyMutation)) return;
      queueScan();
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    registerNavigationScanFallback();

    // Tell background this tab is active
    sendMessage({ type: 'TAB_ACTIVE' });
    window.addEventListener('beforeunload', () =>
      sendMessage({ type: 'TAB_INACTIVE' }));
  }

  // ── Message listener ──────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_UPDATED') {
      settings = msg.settings;
      isEnabled = settings.enabled;
      autoSelectEnabled = settings.autoSelectEnabled !== false;
      applyOverlaySettings();
      if (isEnabled) {
        updateActiveUI();
        startScanLoop();
      } else {
        updateStoppedUI();
        stopScanLoop();
      }
    }
  });

  // ── Scan Loop ─────────────────────────────────────────────
  function startScanLoop() {
    stopScanLoop();
    if (!isEnabled) return;
    scan();
    scanTimer = setInterval(scan, Math.max(500, settings.scanInterval || 3000));
  }

  function stopScanLoop() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  }

  async function scan(options = {}) {
    const force = options.force === true;
    const manual = options.manual === true;
    const startup = options.startup === true;

    // Startup scans skip the pendingRequest block so they always try
    if ((!isEnabled && !force) || (pendingRequest && !startup) || (document.hidden && !force)) {
      if (manual && pendingRequest) showOverlayError('Still analyzing. Try again in a moment.');
      return;
    }

    const questions = detectAllQuestions();
    if (!questions.length) {
      if (manual) showOverlayError('No question detected on the visible page.');
      return;
    }

    const pageHash = getQuestionSetHash(questions);

    if (force || pageHash !== lastQuestionHash) {
      detectedQuestions = questions; // reset on every force/change
      currentQuestionIndex = 0;
      lastQuestionHash = pageHash;
      await analyzeAndShowQuestion(currentQuestionIndex);
      return;
    }
  }

  async function analyzeAndShowQuestion(index, retry = false) {
    const detected = detectedQuestions[index];
    if (!detected) return;
    const generation = analysisGeneration;

    showOverlayLoading();
    pendingRequest = true;

    try {
      const result = await sendMessage({
        type: 'ANALYZE_QUESTION',
        payload: {
          question: detected.question,
          choices: detected.choices,
          context: detected.context,
          url: location.href
        }
      });
      if (generation === analysisGeneration && isEnabled) {
        showOverlayResult(result, detected);
      }
    } catch (e) {
      if (generation !== analysisGeneration || !isEnabled) return;
      if (!retry && e.message?.includes('timed out')) {
        // Service worker was sleeping — wake it up and retry once.
        // Don't clear pendingRequest here; keep it true across the gap so any
        // mutation that fires during the retry wait is still captured by
        // queueScan() instead of being silently dropped.
        await new Promise(r => setTimeout(r, 500));
        return analyzeAndShowQuestion(index, true);
      }
      showOverlayError(e.message);
    } finally {
      if (generation === analysisGeneration) pendingRequest = false;
      // If the page changed while we were analyzing (e.g. auto-click advanced
      // to the next question), re-scan right away instead of waiting for the
      // next interval tick or a manual rescan.
      if (generation === analysisGeneration && isEnabled && mutationMissedDuringPending) {
        mutationMissedDuringPending = false;
        // Use a short delay so the new question's DOM fully renders first.
        // Keep the normal hash guard so our own auto-select click does not
        // force-analyze the same question forever.
        setTimeout(() => scan(), 300);
      }
    }
  }

  function toggleJumpPanel() {
    const jump = document.getElementById('asa-jump');
    const isVisible = jump.style.display !== 'none';
    if (isVisible) {
      jump.style.display = 'none';
    } else {
      // Detect all questions first so we know how many there are
      const questions = detectAllQuestions();
      detectedQuestions = questions;
      const total = questions.length;
      document.getElementById('asa-jump-info').textContent = total
        ? `${total} question${total > 1 ? 's' : ''} found on this page`
        : 'No questions detected yet — try rescanning first';
      document.getElementById('asa-jump-input').max = total;
      document.getElementById('asa-jump-input').value = '';
      jump.style.display = '';
      setTimeout(() => document.getElementById('asa-jump-input').focus(), 50);
    }
  }

  async function jumpToQuestion() {
    const input = document.getElementById('asa-jump-input');
    const num = parseInt(input.value);
    const total = detectedQuestions.length;

    if (!num || num < 1 || num > total) {
      document.getElementById('asa-jump-info').textContent =
        total ? `Enter a number between 1 and ${total}` : 'No questions found — rescan first';
      return;
    }

    document.getElementById('asa-jump').style.display = 'none';
    currentQuestionIndex = num - 1;
    await analyzeAndShowQuestion(currentQuestionIndex);
  }

  // ── Click Detection ────────────────────────────────────────
  function registerClickDetection() {
    document.addEventListener('mousedown', e => {
      if (!isEnabled || pendingRequest) return;
      if (e.target.closest('#asa-overlay')) return;

      const control = e.target.closest(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"], label'
      );
      if (!control) return;

      const container = findQuestionContainer(control);
      if (!container) return;

      const choices = extractChoicesFromContainer(container);
      if (choices.length < 2) return;
      const question = findQuestionText(container, control, choices);
      if (!question || !isLikelyQuestion(question)) return;

      const clicked = buildResult(question, choices, getContext(container));

      // Only re-analyze if it's a different question than current
      const clickHash = getQuestionSetHash([clicked]);
      const currentHash = detectedQuestions[currentQuestionIndex]
        ? getQuestionSetHash([detectedQuestions[currentQuestionIndex]])
        : '';

      if (clickHash !== currentHash) {
        // Pause scan loop briefly so it doesn't overwrite with question 1
        stopScanLoop();
        lastQuestionHash = clickHash;
        detectedQuestions = [clicked];
        currentQuestionIndex = 0;
        analyzeAndShowQuestion(0).then(() => {
          // Resume scan loop after analysis completes
          startScanLoop();
        });
      }
    }, true);
  }

  function registerNavigationScanFallback() {
    document.addEventListener('click', (e) => {
      if (!isEnabled || pendingRequest || !e.isTrusted) return;
      if (Date.now() < suppressNavigationClickUntil) return;
      if (e.target.closest('#asa-overlay')) return;

      const control = e.target.closest('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]');
      if (!control || !isLikelyNavigationControl(control)) return;
      scheduleNavigationScan();
    }, true);
  }

  function isLikelyNavigationControl(control) {
    const text = normalizeText(
      control.textContent ||
      control.value ||
      control.getAttribute?.('aria-label') ||
      control.getAttribute?.('title') ||
      ''
    );
    if (!text) return true;
    return /\b(next|continue|submit|skip|start|retry|again|finish|check|save|proceed|question)\b/.test(text) ||
      /^[>›»→]+$/.test(text);
  }

  function scheduleNavigationScan() {
    clearTimeout(navigationScanTimer);
    navigationScanTimer = setTimeout(() => {
      if (!isEnabled || pendingRequest || document.hidden) return;
      scan({ force: true });
    }, NAVIGATION_SCAN_DELAY_MS);
  }

  function toggleAutoSelect() {
    autoSelectEnabled = !autoSelectEnabled;
    const btn = document.getElementById('asa-autoselect-toggle');
    const selectNow = document.getElementById('asa-select-now');
    btn.textContent = autoSelectEnabled ? 'ON' : 'OFF';
    btn.classList.toggle('on', autoSelectEnabled);
    // Show "Select Now" button when auto is off (manual trigger)
    selectNow.style.display = autoSelectEnabled ? 'none' : '';
    sendMessage({ type: 'UPDATE_SETTINGS', settings: { autoSelectEnabled } });
  }

  function autoSelectAnswer({ result, detected } = {}) {
    if (!result || !detected) return;

    const answerText = (result.answer || '').trim();
    if (!answerText || answerText === '—') return;

    // Extract answer letter if present e.g. "A) Volt" or "A. Volt" → "A"
    const answerLetter = extractAnswerLetter(answerText);

    // Extract answer text without the letter prefix
    const cleanAnswer = answerText
      .replace(/^(?:answer\s*[:\-]?\s*)?\(?[A-Ea-e]\)?[\.\):\-\s]*/i, '')
      .toLowerCase()
      .trim();

    const totalClicks = Math.max(1, Math.floor(settings.autoClickCount || 1));
    const intervalMs = Math.max(100, Math.round((settings.autoClickIntervalSec || 0.3) * 1000));

    let attempts = 1;
    let everClicked = false;

    // First click immediately — no delay
    const ok = attemptClick(answerLetter, cleanAnswer, detected);
    if (ok) { everClicked = true; flashSelectNow('✅ Selected!'); }

    if (autoSelectTimer) {
      clearInterval(autoSelectTimer);
      autoSelectTimer = null;
    }

    if (totalClicks <= 1) {
      if (!everClicked) {
        flashSelectNow('⏱ Too late — click manually', true);
      }
      return;
    }

    // Retry only for the configured number of total attempts.
    autoSelectTimer = setInterval(() => {
      attempts++;
      const ok = attemptClick(answerLetter, cleanAnswer, detected);
      if (ok) {
        everClicked = true;
        flashSelectNow('✅ Selected!');
      }
      if (attempts >= totalClicks) {
        clearInterval(autoSelectTimer);
        autoSelectTimer = null;
        if (!everClicked) {
          flashSelectNow('⏱ Too late — click manually', true);
        }
      }
    }, intervalMs);
  }

  function attemptClick(answerLetter, cleanAnswer, detected) {
    // Build a broad pool of all clickable choice elements:
    // 1. Standard radio/checkbox controls
    // 2. ARIA roles
    // 3. Custom div/button answer boxes (common on quiz sites like nacoslasu)
    const container = document.body;
    const standardControls = Array.from(container.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="option"]'
    )).filter(isVisible).filter(isClickEnabled);

    // Explicitly target known quiz button containers (nacoslasu uses #options-container)
    const knownContainerControls = Array.from(container.querySelectorAll(
      '#options-container button, #options-container > *, [id*="options-container"] button, [onclick*="handleOptionSelection"]'
    )).filter(isVisible).filter(isClickEnabled);

    // Plain buttons that contain answer text (whodeyonline style)
    // Exclude very short UI buttons (< 3 chars) and overlay buttons
    const plainButtons = Array.from(container.querySelectorAll('button'))
      .filter(el =>
        isVisible(el) &&
        !el.closest('#asa-overlay') &&
        el.textContent.trim().length >= 3 &&
        el.textContent.trim().length < 300
      )
      .filter(isClickEnabled);

    const customControls = Array.from(container.querySelectorAll(
      '[class*="answer" i], [class*="option" i], [class*="choice" i], [class*="Answer" i], [class*="Option" i]'
    )).filter(el =>
      isVisible(el) &&
      !el.closest('#asa-overlay') &&
      (el.tagName === 'DIV' || el.tagName === 'BUTTON' || el.tagName === 'LI' || el.tagName === 'SPAN') &&
      el.querySelectorAll('[class*="answer" i], [class*="option" i]').length === 0 // leaf nodes only
    ).filter(isClickEnabled);

    const allControls = [...standardControls, ...knownContainerControls, ...plainButtons, ...customControls];

    // Strategy 1: match by answer TEXT content first — this is what the AI
    // actually reasoned through and is more trustworthy than the letter it
    // assigned, since the AI can sometimes get the right answer but label it
    // with the wrong letter (e.g. says "A) A + B" but "A + B" is really option B)
    if (cleanAnswer.length > 1) {
      const normAnswer = normalizeText(cleanAnswer);
      let bestMatch = null;
      let bestScore = 0;

      for (const control of allControls) {
        const labelText = normalizeText(control.textContent || getChoiceText(control));
        if (!labelText) continue;

        // Exact match — highest confidence
        if (labelText === normAnswer) {
          clickControl(control);
          return true;
        }

        // Partial match — score by how much overlap there is, prefer the
        // closest length match to avoid a short answer matching a much
        // longer unrelated button (or vice versa)
        if (labelText.length >= 1 && normAnswer.length >= 1) {
          const shorter = labelText.length < normAnswer.length ? labelText : normAnswer;
          const longer  = labelText.length < normAnswer.length ? normAnswer : labelText;
          if (longer.includes(shorter)) {
            const score = shorter.length / longer.length; // closer lengths = higher score
            if (score > bestScore) {
              bestScore = score;
              bestMatch = control;
            }
          }
        }
      }

      // Require a reasonably strong partial match (avoid clicking on a
      // near-unrelated button just because of a 2-3 character overlap)
      if (bestMatch && bestScore >= 0.5) {
        clickControl(bestMatch);
        return true;
      }
    }

    // Strategy 2: fall back to letter position ONLY if no text match was found
    // (e.g. answer came back with just a letter and no usable text)
    if (answerLetter && detected.choices.length) {
      const idx = answerLetter.charCodeAt(0) - 65; // A=0, B=1...
      if (idx >= 0 && idx < detected.choices.length) {
        const targetChoice = normalizeText(detected.choices[idx]);
        const positionalControls = getLikelyChoiceControls(allControls, detected.choices.length);
        if (positionalControls[idx]) {
          clickControl(positionalControls[idx]);
          return true;
        }
        for (const control of allControls) {
          const labelText = normalizeText(getChoiceText(control));
          if (labelText.includes(targetChoice.slice(0, 50)) || targetChoice.includes(labelText.slice(0, 50))) {
            clickControl(control);
            return true;
          }
        }
        for (const control of customControls) {
          const text = control.textContent.trim();
          if (text.startsWith(answerLetter + ' ') || text.startsWith(answerLetter + '.') || text.startsWith(answerLetter + ')')) {
            clickControl(control);
            return true;
          }
        }
      }
    }

    // Strategy 3: match by letter label on the element itself
    if (answerLetter) {
      for (const control of customControls) {
        const text = control.textContent.trim();
        if (text.startsWith(answerLetter + ' ') || text.startsWith(answerLetter + '.') || text.startsWith(answerLetter + ')')) {
          clickControl(control);
          return true;
        }
      }
    }

    // Strategy 4: whodeyonline-style — match plain buttons by full text content
    if (cleanAnswer.length > 2) {
      const normAnswer = normalizeText(cleanAnswer);
      for (const control of plainButtons) {
        const btnText = normalizeText(control.textContent);
        if (btnText === normAnswer || btnText.includes(normAnswer) || normAnswer.includes(btnText)) {
          clickControl(control);
          return true;
        }
      }
    }

    return false;
  }

  // Normalize text for matching — lowercases, trims, and replaces special
  // chars like → ➜ → with simple hyphens/spaces so they don't break matching
  function extractAnswerLetter(answerText) {
    const match = String(answerText || '').trim().match(
      /^(?:answer\s*[:\-]?\s*)?\(?([A-Ea-e])\)?(?:[\.\):\-]|\s|$)/
    );
    return match ? match[1].toUpperCase() : null;
  }

  function getLikelyChoiceControls(controls, expectedCount) {
    const seen = new Set();
    const choices = [];
    for (const control of controls) {
      const clickable = control.closest?.('label, button, [role="radio"], [role="checkbox"], [role="option"], li, div') || control;
      if (seen.has(clickable)) continue;
      const text = normalizeText(getChoiceText(clickable));
      if (!text || text.length > 300) continue;
      seen.add(clickable);
      choices.push(clickable);
      if (choices.length >= expectedCount) break;
    }
    return choices;
  }

  function normalizeText(str) {
    return (str || '')
      .toLowerCase()
      .trim()
      .replace(/→|➜|►|▶|->|»/g, ' ')  // navigational arrow variants only (these
                                          // are used for sequence/ordering answers
                                          // like "2GB → 1.5GB" where direction
                                          // itself doesn't distinguish choices)
      // Strip only truly decorative/punctuation characters. Keep everything
      // that can distinguish one answer from another: apostrophes (Boolean
      // NOT: A' vs A), + and · and * (Boolean OR/AND, multiplication),
      // = (equations), ÷ and / (division), - (subtraction/negative numbers),
      // ^ (exponents), and () (grouping in expressions).
      .replace(/[^\w\s.,%'+\-*/÷×·^()=]/g, ' ')
      .replace(/\s+/g, ' ')              // collapse whitespace
      .trim();
  }

  // Filters out controls the site has explicitly disabled/locked. This is
  // the main reason auto-select can silently "do nothing": the button is
  // still visible and even still shows cursor:pointer in some cases, but the
  // framework's own click handler will no-op once `disabled` is set —
  // whodeyonline uses BOTH mechanisms depending on the page:
  //  - the HTML `disabled` attribute (e.g. /coin-hunt/play)
  //  - cursor:not-allowed via inline style as the round timer hits 0 (e.g. /live)
  function isClickEnabled(el) {
    if (!el) return false;
    if (el.disabled === true) return false;
    if (el.hasAttribute?.('disabled')) return false;
    if (el.getAttribute?.('aria-disabled') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.pointerEvents === 'none') return false;
    if (style.cursor === 'not-allowed') return false;
    return true;
  }

  function flashSelectNow(text, isWarning = false) {
    const btn = document.getElementById('asa-select-now');
    if (!btn) return;
    const orig = btn.dataset.origText || btn.textContent;
    btn.dataset.origText = orig;
    btn.textContent = text;
    btn.classList.toggle('asa-warning', isWarning);
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('asa-warning');
    }, 2000);
  }

  function clickControl(el) {
    suppressNavigationClickUntil = Date.now() + 1500;
    if (el.tagName === 'INPUT') {
      el.click();
      el.dispatchEvent(new MouseEvent('change', { bubbles: true }));
    } else {
      // Fire full mouse event sequence for React/JSX sites
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }

  // ── Bulk Answers ───────────────────────────────────────────
  async function runBulkAnswers() {
    if (pendingRequest) return;

    const questions = detectAllQuestions();
    if (!questions.length) {
      showOverlayError('No questions detected on this page.');
      return;
    }

    setSection('asa-bulk');
    overlay.style.display = '';
    const listEl = document.getElementById('asa-bulk-list');
    listEl.innerHTML = `<div class="asa-bulk-loading">⚡ Analyzing question 1 of ${questions.length}…</div>`;
    pendingRequest = true;

    const answers = [];

    try {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];

        // Update loading message
        listEl.innerHTML = `<div class="asa-bulk-loading">⚡ Analyzing question ${i + 1} of ${questions.length}…</div>`;

        try {
          const result = await sendMessage({
            type: 'ANALYZE_QUESTION',
            payload: {
              question: q.question,
              choices: q.choices,
              context: 'Give ONLY the answer letter and text, no explanation. Format: "A) answer text"',
              url: location.href
            }
          });

          const answer = (result.answer || '').replace(/^(suggested answer[:\s]*)/i, '').trim();
          answers.push(`${i + 1}. ${answer}`);
        } catch (e) {
          answers.push(`${i + 1}. Error`);
        }

        // Show results so far as they come in
        listEl.innerHTML = answers.map(a => `<div class="asa-bulk-item">${esc(a)}</div>`).join('');
      }
    } finally {
      pendingRequest = false;
    }
  }

  function copyBulkAnswers() {
    const listEl = document.getElementById('asa-bulk-list');
    const text = Array.from(listEl.querySelectorAll('.asa-bulk-item')).map(el => el.textContent).join('\n');
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('asa-bulk-copy');
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = 'Copy All'; }, 2000);
      });
    }
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function queueScan() {
    if (!isEnabled) return;
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(() => {
      if (!isEnabled) return;
      if (pendingRequest) {
        // A mutation happened while we were mid-analysis (e.g. the page advanced
        // to the next question right after our own auto-click). Remember it so
        // we re-scan the instant the in-flight request finishes, instead of
        // dropping it and waiting for the next interval tick or a manual rescan.
        mutationMissedDuringPending = true;
        return;
      }
      scan();
    }, MUTATION_SCAN_DEBOUNCE_MS);
  }

  // ── Question Detection ─────────────────────────────────────
  function shouldIgnoreMutation(mutation) {
    const isOverlayNode = node => {
      if (!node) return false;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return !!el?.closest?.('#asa-overlay');
    };
    if (isOverlayNode(mutation.target)) return true;
    const changedNodes = [
      ...Array.from(mutation.addedNodes || []),
      ...Array.from(mutation.removedNodes || [])
    ];
    return changedNodes.length > 0 && changedNodes.every(isOverlayNode);
  }

  function isTimerOnlyMutation(mutation) {
    if (mutation.type !== 'characterData') return false;
    return /^[\d\s:.-]+$/.test(mutation.target?.textContent || '');
  }

  function detectQuestion() {
    // Strategy 1: real form controls and ARIA widgets
    let q = detectViaFormControls();
    if (q) return q;

    // Strategy 2: known quiz platform selectors
    q = detectViaSelectors();
    if (q) return q;

    // Strategy 3: score likely question containers in the visible page
    q = detectViaQuestionContainers();
    if (q) return q;

    // Strategy 4: conservative visible-text fallback
    q = detectViaHeuristic();
    return q;
  }

  // Detect ALL questions on the page (for multi-question pages)
  function detectAllQuestions() {
    const all = [];
    const seen = new Set();

    function addIfNew(q) {
      if (!q) return;
      const key = hashString(q.question + q.choices.join(''));
      if (!seen.has(key)) { seen.add(key); all.push(q); }
    }

    // Strategy 1: form controls — each group is a separate question
    const controls = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]'))
      .filter(isUsableChoiceControl);
    const groups = new Map();
    for (const control of controls) {
      const key = getChoiceGroupKey(control);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(control);
    }
    for (const groupControls of groups.values()) {
      if (groupControls.length < 2) continue;
      const container = findQuestionContainer(groupControls[0]);
      const choices = uniqueClean(groupControls.map(getChoiceText)).filter(isGoodChoice);
      const question = findQuestionText(container, groupControls[0], choices);
      if (question && choices.length >= 2) addIfNew(buildResult(question, choices, getContext(container || groupControls[0])));
    }

    // Strategy 2: platform selectors — each matching question element
    for (const sel of QUIZ_SELECTORS) {
      const qEls = document.querySelectorAll(sel.q);
      for (const qEl of qEls) {
        if (!isVisible(qEl)) continue;
        const question = cleanQuestionText(getElementText(qEl));
        const aEls = document.querySelectorAll(sel.a);
        const choices = uniqueClean(Array.from(aEls).filter(isVisible).map(getChoiceText)).filter(isGoodChoice);
        if (isLikelyQuestion(question) && choices.length >= 2) addIfNew(buildResult(question, choices, getContext(qEl)));
      }
    }

    // Strategy 3: question containers
    const containers = getVisibleElements(QUESTION_CONTAINER_SELECTOR)
      .filter(el => !el.closest('#asa-overlay'))
      .slice(0, 80);
    for (const container of containers) {
      const choices = extractChoicesFromContainer(container);
      if (choices.length < 2) continue;
      const question = findQuestionText(container, choices[0], choices);
      if (question) addIfNew(buildResult(question, choices, getContext(container)));
    }

    // Strategy 4: heuristic for any remaining question
    if (all.length === 0) {
      const q = detectViaHeuristic();
      if (q) addIfNew(q);
    }

    return all;
  }

  function detectViaFormControls() {
    const controls = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]'))
      .filter(isUsableChoiceControl);
    if (controls.length < 2) return null;

    const groups = new Map();
    for (const control of controls) {
      const key = getChoiceGroupKey(control);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(control);
    }

    const candidates = [];
    for (const groupControls of groups.values()) {
      if (groupControls.length < 2) continue;
      const container = findQuestionContainer(groupControls[0]);
      const choices = uniqueClean(groupControls.map(getChoiceText)).filter(isGoodChoice);
      const question = findQuestionText(container, groupControls[0], choices);
      if (question && choices.length >= 2) {
        candidates.push({
          score: scoreDetection(question, choices, container),
          result: buildResult(question, choices, getContext(container || groupControls[0]))
        });
      }
    }

    return bestCandidate(candidates);
  }

  const QUIZ_SELECTORS = [
    // NotebookLM (quiz feature - question is h1.question-text, answers in div.answer-options)
    { q: '.question-text, .question-heading .question-text, multiple-choice-question .question-text', a: '.answer-options > *, .answer-option, [class*="answer-option"]' },
    // whodeyonline.com — plain buttons with jsx- classes
    { q: 'main [class*="jsx-"] h1, main [class*="jsx-"] h2, main [class*="jsx-"] h3, section [class*="jsx-"] h1, section [class*="jsx-"] h2, section [class*="jsx-"] h3', a: 'button[class*="jsx-"]' },
    // Coursera
    { q: '[data-testid="question-text"], .rc-FormPartsQuestion', a: '.rc-Option, [data-testid="answer-option"]' },
    // Khan Academy
    { q: '.exercise-question-content, ._1Tsoh', a: '._1d8Os, .perseus-radio-option' },
    // Google Forms
    { q: '[data-params*="question"], .freebirdFormviewerComponentsQuestionBaseTitle', a: '.freebirdFormviewerComponentsQuestionRadioChoice' },
    // Quizlet
    { q: '.SetPageTerms-term, .FormattedText.notranslate', a: '.UIButton-label' },
    // Kahoot
    { q: '.question-title, [data-functional-selector="question-title"]', a: '.question-choice, [data-functional-selector*="choice"]' },
    // Moodle
    { q: '.qtext, .formulation', a: '.answer label, .answernumber' },
    // Blackboard
    { q: '.vtbegenerated, .question-stem', a: '.answer-text, input[type="radio"] + label' },
    // Canvas
    { q: '.question_text, .quiz_sorted_items .question', a: '.answer_label, .answer_text' },
    // edX
    { q: '.problem-statement, .problem p, [class*="problem-header"]', a: '.choicegroup label, .choice label, .inputtype label' },
    // Udemy
    { q: '[data-purpose="question-headline"], .mc-quiz-question--question--text', a: '[data-purpose="answer-option-label"], .mc-quiz-answer--answer--label' },
    // Duolingo
    { q: '[data-test="challenge-header"], ._3FoHK', a: '[data-test="challenge-choice"], ._2BKXK' },
    // Chegg
    { q: '.question-body, [class*="questionBody"]', a: '[class*="answerOption"], [class*="answer-option"]' },
    // Schoology
    { q: '.question-body .text, .mc-option-text + .question-text', a: '.mc-option-label, .answer-choice label' },
    // ProProfs / generic test engines
    { q: '.question-text, [class*="QuestionText"], [class*="question-stem"]', a: '[class*="AnswerOption"], [class*="answer-option"], [class*="choice-text"]' },
    // Generic quiz patterns
    { q: '[class*="question-text"], [class*="question_text"], [class*="questionText"]', a: '[class*="choice"], [class*="option"], [class*="answer"]' },
    { q: '[id*="question"], [class*="question"]', a: 'input[type="radio"] + label, input[type="radio"] + span' },
    // <ol>/<ul> answer lists — common on custom quiz sites
    { q: '[class*="question"]', a: 'ol > li, ul > li' }
  ];

  function detectViaSelectors() {
    const candidates = [];
    for (const sel of QUIZ_SELECTORS) {
      const qEl = document.querySelector(sel.q);
      const aEls = document.querySelectorAll(sel.a);
      if (qEl && isVisible(qEl) && aEls.length >= 2) {
        const question = cleanQuestionText(getElementText(qEl));
        const choices = uniqueClean(Array.from(aEls).filter(isVisible).map(getChoiceText)).filter(isGoodChoice);
        if (isLikelyQuestion(question) && choices.length >= 2) {
          candidates.push({
            score: scoreDetection(question, choices, qEl) + 10,
            result: buildResult(question, choices, getContext(qEl))
          });
        }
      }
    }
    return bestCandidate(candidates);
  }

  function detectViaQuestionContainers() {
    const containers = getVisibleElements(QUESTION_CONTAINER_SELECTOR)
      .filter(el => !el.closest('#asa-overlay'))
      .slice(0, 80);

    const candidates = [];
    for (const container of containers) {
      const choices = extractChoicesFromContainer(container);
      if (choices.length < 2) continue;
      const question = findQuestionText(container, choices[0], choices);
      if (!question) continue;
      candidates.push({
        score: scoreDetection(question, choices, container),
        result: buildResult(question, choices, getContext(container))
      });
    }

    return bestCandidate(candidates);
  }

  function detectViaHeuristic() {
    const scope = getMainScope();
    const walker = document.createTreeWalker(
      scope, NodeFilter.SHOW_TEXT,
      {
        acceptNode: n => {
          const parent = n.parentElement;
          if (!parent || parent.closest(EXCLUDED_SELECTOR) || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
          // Only accept text nodes whose parent is at least partially in the viewport
          if (!isInViewport(parent)) return NodeFilter.FILTER_REJECT;
          const text = cleanText(n.textContent);
          return text && !isNoiseText(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const textNodes = [];
    let n;
    while ((n = walker.nextNode()) && textNodes.length < 300) textNodes.push(n);

    // Group text nodes by their nearest block-level ancestor so that inline-wrapped
    // text (e.g. a question split across two <span> children) gets merged into one line
    // rather than being split at every text node boundary.
    const BLOCK_TAGS = new Set(['P','DIV','LI','H1','H2','H3','H4','H5','H6','SECTION','ARTICLE','BLOCKQUOTE','TD','TH','LEGEND','LABEL','BUTTON']);
    function getBlockAncestor(node) {
      let el = node.parentElement;
      while (el && !BLOCK_TAGS.has(el.tagName) && el !== document.body) el = el.parentElement;
      return el || node.parentElement;
    }

    const blockMap = new Map();
    for (const node of textNodes) {
      const block = getBlockAncestor(node);
      if (!blockMap.has(block)) blockMap.set(block, []);
      blockMap.get(block).push(cleanText(node.textContent));
    }

    // Each block becomes one line; preserve block order via DOM position
    const lines = Array.from(blockMap.entries())
      .sort((a, b) => a[0].compareDocumentPosition(b[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
      .map(([, parts]) => parts.join(' ').trim())
      .filter(t => t && !isNoiseText(t));

    const fullText = lines.join('\n');

    let question = null;
    const choices = [];
    let nonChoiceAfterChoices = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!question && isLikelyQuestion(line)) {
        question = cleanQuestionText(line);
      } else if (question && isLikelyChoice(line)) {
        choices.push(cleanChoiceText(line));
        nonChoiceAfterChoices = 0;
      } else if (question && choices.length >= 2 && !isLikelyChoice(line)) {
        // Allow up to 2 non-choice lines after choices start (handles instructional text mixed in)
        nonChoiceAfterChoices++;
        if (nonChoiceAfterChoices >= 2) break;
      }
    }

    const cleanChoices = uniqueClean(choices).filter(isGoodChoice);
    if (question && cleanChoices.length >= 2) {
      return buildResult(question, cleanChoices, fullText.slice(0, 500));
    }
    return null;
  }

  // ── Text Analysis Helpers ──────────────────────────────────
  function isLikelyQuestion(text) {
    if (!text || text.length < 8 || text.length > 1000 || isNoiseText(text)) return false;
    const t = text.toLowerCase().trim();
    // Direct question
    if (t.endsWith('?')) return true;
    // Starts with question word
    if (/^(what|which|who|when|where|why|how|is|are|was|were|does|do|can|should|would|could)\b/i.test(t)) return true;
    // Numbered question: "1. Which..." or "1) Which..."
    if (/^\d+[\.\)]\s+\S/.test(t)) return true;
    // Fill-in-the-blank
    if (t.includes('________') || t.includes('_____')) return true;
    // Directive phrasing (very common in academic tests)
    if (/\b(select|choose|identify|determine|calculate|find|state|describe|explain|complete|match|indicate)\b.{0,60}(correct|best|most|all|true|false|following)/i.test(t)) return true;
    // EXCEPT / negative questions
    if (/\b(except|not true|not correct|not a|incorrect|false|least|wrong)\b/i.test(t) && t.length > 20) return true;
    // "All of the following... " stem
    if (/^all (of )?(the )?following/i.test(t)) return true;
    // "Which of the following..."
    if (/which of the following/i.test(t)) return true;
    return false;
  }

  function isLikelyChoice(text) {
    const t = text.trim();
    if (!t || isNoiseText(t) || t.length < 1 || t.length > 300) return false;
    // Explicitly labelled: A. B) (A) etc.
    if (/^[A-Ea-e][\.\)]\s/.test(t)) return true;
    if (/^\([A-Ea-e]\)\s/.test(t)) return true;
    // Numbered choice: 1. 2) etc.
    if (/^\d+[\.\)]\s/.test(t)) return true;
    // ✓ / ✗ prefix (some quiz apps)
    if (/^[✓✗○●□■◉◎]\s/.test(t)) return true;
    // Short, non-question text that looks like an answer option
    // Must be short enough to be a realistic choice AND not itself a question
    if (t.length >= 2 && t.length <= 120 && !t.endsWith('?') && !isLikelyQuestion(t)) return true;
    return false;
  }

  function cleanChoiceText(text) {
    return text.replace(/^[A-Ea-e][\.\)]\s*/, '')
               .replace(/^\([A-Ea-e]\)\s*/, '')
               .replace(/^\d+[\.\)]\s*/, '')
               .trim();
  }

  function buildResult(question, choices, context) {
    return {
      question: cleanQuestionText(question).slice(0, 800),
      choices: uniqueClean(choices).filter(isGoodChoice).slice(0, 8),
      context: cleanText(context).slice(0, 800)
    };
  }

  function getContext(el) {
    const parent = el?.closest?.(QUESTION_CONTAINER_SELECTOR) ||
      el?.closest?.('section, article, main, [class*="content" i]') ||
      el?.parentElement;
    return parent ? getElementText(parent).slice(0, 800) : '';
  }

  function findQuestionText(container, anchor, choices = []) {
    const choiceSet = new Set(choices.map(c => normalizeForCompare(c)));
    const textEls = container
      ? Array.from(container.querySelectorAll('legend, h1, h2, h3, h4, h5, p, [class*="question" i], [data-testid*="question" i], div, span'))
      : [];

    const lines = [];
    for (const el of textEls) {
      if (!isVisible(el) || el.closest(EXCLUDED_SELECTOR) || el.matches(CHOICE_SELECTOR)) continue;
      if (el.querySelector(CHOICE_SELECTOR)) continue;
      const text = cleanQuestionText(getElementText(el));
      if (!text || isNoiseText(text)) continue;
      if (choiceSet.has(normalizeForCompare(text))) continue;
      lines.push(text);
    }

    const direct = lines.find(isLikelyQuestion);
    if (direct) return direct;

    // Walk previous siblings
    let cur = anchor?.previousElementSibling || anchor?.parentElement?.previousElementSibling;
    for (let i = 0; i < 8 && cur; i++) {
      const text = cleanQuestionText(getElementText(cur));
      if (isLikelyQuestion(text)) return text;
      cur = cur.previousElementSibling;
    }

    // Walk up the ancestor chain — question text is sometimes a parent heading
    let parent = anchor?.parentElement;
    for (let depth = 0; depth < 5 && parent && parent !== document.body; depth++) {
      // Look for a sibling or child heading before the anchor's subtree
      const heading = parent.querySelector('h1, h2, h3, h4, h5, legend, [class*="question" i]');
      if (heading && isVisible(heading)) {
        const text = cleanQuestionText(getElementText(heading));
        if (isLikelyQuestion(text) && !choiceSet.has(normalizeForCompare(text))) return text;
      }
      parent = parent.parentElement;
    }

    return lines.find(t => t.length > 20 && t.length < 600) || null;
  }

  function extractChoicesFromContainer(container) {
    const controls = Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]'))
      .filter(isUsableChoiceControl);
    if (controls.length >= 2) return uniqueClean(controls.map(getChoiceText)).filter(isGoodChoice);

    const choiceEls = Array.from(container.querySelectorAll(CHOICE_SELECTOR))
      .filter(el => isVisible(el) && !el.closest(EXCLUDED_SELECTOR));
    if (choiceEls.length >= 2) return uniqueClean(choiceEls.map(getChoiceText)).filter(isGoodChoice);

    // Fallback: try <ol>/<ul> list items (common on custom quiz sites and edX)
    const listItems = Array.from(container.querySelectorAll('ol > li, ul > li'))
      .filter(el => isVisible(el) && !el.closest(EXCLUDED_SELECTOR));
    if (listItems.length >= 2 && listItems.length <= 8) {
      return uniqueClean(listItems.map(getChoiceText)).filter(isGoodChoice);
    }

    return [];
  }

  function getChoiceText(el) {
    if (!el) return '';
    const aria = el.getAttribute?.('aria-label');
    if (aria) return cleanChoiceText(aria);

    if (el.matches?.('input[type="radio"], input[type="checkbox"]')) {
      const id = el.id ? document.querySelector(`label[for="${cssEscape(el.id)}"]`) : null;
      const wrapped = el.closest('label');
      const sibling = el.nextElementSibling;
      return cleanChoiceText(getElementText(id || wrapped || sibling || el.parentElement));
    }

    // For <li> elements, strip leading bullet characters
    if (el.tagName === 'LI') {
      return cleanChoiceText(getElementText(el).replace(/^[•\-–—*]\s*/, ''));
    }

    return cleanChoiceText(getElementText(el));
  }

  function isUsableChoiceControl(el) {
    if (!el || el.closest?.(EXCLUDED_SELECTOR)) return false;
    if (isVisible(el)) return true;
    if (el.matches?.('input[type="radio"], input[type="checkbox"]')) {
      const label = el.id ? document.querySelector(`label[for="${cssEscape(el.id)}"]`) : null;
      return isVisible(label) || isVisible(el.closest('label')) || isVisible(el.parentElement);
    }
    return false;
  }

  function getChoiceGroupKey(control) {
    // First try: closest question-level container (most reliable for multi-Q pages)
    const qContainer = control.closest('[class*="question" i], [id*="question" i], fieldset, [role="radiogroup"], [role="group"]');
    if (qContainer) return qContainer;
    // Second try: name attribute (but only if it looks question-specific, not a shared form name)
    if (control.name && control.name !== 'answer' && control.name !== 'option' && control.name !== 'choice') {
      return `name:${control.name}`;
    }
    // Fallback: parent element
    return control.parentElement || control;
  }

  function findQuestionContainer(el) {
    return el.closest(QUESTION_CONTAINER_SELECTOR) ||
      el.closest('section, article, main') ||
      el.parentElement?.parentElement ||
      el.parentElement;
  }

  function getMainScope() {
    return document.querySelector('main, [role="main"], form, article') || document.body;
  }

  function getVisibleElements(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisible)
      .sort((a, b) => viewportCentralityScore(b) - viewportCentralityScore(a));
  }

  function bestCandidate(candidates) {
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].score >= 20 ? candidates[0].result : null;
  }

  function scoreDetection(question, choices, container) {
    let score = 0;
    // Question quality
    if (question.endsWith('?')) score += 20;
    if (/^(what|which|who|when|where|why|how|select|choose|identify|all of the following|which of the following)\b/i.test(question)) score += 15;
    if (/\b(except|not true|not correct|incorrect|false)\b/i.test(question)) score += 10;
    if (/^\d+[\.\)]\s/.test(question)) score += 8;
    // Choice quality
    if (choices.length >= 2) score += 20;
    if (choices.length >= 4) score += 10;
    if (choices.every(c => c.length < 150)) score += 5;
    // Semantic HTML bonuses
    if (container?.tagName === 'FIELDSET') score += 15;
    if (container?.querySelector?.('legend')) score += 10;
    if (container?.matches?.(QUESTION_CONTAINER_SELECTOR)) score += 10;
    if (container?.querySelector?.('ol, ul')) score += 5;
    // Viewport centrality — highest score goes to question most centered on screen
    score += viewportCentralityScore(container);
    // Penalise noise choices
    score -= choices.filter(isNoiseText).length * 10;
    return score;
  }

  function isGoodChoice(text) {
    const t = cleanChoiceText(text);
    return t.length >= 1 && t.length <= 300 && !isLikelyQuestion(t) && !isNoiseText(t);
  }

  function cleanQuestionText(text) {
    return cleanText(text)
      .replace(/^(question|problem)\s*\d*[\s:.-]*/i, '')
      .trim();
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .trim();
  }

  function uniqueClean(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const text = cleanText(item);
      const key = normalizeForCompare(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  }

  function normalizeForCompare(text) {
    return cleanText(text).toLowerCase().replace(/^[a-e][\.\)]\s*/i, '');
  }

  function getElementText(el) {
    if (!el) return '';
    return cleanText(el.innerText || el.textContent || '');
  }

  function isNoiseText(text) {
    const t = cleanText(text);
    if (!t || t.length > 1200) return true;
    if (/^(home|menu|next|previous|submit|save|cancel|download|upload|share|login|sign in)$/i.test(t)) return true;
    if (/^[\w,\s-]+\.(png|jpe?g|gif|webp|svg|pdf|docx?|pptx?|xlsx?|mp4|webm|zip)$/i.test(t)) return true;
    if (/(^|[\\\/])[\w.-]+\.(png|jpe?g|gif|webp|svg|pdf|docx?|pptx?|xlsx?|mp4|webm|zip)(\?|$)/i.test(t)) return true;
    if (/^https?:\/\//i.test(t) || /^data:image\//i.test(t)) return true;
    if ((t.match(/[\\\/]/g) || []).length >= 2) return true;
    if (/^\d+\s*(kb|mb|gb|px|x\s*\d+)/i.test(t)) return true;
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.closest?.(EXCLUDED_SELECTOR)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInViewport(el) {
    if (!el?.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  // Returns 0-50 based on how centered the element is in the viewport
  // Elements fully above/below get 0; the most centered gets 50
  function viewportCentralityScore(el) {
    if (!el?.getBoundingClientRect) return 0;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    // Not in viewport at all
    if (rect.bottom < 0 || rect.top > vh) return 0;
    // How much of the element overlaps the viewport
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, vh);
    const visibleHeight = visibleBottom - visibleTop;
    if (visibleHeight <= 0) return 0;
    // Center of visible portion relative to viewport center
    const elCenter = (visibleTop + visibleBottom) / 2;
    const vpCenter = vh / 2;
    const distFromCenter = Math.abs(elCenter - vpCenter);
    // Score: 50 at center, 0 at edge
    return Math.max(0, 50 - Math.round((distFromCenter / (vh / 2)) * 50));
  }

  function cssEscape(value) {
    return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return h.toString(36);
  }

  function getQuestionSetHash(questions) {
    return hashString(questions.map(q => [
      q.question,
      ...(q.choices || [])
    ].join('\u001f')).join('\u001e'));
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ── Overlay ────────────────────────────────────────────────
  function createOverlay() {
    if (document.getElementById('asa-overlay')) return;

    overlay = document.createElement('div');
    overlay.id = 'asa-overlay';
    overlay.innerHTML = `
      <div class="asa-header">
        <div class="asa-logo">
          <span class="asa-logo-icon">⚡</span>
          <span class="asa-logo-text">AI Study Assistant</span>
        </div>
        <div class="asa-controls">
          <button class="asa-btn asa-btn-icon" id="asa-toggle" title="Toggle (Alt+S)">⏸</button>
          <button class="asa-btn asa-btn-icon" id="asa-minimize" title="Minimize">−</button>
          <button class="asa-btn asa-btn-icon" id="asa-close" title="Close">×</button>
        </div>
      </div>
      <div class="asa-search-bar" id="asa-search-bar">
        <input type="text" id="asa-search-input" placeholder="Ask AI a question..." />
        <button class="asa-btn asa-btn-primary" id="asa-search-btn">Ask</button>
      </div>
      <div class="asa-body" id="asa-body">
        <div class="asa-idle" id="asa-idle">
          <div class="asa-idle-icon">🔍</div>
          <div class="asa-idle-text">Scanning for questions…</div>
        </div>
        <div class="asa-loading" id="asa-loading" style="display:none">
          <div class="asa-spinner"></div>
          <span>Analyzing question…</span>
        </div>
        <div class="asa-result" id="asa-result" style="display:none">
          <div class="asa-question-preview" id="asa-q-preview"></div>
          <div class="asa-answer-box">
            <div class="asa-answer-label">Suggested Answer</div>
            <div class="asa-answer-text" id="asa-answer"></div>
          </div>
          <div class="asa-meta">
            <div class="asa-confidence" id="asa-confidence"></div>
            <div class="asa-subject" id="asa-subject"></div>
            <div class="asa-time" id="asa-time"></div>
          </div>
          <div class="asa-explanation" id="asa-explanation"></div>
          <div class="asa-actions">
            <button class="asa-btn asa-btn-copy" id="asa-copy">📋 Copy Answer</button>
            <button class="asa-btn asa-btn-details" id="asa-details-btn">📖 Reasoning</button>
          </div>
          <div class="asa-autoselect-bar">
            <label class="asa-autoselect-label">
              <span>Auto-select answer</span>
              <button class="asa-toggle-sm on" id="asa-autoselect-toggle">ON</button>
            </label>
            <button class="asa-btn asa-btn-sm" id="asa-select-now" style="display:none">👆 Select Now</button>
          </div>
          <div class="asa-reasoning" id="asa-reasoning" style="display:none"></div>
        </div>
        <div class="asa-bulk" id="asa-bulk" style="display:none">
          <div class="asa-bulk-header">
            <span>📋 All Answers</span>
            <button class="asa-btn asa-btn-sm" id="asa-bulk-copy">Copy All</button>
          </div>
          <div class="asa-bulk-list" id="asa-bulk-list"></div>
        </div>
        <div class="asa-jump" id="asa-jump" style="display:none">
          <div class="asa-jump-label">Go to question #</div>
          <div class="asa-jump-row">
            <input class="asa-jump-input" id="asa-jump-input" type="number" min="1" placeholder="e.g. 5" />
            <button class="asa-btn asa-btn-copy" id="asa-jump-go">Go</button>
          </div>
          <div class="asa-jump-info" id="asa-jump-info"></div>
        </div>
        <div class="asa-error" id="asa-error" style="display:none">
          <span class="asa-error-icon">⚠️</span>
          <span id="asa-error-text"></span>
        </div>
      </div>
      <div class="asa-footer">
        <div class="asa-status" id="asa-status">
          <span class="asa-dot active"></span> Active
        </div>
        <div class="asa-rescan" style="display:flex;gap:4px">
          <button class="asa-btn asa-btn-sm asa-btn-stop" id="asa-force-stop">Stop AI</button>
          <button class="asa-btn asa-btn-sm" id="asa-bulk-btn"># Jump</button>
          <button class="asa-btn asa-btn-sm" id="asa-rescan">↻ Rescan</button>
        </div>
      </div>
    `;

    applyPosition(overlay, settings.overlayPosition || 'top-right');
    document.body.appendChild(overlay);
    addResizeHandles();

    // Events
    document.getElementById('asa-toggle').addEventListener('click', toggleEnabled);
    document.getElementById('asa-minimize').addEventListener('click', toggleMinimize);
    document.getElementById('asa-close').addEventListener('click', () => {
      overlay.style.display = 'none';
    });
    document.getElementById('asa-copy').addEventListener('click', copyAnswer);
    document.getElementById('asa-details-btn').addEventListener('click', toggleReasoning);
    document.getElementById('asa-search-btn').addEventListener('click', submitCustomQuestion);
    document.getElementById('asa-search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') submitCustomQuestion();
    });
    document.getElementById('asa-autoselect-toggle').addEventListener('click', toggleAutoSelect);
    document.getElementById('asa-select-now').addEventListener('click', () => autoSelectAnswer(lastDetected));
    document.getElementById('asa-force-stop').addEventListener('click', toggleForceStop);
    document.getElementById('asa-bulk-btn').addEventListener('click', toggleJumpPanel);
    document.getElementById('asa-bulk-copy').addEventListener('click', copyBulkAnswers);
    document.getElementById('asa-jump-go').addEventListener('click', jumpToQuestion);
    document.getElementById('asa-jump-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') jumpToQuestion();
    });
    document.getElementById('asa-rescan').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastQuestionHash = '';
      scan({ force: true, manual: true });
    });

    // Drag
    overlay.querySelector('.asa-header').addEventListener('mousedown', startDrag);
    overlay.querySelector('.asa-header').addEventListener('touchstart', startDrag, { passive: false });
  }

  function addResizeHandles() {
    ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].forEach(dir => {
      const handle = document.createElement('div');
      handle.className = `asa-resize-handle asa-resize-${dir}`;
      handle.dataset.resize = dir;
      handle.addEventListener('mousedown', startResize);
      handle.addEventListener('touchstart', startResize, { passive: false });
      overlay.appendChild(handle);
    });
  }

  function applyPosition(el, pos) {
    el.style.removeProperty('top');
    el.style.removeProperty('bottom');
    el.style.removeProperty('left');
    el.style.removeProperty('right');
    const map = {
      'top-right':    { top: '20px', right: '20px' },
      'top-left':     { top: '20px', left: '20px' },
      'bottom-right': { bottom: '20px', right: '20px' },
      'bottom-left':  { bottom: '20px', left: '20px' },
      'top-center':   { top: '20px', left: '50%', transform: 'translateX(-50%)' }
    };
    const coords = map[pos] || map['top-right'];
    Object.assign(el.style, coords);
  }

  function applyOverlaySettings() {
    if (!overlay) return;
    applyPosition(overlay, settings.overlayPosition);
    overlay.dataset.size = settings.overlaySize || 'medium';
  }

  // ── Overlay States ─────────────────────────────────────────
  function showOverlayLoading() {
    setSection('asa-loading');
    overlay.style.display = '';
  }

  function showOverlayResult(result, detected) {
    if (result.error) { showOverlayError(result.error); return; }

    document.getElementById('asa-q-preview').textContent =
      detected.question.length > 120
        ? detected.question.slice(0, 117) + '…'
        : detected.question;

    document.getElementById('asa-answer').textContent = result.answer || '—';
    document.getElementById('asa-explanation').textContent = result.explanation || '';
    document.getElementById('asa-reasoning').textContent = result.reasoning || '';

    const pct = result.confidence ? Math.round(result.confidence * 100) : 0;
    const confEl = document.getElementById('asa-confidence');
    confEl.textContent = `${pct}% confidence`;
    confEl.className = 'asa-confidence ' + (pct >= 80 ? 'high' : pct >= 50 ? 'medium' : 'low');

    document.getElementById('asa-subject').textContent = result.subject ? `📚 ${result.subject}` : '';
    document.getElementById('asa-time').textContent = result.responseTime ? `⚡ ${result.responseTime}ms` : '';

    setSection('asa-result');
    overlay.style.display = '';

    // Store for manual select-now button
    lastDetected = { result, detected };

    // Auto-select if enabled
    if (autoSelectEnabled && !detected.manual) autoSelectAnswer({ result, detected });
  }

  function showOverlayError(msg) {
    document.getElementById('asa-error-text').textContent = msg;
    setSection('asa-error');
  }

  function setSection(id) {
    ['asa-idle','asa-loading','asa-result','asa-bulk','asa-jump','asa-error'].forEach(s => {
      const el = document.getElementById(s);
      if (el) el.style.display = s === id ? '' : 'none';
    });
  }

  // ── UI Actions ─────────────────────────────────────────────
  async function submitCustomQuestion() {
    const input = document.getElementById('asa-search-input');
    const text = input.value.trim();
    if (!text) return;

    analysisGeneration++;
    const generation = analysisGeneration;
    isEnabled = false;
    pendingRequest = true;
    mutationMissedDuringPending = false;
    stopScanLoop();
    clearTimeout(mutationDebounceTimer);
    clearTimeout(navigationScanTimer);
    await sendMessage({ type: 'CANCEL_ANALYSIS' }).catch(() => {});
    updateManualModeUI();
    showOverlayLoading();

    try {
      const result = await sendMessage({
        type: 'ANALYZE_QUESTION',
        payload: {
          question: text,
          choices: [],
          context: 'Manual user query',
          url: location.href
        }
      });
      if (generation !== analysisGeneration) return;
      showOverlayResult(result, { question: text, choices: [], context: '', manual: true });
      input.value = '';
    } catch (e) {
      if (generation === analysisGeneration) showOverlayError(e.message);
    } finally {
      if (generation === analysisGeneration) pendingRequest = false;
    }
  }

  function toggleEnabled() {
    isEnabled = !isEnabled;
    const btn = document.getElementById('asa-toggle');
    const dot = overlay.querySelector('.asa-dot');
    const statusEl = document.getElementById('asa-status');

    if (isEnabled) {
      btn.textContent = '⏸';
      dot.className = 'asa-dot active';
      statusEl.innerHTML = '<span class="asa-dot active"></span> Active';
      document.getElementById('asa-force-stop').textContent = 'Stop AI';
      startScanLoop();
    } else {
      btn.textContent = '▶';
      dot.className = 'asa-dot paused';
      statusEl.innerHTML = '<span class="asa-dot paused"></span> Paused';
      document.getElementById('asa-force-stop').textContent = 'Resume AI';
      stopScanLoop();
    }

    sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: isEnabled } });
  }

  function toggleForceStop() {
    if (isEnabled || pendingRequest) {
      forceStopAI();
    } else {
      resumeAI();
    }
  }

  function forceStopAI() {
    isEnabled = false;
    analysisGeneration++;
    pendingRequest = false;
    mutationMissedDuringPending = false;
    stopScanLoop();
    if (autoSelectTimer) {
      clearInterval(autoSelectTimer);
      autoSelectTimer = null;
    }
    sendMessage({ type: 'CANCEL_ANALYSIS' }).catch(() => {});
    sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: false } }).catch(() => {});
    updateStoppedUI();
  }

  function resumeAI() {
    isEnabled = true;
    updateActiveUI();
    sendMessage({ type: 'UPDATE_SETTINGS', settings: { enabled: true } });
    startScanLoop();
  }

  function updateManualModeUI() {
    const btn = document.getElementById('asa-toggle');
    const stopBtn = document.getElementById('asa-force-stop');
    const dot = overlay.querySelector('.asa-dot');
    const statusEl = document.getElementById('asa-status');
    if (btn) btn.textContent = '▶';
    if (stopBtn) stopBtn.textContent = 'Resume AI';
    if (dot) dot.className = 'asa-dot paused';
    if (statusEl) statusEl.innerHTML = '<span class="asa-dot paused"></span> Manual Ask';
  }

  function updateStoppedUI() {
    const btn = document.getElementById('asa-toggle');
    const stopBtn = document.getElementById('asa-force-stop');
    const dot = overlay.querySelector('.asa-dot');
    const statusEl = document.getElementById('asa-status');
    if (btn) btn.textContent = '▶';
    if (stopBtn) stopBtn.textContent = 'Resume AI';
    if (dot) dot.className = 'asa-dot paused';
    if (statusEl) statusEl.innerHTML = '<span class="asa-dot paused"></span> Stopped';
    showOverlayError('AI stopped. Scanning and analysis are paused.');
  }

  function updateActiveUI() {
    const btn = document.getElementById('asa-toggle');
    const stopBtn = document.getElementById('asa-force-stop');
    const dot = overlay.querySelector('.asa-dot');
    const statusEl = document.getElementById('asa-status');
    if (btn) btn.textContent = '⏸';
    if (stopBtn) stopBtn.textContent = 'Stop AI';
    if (dot) dot.className = 'asa-dot active';
    if (statusEl) statusEl.innerHTML = '<span class="asa-dot active"></span> Active';
  }

  function toggleMinimize() {
    const body = document.getElementById('asa-body');
    const footer = overlay.querySelector('.asa-footer');
    const btn = document.getElementById('asa-minimize');
    const minimized = body.style.display === 'none';
    body.style.display = minimized ? '' : 'none';
    if (footer) footer.style.display = minimized ? '' : 'none';
    btn.textContent = minimized ? '−' : '+';
  }

  function toggleReasoning() {
    const r = document.getElementById('asa-reasoning');
    const btn = document.getElementById('asa-details-btn');
    const open = r.style.display === 'none';
    r.style.display = open ? '' : 'none';
    btn.textContent = open ? '📖 Hide Reasoning' : '📖 Reasoning';
  }

  function copyAnswer() {
    const answer = document.getElementById('asa-answer')?.textContent;
    if (answer) {
      navigator.clipboard.writeText(answer).then(() => {
        const btn = document.getElementById('asa-copy');
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy Answer'; }, 2000);
      });
    }
  }

  // ── Drag & Drop (mouse + touch) ─────────────────────────────
  // Shared helper so the same code path works for both mouse and touch events
  function getPoint(e) {
    return e.touches ? e.touches[0] : e;
  }

  function startDrag(e) {
    if (e.target.classList.contains('asa-btn')) return;
    if (isResizing) return;
    isDragging = true;
    const rect = overlay.getBoundingClientRect();
    const pt = getPoint(e);
    dragOffset.x = pt.clientX - rect.left;
    dragOffset.y = pt.clientY - rect.top;
    overlay.style.transition = 'none';
    e.preventDefault();
  }

  function startResize(e) {
    if (!overlay) return;
    const rect = overlay.getBoundingClientRect();
    const pt = getPoint(e);
    isResizing = true;
    isDragging = false;
    resizeState = {
      dir: e.currentTarget.dataset.resize,
      startX: pt.clientX,
      startY: pt.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    };
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'none';
    overlay.style.transition = 'none';
    document.body.classList.add('asa-resizing');
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    if (isResizing && overlay && resizeState) {
      resizeOverlay(e);
      return;
    }
    if (!isDragging || !overlay) return;
    const pt = getPoint(e);
    let x = pt.clientX - dragOffset.x;
    let y = pt.clientY - dragOffset.y;
    // Clamp to viewport so overlay can't be dragged off-screen
    x = Math.max(0, Math.min(x, window.innerWidth - overlay.offsetWidth));
    y = Math.max(0, Math.min(y, window.innerHeight - overlay.offsetHeight));
    overlay.style.left = x + 'px';
    overlay.style.top = y + 'px';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.transform = 'none';
    if (e.touches) e.preventDefault(); // stop page scroll while dragging on touch
  }

  function onPointerEnd() {
    isDragging = false;
    isResizing = false;
    resizeState = null;
    document.body.classList.remove('asa-resizing');
    if (overlay) overlay.style.transition = '';
  }

  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('touchmove', onPointerMove, { passive: false });
  document.addEventListener('mouseup', onPointerEnd);
  document.addEventListener('touchend', onPointerEnd);

  function resizeOverlay(e) {
    const dir = resizeState.dir;
    const minWidth = 280;
    const minHeight = 160;
    const maxWidth = Math.max(minWidth, window.innerWidth - 40);
    const maxHeight = Math.max(minHeight, window.innerHeight - 40);
    const pt = getPoint(e);
    const dx = pt.clientX - resizeState.startX;
    const dy = pt.clientY - resizeState.startY;

    let left = resizeState.left;
    let top = resizeState.top;
    let width = resizeState.width;
    let height = resizeState.height;

    if (dir.includes('e')) width = resizeState.width + dx;
    if (dir.includes('s')) height = resizeState.height + dy;
    if (dir.includes('w')) {
      width = resizeState.width - dx;
      left = resizeState.left + dx;
    }
    if (dir.includes('n')) {
      height = resizeState.height - dy;
      top = resizeState.top + dy;
    }

    if (width < minWidth) {
      if (dir.includes('w')) left -= minWidth - width;
      width = minWidth;
    }
    if (height < minHeight) {
      if (dir.includes('n')) top -= minHeight - height;
      height = minHeight;
    }
    if (width > maxWidth) {
      if (dir.includes('w')) left -= maxWidth - width;
      width = maxWidth;
    }
    if (height > maxHeight) {
      if (dir.includes('n')) top -= maxHeight - height;
      height = maxHeight;
    }

    left = Math.max(0, Math.min(left, window.innerWidth - width));
    top = Math.max(0, Math.min(top, window.innerHeight - height));

    overlay.style.left = left + 'px';
    overlay.style.top = top + 'px';
    overlay.style.width = width + 'px';
    overlay.style.height = height + 'px';
  }

  // ── Hotkey ─────────────────────────────────────────────────
  function registerHotkey() {
    document.addEventListener('keydown', e => {
      // Alt+R — rescan
      if (e.altKey && e.key.toUpperCase() === 'R') {
        e.preventDefault();
        lastQuestionHash = '';
        scan({ force: true, manual: true });
        return;
      }
      // Configurable hotkey (default Alt+S) — toggle
      const hotkey = settings.hotkey || 'Alt+S';
      const [mod, key] = hotkey.split('+');
      if (
        ((mod === 'Alt' && e.altKey) ||
         (mod === 'Ctrl' && e.ctrlKey) ||
         (mod === 'Shift' && e.shiftKey)) &&
        e.key.toUpperCase() === key.toUpperCase()
      ) {
        e.preventDefault();
        if (overlay.style.display === 'none') {
          overlay.style.display = '';
        } else {
          toggleEnabled();
        }
      }
    });
  }

  // ── Messaging ─────────────────────────────────────────────
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Request timed out — retrying…')), 15000);
      try {
        chrome.runtime.sendMessage(msg, resp => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(resp);
        });
      } catch (e) { clearTimeout(timeout); reject(e); }
    });
  }

})();
