# API AI driver

**Screen control for software that integrates an AI API. Let the AI assistant operate your software's screen — web, desktop, mobile — safely. Open-sourced by [VTransOps](https://vtransops.com).**

The AI sees only numbered text and has four actions: click, type, select, scroll. Decision controls — send, pay, place order, delete, sign, approve — **are always pressed by a person**.

## Why

**Efficiency**
- One sentence instead of a dozen clicks, in the session already open, with no separate robot browser.
- Acts by element number: no mis-clicked coordinates, no vision model reading screenshots.
- Add an assistant to existing software without writing an API for every screen.

**Data security**
- The model's API key lives only on the server; the user's device never calls the model provider directly.
- No screenshots: only the text of the open screen, never other windows.
- No "robot account": commands run with the user's own session and permissions; the user grants two levels, "draft" and "auto-save".
- No forged results (one id per command, only the right user can resolve it), a daily cap, a 25-second timeout.
- Screen text is data, not instructions: blocked at the point of action, not left to the model's good behaviour.

**Isolation of system code**
- The AI cannot run code. The page library's `executeJavascript` (`eval`) is never called, and a CSP without `unsafe-eval` makes the browser refuse it anyway.
- Model loop, prompt, tools and permissions stay on the server; the screen only receives type-checked commands.
- A warning on screen stops the assistant, which reports it word for word.

## Compared with page-agent / page-controller

| | page-agent (per README) | page-controller alone | API AI driver |
|---|---|---|---|
| API key, model calls | In web page code (`apiKey`, `baseURL`) | Calls no model | Server only |
| Arbitrary JavaScript | Not stated in the docs | Ships `executeJavascript` (`eval`) | Never called; CSP blocks it |
| Blocking decision / money / send controls | Not found in the docs | None | Yes, three classes |
| User-granted levels, stop on warnings | Not found in the docs | No | Yes |
| Platforms | Web | Web | Any software, through adapters |

Sources: [page-agent](https://github.com/alibaba/page-agent) README (lines 35, 77–87) and `docs/SECURITY.md`, `main`, 14 Nov 2026; page-controller 1.12.4 source. This compares default designs, not a criticism — this repository is the security layer on top of them.

## How to use

Three classes of controls: **blocked** (never pressed), **write** (only with auto-save on), **normal**. Mark them in your UI:

```html
<button data-ai="block">Place order</button>
<button data-ai="write">Save</button>
```

Unmarked controls fall back to default rules in English and Vietnamese.

- `src/screen-agent.js` — the platform-independent guard.
- `src/adapters/web-page-controller.js` — web adapter. Desktop / mobile: write a seven-function adapter (`read`, `describe`, `click`, `type`, `select`, `scroll`, `watch`) on the OS accessibility API.
- `src/server-tools.js` — the `read_screen` / `act_on_screen` model tools and the relay to the user's device. Tool definitions use the common `input_schema` tool format; rename the field if your provider expects another name.

```bash
npm test            # 22 tests
npm run demo        # http://localhost:8080/demo/ — three sample screens, no API key
```

In the demo, press `read_screen` to see the screen as numbered text, then send commands by number: "✅ Confirm & Start", "Place order", "Refund" and "Issue invoice" are blocked; "Add to cart" and "Save entry" need auto-save; "Save address" with an empty field makes the screen show an error → stopped.

## Limits

- The control guard stops mistakes and manipulation; **it does not replace server-side authorisation**.
- The open screen's text still goes to the model provider (through the server); pick suitable data terms.
- Only the web adapter is included so far.

## Origin and license

Built for the AI assistant of [VTransOps](https://vtransops.com) — transport management, route dispatch, nationwide truck-ban and time-ban rules for Vietnam. The code here is a rewrite for general use. The web adapter uses Alibaba's [`@page-agent/page-controller`](https://github.com/alibaba/page-agent) (MIT), loaded from jsDelivr, not bundled. MIT license — see [`LICENSE`](LICENSE).
