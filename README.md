# ⚡ AI Study Assistant

A Chrome Extension + companion dashboard that automatically detects exam questions on any quiz page, analyzes them with Claude AI, and displays suggested answers in a sleek, draggable overlay — **without ever clicking for you**.

---

## 📁 Project Structure

```
study-assistant/
├── extension/           ← Chrome Extension (load this into Chrome)
│   ├── manifest.json    ← Extension config (Manifest V3)
│   ├── background.js    ← Service worker: AI calls, logging, settings
│   ├── content.js       ← Injected into pages: question detection + overlay
│   ├── overlay.css      ← Overlay styling
│   ├── popup.html       ← Extension popup UI
│   ├── popup.js         ← Popup logic
│   └── icons/           ← Extension icons (add your own PNG icons here)
│
├── dashboard/
│   └── index.html       ← Standalone companion web app / live demo
│
└── README.md
```

---

## 🚀 Installation

### Step 1 — Prepare icons
Create or add these icon files in `extension/icons/`:
- `icon16.png`  (16×16)
- `icon48.png`  (48×48)
- `icon128.png` (128×128)

You can use any simple icon, or generate one with a favicon generator.

### Step 2 — Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **"Load unpacked"**
4. Select the **`extension/`** folder from this project
5. The ⚡ icon will appear in your Chrome toolbar

### Step 3 — Add your API key

1. Click the ⚡ extension icon in the toolbar
2. Go to the **Settings** tab
3. Paste your [Anthropic API key](https://console.anthropic.com) (starts with `sk-ant-`)
4. Click **Save Settings**

> **Without an API key**, the assistant runs in heuristic fallback mode (pattern matching, lower accuracy). With an API key, you get Claude AI-powered analysis.

---

## 🎯 How It Works

### Question Detection (3 strategies, in order):

1. **ARIA/Semantic** — looks for `role="radio"`, `role="checkbox"`, `role="option"` elements and nearby question text
2. **Platform Selectors** — pre-built selectors for 10+ platforms: Coursera, Khan Academy, Google Forms, Quizlet, Kahoot, Moodle, Blackboard, Canvas, and generic quiz patterns
3. **Heuristic Text Scan** — walks visible DOM text, detects question patterns (`?`, `which`, `what`, numbered questions, etc.) and choice patterns (`A)`, `(A)`, `1.`)

### AI Analysis Pipeline:

```
DOM scan → question extracted → hash check (skip if unchanged)
→ send to Claude API → parse JSON response
→ render in overlay (answer + confidence + explanation + reasoning)
→ log to history
```

### Overlay Features:
- 🔄 **Draggable** — grab the header to reposition anywhere
- ⏸ **Pause/Resume** — toggle scanning without closing
- 📋 **Copy Answer** — one-click copy to clipboard
- 📖 **Reasoning** — expand step-by-step AI reasoning
- ↻ **Rescan** — manually trigger a new scan
- ⌨️ **Hotkey** — `Alt+S` toggles the overlay (configurable)

---

## ⚙️ Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | `true` | Whether overlay is active |
| Scan Interval | `3s` | How often to check for new questions |
| Overlay Position | `top-right` | Corner/center placement |
| Overlay Size | `medium` (340px) | `small` / `medium` / `large` |
| API Key | — | Anthropic API key for Claude |
| AI Model | `claude-sonnet-4` | Model to use |
| Hotkey | `Alt+S` | Toggle keyboard shortcut |
| Log History | `true` | Whether to save detected Q&A |
| Multi-tab | `false` | Monitor all tabs simultaneously |

---

## 🌐 Supported Platforms

The extension has built-in selectors for:

| Platform | Detection |
|----------|-----------|
| Google Forms | ✅ Dedicated selectors |
| Khan Academy | ✅ Dedicated selectors |
| Coursera | ✅ Dedicated selectors |
| Moodle | ✅ Dedicated selectors |
| Canvas (Instructure) | ✅ Dedicated selectors |
| Blackboard | ✅ Dedicated selectors |
| Quizlet | ✅ Dedicated selectors |
| Kahoot | ✅ Dedicated selectors |
| PDF viewers (Chrome) | ⚠️ Text-layer dependent |
| Any quiz site | ✅ Heuristic fallback |

---

## 🧪 Companion Dashboard

Open `dashboard/index.html` in any browser to access:
- **Live question analyzer** — test the AI directly in the browser
- **Demo overlay preview** — see what the overlay looks like
- **Install guide** — step-by-step setup instructions
- **Session stats** — questions analyzed, confidence, speed

---

## 🔐 Privacy & Ethics

- **No auto-clicking** — the extension NEVER clicks answers for you. It only suggests.
- **Local settings** — all configuration stored in `chrome.storage.local`
- **API calls** — only made to `api.anthropic.com` with your own key
- **No tracking** — no analytics, no external data collection
- Intended for **study and revision**, not academic dishonesty in live exams

---

## 🛠 Extending & Customizing

### Add a new quiz platform

In `content.js`, add a new entry to the `QUIZ_SELECTORS` array:
```javascript
{ q: '.your-question-selector', a: '.your-choice-selector' }
```

### Change AI behavior

In `background.js`, edit the `systemPrompt` inside `analyzeQuestion()` to customize how Claude reasons about questions.

### Change overlay appearance

All overlay styles are in `overlay.css`. The overlay uses CSS variables and can be themed freely.

---

## 📋 Requirements

- Chrome 88+ (Manifest V3 support)
- Anthropic API key (for AI analysis)
- Internet connection (for API calls)

---

## 🐛 Troubleshooting

**Overlay doesn't appear:**
- Make sure extension is enabled in `chrome://extensions`
- Click the ⚡ icon and check the status bar says "Active"
- Some pages with strict CSP may block content script injection

**No questions detected:**
- Try clicking "↻ Rescan" in the overlay footer
- Check if the page uses dynamic content (may need a longer scan interval)
- Some PDF viewers don't expose text to the DOM

**AI not responding:**
- Verify your API key is correct in Settings
- Check the Chrome DevTools console for error messages
- Ensure your Anthropic account has active credits
