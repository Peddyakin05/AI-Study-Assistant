# AI Study Assistant

AI Study Assistant is an unpacked Chrome extension that scans visible quiz or study pages, sends detected questions to a configured AI provider, and shows suggested answers in an in-page overlay.

The extension can also manually answer a question typed into the overlay, keep a local history of analyzed questions, show all detected answers on a page, jump to a detected question by number, and optionally select a matched answer on the page when auto-select is enabled.

## Project Structure

```text
.
├── extension/
│   ├── manifest.json      Chrome extension manifest, Manifest V3
│   ├── background.js      Service worker for settings, provider API calls, logs
│   ├── content.js         Page scanner, overlay UI, answer matching/selection
│   ├── overlay.css        Injected overlay styles
│   ├── popup.html         Extension popup UI
│   ├── popup.js           Popup settings, provider setup, stats, history
│   └── icons/             Extension icons
├── dashboard/
│   └── index.html         Standalone demo/installation page
└── README.md
```

## What It Does

- Injects a draggable, resizable overlay into normal web pages.
- Detects multiple-choice questions through form controls, ARIA roles, known quiz selectors, likely question containers, and visible text heuristics.
- Supports Gemini, Groq, OpenAI, and Anthropic from the popup provider tab.
- Falls back to a simple local heuristic when no API key is configured.
- Logs analyzed questions locally in `chrome.storage.local` when history is enabled.
- Lets you pause/resume scanning, rescan the page, ask a custom question, copy answers, view reasoning, show all detected answers, and jump to a question number.
- Includes optional answer selection. Auto-select is off by default; when enabled from the overlay it stays enabled until you turn it off. The overlay also exposes a manual "Select Now" action.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `extension/` folder in this repo.
5. Pin or open the `AI Study Assistant` extension from the toolbar.

## Configure An AI Provider

1. Open the extension popup.
2. Go to `AI Providers`.
3. Expand a provider card.
4. Paste the provider API key.
5. Pick a model.
6. Click `Use This`.

Supported provider endpoints are:

- Google Gemini: `https://generativelanguage.googleapis.com`
- Groq: `https://api.groq.com`
- OpenAI: `https://api.openai.com`
- Anthropic: `https://api.anthropic.com`

The extension stores API keys in Chrome local extension storage.

## Controls

- `Alt+S` toggles the overlay by default.
- `Alt+R` forces a rescan.
- The popup `Controls` tab can enable/disable the overlay, change scan interval, change overlay position/size, change the hotkey, and enable/disable local history.
- The overlay footer can stop/resume AI scanning, analyze all detected questions, jump by question number, or rescan.

## Companion Dashboard

Open `dashboard/index.html` directly in a browser to view the demo page and installation instructions. Its live test area calls Anthropic directly from the page and is separate from the extension popup's multi-provider configuration.

## Notes

- The extension is intended for study and revision workflows.
- It requests broad host access because the content script and service worker are designed to run on arbitrary quiz pages and call selected AI provider APIs.
- Some websites may block or obscure question text, use nonstandard controls, or render inside iframes/shadow DOM. Detection is heuristic and may need per-site selector adjustments.
