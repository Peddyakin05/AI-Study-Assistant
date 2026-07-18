// ============================================================
// AI Study Assistant — Background Service Worker
// Multi-provider: Anthropic, OpenAI, Gemini, Groq
// ============================================================

const DEFAULT_SETTINGS = {
  enabled: true,
  scanInterval: 3000,
  overlayPosition: 'top-right',
  overlaySize: 'medium',
  activeProvider: 'gemini',
  providers: {
    anthropic: { apiKey: '', model: 'claude-sonnet-4-20250514' },
    openai:    { apiKey: '', model: 'gpt-4o-mini' },
    gemini:    { apiKey: '', model: 'gemini-2.5-flash-lite' },
    groq:      { apiKey: '', model: 'llama-3.3-70b-versatile' }
  },
  multiTab: false,
  hotkey: 'Alt+S',
  showConfidence: true,
  autoSelectEnabled: false,
  autoHideDelay: 0,
  logHistory: true,
  theme: 'dark'
};

let settings = { ...DEFAULT_SETTINGS };
let sessionLog = [];
let activeTabs = new Set();
let activeAnalysisControllers = new Map();

// ── Init ──────────────────────────────────────────────────────
let settingsReady = false;

async function loadSettings() {
  const data = await chrome.storage.local.get(['settings', 'sessionLog']);
  if (data.settings) settings = deepMerge(DEFAULT_SETTINGS, data.settings);
  if (data.sessionLog) sessionLog = data.sessionLog;
  settingsReady = true;
}

const settingsReadyPromise = loadSettings();

chrome.runtime.onInstalled.addListener(async () => {
  await settingsReadyPromise;
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, sessionLog: [] });
  }
});

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (key === 'providers' && overrides.providers) {
      result.providers = { ...defaults.providers };
      for (const p of Object.keys(overrides.providers)) {
        result.providers[p] = { ...(defaults.providers[p] || {}), ...overrides.providers[p] };
      }
    } else {
      result[key] = overrides[key];
    }
  }
  normalizeProviderModels(result);
  return result;
}

function normalizeProviderModels(settingsObj) {
  const replacements = {
    gemini: {
      'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite'
    },
    groq: {
      'llama3-70b-8192': 'llama-3.3-70b-versatile',
      'llama3-8b-8192': 'llama-3.1-8b-instant',
      'mixtral-8x7b-32768': 'llama-3.3-70b-versatile'
    },
    openai: {
      'gpt-3.5-turbo': 'gpt-4o-mini'
    }
  };

  for (const [provider, models] of Object.entries(replacements)) {
    const cfg = settingsObj.providers?.[provider];
    if (cfg?.model && models[cfg.model]) {
      cfg.model = models[cfg.model];
    }
  }
}

// ── Message Router ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await settingsReadyPromise; // ensure settings loaded before any operation
    switch (msg.type) {
    case 'GET_SETTINGS':
      sendResponse({ settings });
      break;

    case 'UPDATE_SETTINGS':
      settings = deepMerge(settings, msg.settings);
      chrome.storage.local.set({ settings });
      broadcastToTabs({ type: 'SETTINGS_UPDATED', settings });
      sendResponse({ ok: true });
      break;

    case 'ANALYZE_QUESTION':
      analyzeQuestion(msg.payload, sender.tab?.id)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      break;

    case 'CANCEL_ANALYSIS': {
      const tabId = sender.tab?.id;
      const controller = activeAnalysisControllers.get(tabId);
      if (controller) {
        controller.abort();
        activeAnalysisControllers.delete(tabId);
      }
      sendResponse({ ok: true });
      break;
    }

    case 'LOG_ENTRY':
      addLogEntry(msg.entry);
      sendResponse({ ok: true });
      break;

    case 'GET_LOG':
      sendResponse({ log: sessionLog });
      break;

    case 'CLEAR_LOG':
      sessionLog = [];
      chrome.storage.local.set({ sessionLog: [] });
      sendResponse({ ok: true });
      break;

    case 'TAB_ACTIVE':
      activeTabs.add(sender.tab?.id);
      sendResponse({ ok: true });
      break;

    case 'TAB_INACTIVE':
      activeTabs.delete(sender.tab?.id);
      sendResponse({ ok: true });
      break;

    case 'GET_STATS':
      sendResponse({
        totalQuestions: sessionLog.length,
        activeTabs: activeTabs.size,
        avgResponseTime: calcAvgResponseTime(),
        avgConfidence: calcAvgConfidence()
      });
      break;
    }
  })();
  return true; // always keep channel open for async sendResponse
});

// ── AI Analysis ───────────────────────────────────────────────
async function analyzeQuestion(payload, tabId) {
  const start = Date.now();
  const { question, choices, context, url } = payload;

  if (!question || question.trim().length < 5) {
    return { error: 'No valid question detected' };
  }

  const controller = new AbortController();
  if (tabId != null) {
    activeAnalysisControllers.get(tabId)?.abort();
    activeAnalysisControllers.set(tabId, controller);
  }

  const choiceText = choices && choices.length
    ? '\n\nAnswer choices:\n' + choices.map((c, i) => `${String.fromCharCode(65+i)}) ${c}`).join('\n')
    : '';
  const contextText = context ? '\nContext: ' + context.slice(0, 500) : '';

  const knownAnswer = extractKnownCorrectAnswer(context);
  if (knownAnswer) {
    const responseTime = Date.now() - start;
    const result = {
      answer: knownAnswer,
      confidence: 1,
      explanation: 'The page already shows this as the correct answer.',
      reasoning: 'Detected from visible result review text.',
      subject: 'Review'
    };
    if (settings.logHistory) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        question: question.slice(0, 200),
        choices,
        answer: result.answer,
        confidence: result.confidence,
        explanation: result.explanation,
        subject: result.subject,
        provider: 'page',
        responseTime,
        url: url || ''
      });
    }
    return { ...result, responseTime, provider: 'page' };
  }

  const isBulk = context && context.includes('Give ONLY the answer letter');
  const systemPrompt = isBulk
    ? `You are an expert tutor. Answer the question directly.
Respond ONLY with valid JSON, no markdown:
{"answer":"A) answer text","confidence":0.95,"explanation":"","reasoning":"","subject":""}`
    : `You are an expert logical thinker trained to solve tricky trivia, local cultural context, and counting/logical traps. 
You must analyze the details critically and think step-by-step in the 'reasoning' field BEFORE choosing the final answer.

Here are examples of how you must process specific patterns:

Example 1 (Positional/Counting Trap):
Question: "A queue has 12 people. You are 4th from the back. How many people are behind you?"
Reasoning: "If you are 1st from the back, 0 people are behind you. If you are 2nd from the back, 1 person is behind you. Therefore, being 4th from the back means there are exactly 3 people behind you. The total number of 12 people is a distraction."
Output: {"answer": "3", "confidence": 1.0, "explanation": "Being 4th from the back means there are 3 people behind you.", "reasoning": "If you are 1st from the back, 0 people are behind you...", "subject": "Math Logic"}

Example 2 (Cultural Slang & Nuance):
Question: "Someone comments 'this gist don cast.' What do they usually mean?"
Reasoning: "In Nigerian pidgin, 'gist' refers to a story, rumor, or gossip, and 'don cast' means something has been exposed, leaked, or made widely known. Therefore, it means the secret or story is now public knowledge."
Output: {"answer": "The story is now public", "confidence": 1.0, "explanation": "'Don cast' translates to being leaked or widely exposed to the public.", "reasoning": "In Nigerian pidgin, 'gist' refers to a story...", "subject": "Cultural Slang"}

Example 3 (Time & Sequence Constraint):
Question: "A sign says 'No parking 8AM to 6PM.' You arrive at 8:01PM. Can you park?"
Reasoning: "The restriction is explicitly bounded between 8:00 AM and 6:00 PM. 8:01 PM occurs after the 6:00 PM cutoff, meaning the restriction is no longer active and parking is fully permitted."
Output: {"answer": "Yes", "confidence": 1.0, "explanation": "8:01 PM is outside of the restricted 8 AM to 6 PM window.", "reasoning": "The restriction is explicitly bounded between 8:00 AM and 6:00 PM...", "subject": "Time Logic"}

Example 4 (Practical Life/Business Logic):
Question: "If a POS debit fails but your account is charged, what should you ask for first?"
Reasoning: "To dispute a failed terminal transaction where funds were deducted, you immediately need physical or digital evidence of the failure from the merchant to show your bank. Thus, the receipt or transaction reference is the critical first requirement."
Output: {"answer": "The receipt or transaction reference", "confidence": 0.99, "explanation": "The receipt or reference code is required to dispute a failed transaction with your bank.", "reasoning": "To dispute a failed terminal transaction...", "subject": "Practical Logic"}

Example 5 (Character Counting & Brand Spelling Traps):
Question: "Which of these is not true about the spelling of brand 'MONIEPOINT'?"
Reasoning: "Let's break down and count the letters in the brand name 'MONIEPOINT' sequentially: M(1)-O(2)-N(3)-I(4)-E(5)-P(6)-O(7)-I(8)-N(9)-T(10). The word contains exactly 10 letters. Therefore, any option stating that the word contains 10 letters is a true statement. The option stating 'The word contains 9 letters' is factually incorrect. Since the question asks for the statement that is NOT true, 'The word contains 9 letters' is the correct answer."
Output: {"answer": "The word contains 9 letters", "confidence": 1.0, "explanation": "MONIEPOINT has exactly 10 letters, making the statement that it has 9 letters false.", "reasoning": "Let's break down and count the letters in the brand name 'MONIEPOINT' sequentially...", "subject": "String Analysis"}

Example 6 (Real-World Safety & Phishing Traps):
Question: "If someone sends you a link claiming 'free ₦500,000 from CBN,' what is the safest thing to do?"
Reasoning: "Central banks do not send direct disbursement links to individuals via text or messaging apps. This is a classic social engineering phishing scam designed to steal credentials or banking details. The only safe action is to avoid the link completely and never input any personal identification numbers or data."
Output: {"answer": "Avoid it and do not enter bank details", "confidence": 1.0, "explanation": "This is a fraudulent phishing scam; interacting risks financial or identity theft.", "reasoning": "Central banks do not send direct disbursement links to individuals...", "subject": "Common Sense Safety"}

Respond ONLY with valid JSON matching this exact structure, with no markdown formatting around it:
{"answer":"A) answer text","confidence":0.95,"explanation":"short summary","reasoning":"Step-by-step logical analysis","subject":"Topic"}`;

  const promptForProvider = isBulk ? systemPrompt : `You answer quiz questions quickly and accurately.
Return ONLY valid JSON:
{"answer":"A) answer text","confidence":0.95,"explanation":"one short sentence","reasoning":"brief reasoning","subject":"topic"}
Choose the best answer from the choices when choices are provided.`;

  const userPrompt = `Question: ${question}${choiceText}${contextText}`;

  const provider = settings.activeProvider || 'gemini';
  const providerCfg = settings.providers?.[provider] || {};
  const apiKey = providerCfg.apiKey || '';

  try {
    let result;

    if (!apiKey) {
      // No key — use heuristic fallback
      result = patternBasedAnalysis(question, choices);
    } else if (provider === 'anthropic') {
      result = await callAnthropic(apiKey, providerCfg.model, promptForProvider, userPrompt, controller.signal);
    } else if (provider === 'openai') {
      result = await callOpenAI(apiKey, providerCfg.model, promptForProvider, userPrompt, controller.signal);
    } else if (provider === 'gemini') {
      result = await callGemini(apiKey, providerCfg.model, promptForProvider, userPrompt, controller.signal);
    } else if (provider === 'groq') {
      result = await callGroq(apiKey, providerCfg.model, promptForProvider, userPrompt, controller.signal);
    } else {
      result = patternBasedAnalysis(question, choices);
    }

    result = normalizeAIResult(result);

    const responseTime = Date.now() - start;

    if (settings.logHistory) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        question: question.slice(0, 200),
        choices,
        answer: result.answer,
        confidence: result.confidence,
        explanation: result.explanation,
        subject: result.subject,
        provider,
        responseTime,
        url: url || ''
      });
    }

    return { ...result, responseTime, provider };

  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        error: 'Analysis cancelled',
        responseTime: Date.now() - start
      };
    }
    console.error('Analysis error:', err);
    return {
      answer: 'Error',
      confidence: 0,
      explanation: err.message || 'Analysis failed',
      reasoning: '',
      responseTime: Date.now() - start
    };
  } finally {
    if (tabId != null && activeAnalysisControllers.get(tabId) === controller) {
      activeAnalysisControllers.delete(tabId);
    }
  }
}

// ── Provider Calls ────────────────────────────────────────────

async function callAnthropic(apiKey, model, systemPrompt, userPrompt, signal) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `Anthropic error ${resp.status}`); }
  const data = await resp.json();
  return parseJSON(data.content?.[0]?.text || '');
}

async function callOpenAI(apiKey, model, systemPrompt, userPrompt, signal) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `OpenAI error ${resp.status}`); }
  const data = await resp.json();
  return parseJSON(data.choices?.[0]?.message?.content || '');
}

async function callGemini(apiKey, model, systemPrompt, userPrompt, signal) {
  const m = model || 'gemini-2.5-flash-lite';
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [{
          parts: [{ text: userPrompt }]
        }],
        generationConfig: {
          response_mime_type: "application/json",
          temperature: 0.1,
          maxOutputTokens: 600
        }
      })
    }
  );
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error?.message || `Gemini error ${resp.status}`);
  }
  // The API is now forced to return clean JSON due to response_mime_type
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsed = parseJSON(rawText);
  if (!parsed.answer) {
    throw new Error('Gemini returned an empty response — model may be overloaded or blocked by safety filters');
  }
  return parsed;
}

async function callGroq(apiKey, model, systemPrompt, userPrompt, signal) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      max_tokens: 600,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  if (!resp.ok) { const e = await resp.json().catch(()=>({})); throw new Error(e.error?.message || `Groq error ${resp.status}`); }
  const data = await resp.json();
  return parseJSON(data.choices?.[0]?.message?.content || '');
}

function parseJSON(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse AI response');
  return JSON.parse(match[0]);
}

// ── Heuristic Fallback ────────────────────────────────────────
function normalizeAIResult(result) {
  if (!result || typeof result !== 'object') throw new Error('AI returned an empty response');
  const answer = String(result.answer || '').trim();
  if (!answer) throw new Error('AI returned an empty answer');
  const confidence = Number(result.confidence);
  return {
    answer,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    explanation: String(result.explanation || ''),
    reasoning: String(result.reasoning || ''),
    subject: String(result.subject || '')
  };
}

function patternBasedAnalysis(question, choices) {
  const q = question.toLowerCase();
  let hint = '';
  if (q.includes('not') || q.includes('except') || q.includes('false')) hint = 'Look for the NEGATIVE or exception.';
  else if (q.includes('best') || q.includes('most')) hint = 'Look for the most complete answer.';
  else if (q.includes('always') || q.includes('never')) hint = 'Absolute statements are rarely correct.';

  let bestIdx = 0;
  if (choices && choices.length > 1) {
    bestIdx = choices.reduce((bi, c, i) => c.length > choices[bi].length ? i : bi, 0);
  }

  const hasChoices = Array.isArray(choices) && choices.length > 0;
  const letter = hasChoices ? String.fromCharCode(65 + bestIdx) : '—';
  const answer = hasChoices ? `${letter}) ${choices[bestIdx]}` : 'Add an API key for AI answers';

  return {
    answer,
    confidence: 0.3,
    explanation: hint || 'No API key set. Add one in Settings for accurate AI answers.',
    reasoning: 'Heuristic fallback (longest answer selected).',
    subject: 'Unknown'
  };
}

function extractKnownCorrectAnswer(context) {
  const match = String(context || '').match(/KNOWN_CORRECT_ANSWER:\s*(.+?)(?:\n|$)/i);
  return match ? match[1].trim() : '';
}

// ── Helpers ───────────────────────────────────────────────────
function addLogEntry(entry) {
  sessionLog.unshift(entry);
  if (sessionLog.length > 500) sessionLog = sessionLog.slice(0, 500);
  chrome.storage.local.set({ sessionLog });
}
function calcAvgResponseTime() {
  const times = sessionLog.filter(e => e.responseTime).map(e => e.responseTime);
  return times.length ? Math.round(times.reduce((a,b)=>a+b,0)/times.length) : 0;
}
function calcAvgConfidence() {
  const scores = sessionLog.filter(e => e.confidence).map(e => e.confidence);
  return scores.length ? (scores.reduce((a,b)=>a+b,0)/scores.length*100).toFixed(0) : 0;
}
function broadcastToTabs(msg) {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, msg).catch(()=>{}));
  });
}
chrome.tabs.onRemoved.addListener(tabId => {
  activeTabs.delete(tabId);
  activeAnalysisControllers.get(tabId)?.abort();
  activeAnalysisControllers.delete(tabId);
});
