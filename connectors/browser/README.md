# Browser connector

An MCP connector that drives a real Chromium browser via [Playwright](https://playwright.dev) with the [stealth-plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) so common automation fingerprints (`navigator.webdriver`, canvas/WebGL/font fingerprints, plugin lists, etc.) are scrubbed.

The browser uses a **persistent user-data-dir**, which means cookies, localStorage, IndexedDB, service workers, and login state survive between runs. Log in once, stay logged in forever (until you `clear_cookies`).

> **Use this on your own accounts and on sites whose terms of service allow automation.** Don't use it for fraud, fake accounts, mass scraping behind logins, or anything else you wouldn't put your name on.

## Setup

From the repo root:

```bash
npm install
npm run build
npx playwright install chromium    # one-time: download the browser
```

If you have a normal Chrome installed and want to use it instead of bundled Chromium (more stealthy because the user-agent and binary truly are Chrome), set:

```powershell
$env:BROWSER_CHANNEL = "chrome"
```

```bash
export BROWSER_CHANNEL=chrome
```

## Configuration (environment variables)

All are optional.

| Variable | Default | Effect |
|---|---|---|
| `BROWSER_HEADLESS` | `true` | Set to `false` to see the browser window. Useful for debugging. |
| `BROWSER_CHANNEL` | unset (bundled chromium) | `chrome` or `msedge` to use a system install. |
| `BROWSER_USER_DATA_DIR` | `~/.opencode-connectors/browser-profile` | Where to persist the browser profile. |
| `BROWSER_VIEWPORT` | `1280x800` | Viewport size as `WIDTHxHEIGHT`. |
| `BROWSER_LOCALE` | `en-US` | `Accept-Language` and `navigator.language`. |
| `BROWSER_TIMEZONE` | unset | IANA timezone, e.g. `America/New_York`. |
| `BROWSER_USER_AGENT` | unset | Override the User-Agent string. |
| `BROWSER_PROXY` | unset | Proxy URL, e.g. `http://user:pass@host:port`. |
| `BROWSER_DEFAULT_TIMEOUT_MS` | `30000` | Default timeout for tool ops. |
| `BROWSER_NAVIGATION_TIMEOUT_MS` | `45000` | Default timeout for navigation. |

## Wiring it into OpenCode

In `opencode.json`:

```json
{
  "mcp": {
    "browser": {
      "type": "local",
      "command": ["node", "./connectors/browser/dist/index.js"],
      "enabled": true,
      "environment": {
        "BROWSER_CHANNEL": "chrome",
        "BROWSER_HEADLESS": "true"
      }
    }
  }
}
```

## Tools

### Session
- `start_browser` — idempotent launch. Stealth plugin is always on.
- `close_browser` — close the browser; the profile is preserved.
- `session_info` — config + open tabs.

### Navigation
- `goto(url, wait_until?, timeout_ms?, tab_index?)`
- `back`, `forward`, `reload`
- `wait_for_load(state?, timeout_ms?)`

### Reading
- `get_url`, `get_title`
- `get_text(selector?, max_chars?)` — visible text of element or whole page.
- `get_html(selector?, max_chars?)` — raw HTML.
- `screenshot(path, full_page?, selector?)` — save PNG.
- `pdf(path, format?, landscape?)` — save PDF.

### Interaction
- `click`, `double_click`, `right_click`, `hover` — all take `selector`.
- `type(text, selector?, delay_ms?)` — real keystrokes.
- `fill(selector, text)` — fast value set for inputs.
- `clear(selector)`.
- `press_key(key, selector?)` — `Enter`, `Escape`, `Control+C`, etc.
- `select_option(selector, value? | label? | index?)`
- `check(selector)`, `uncheck(selector)`
- `upload_file(selector, paths[])`

### Search / wait
- `find_elements(selector, max_results?)` — list matches with text + attributes.
- `wait_for_selector(selector, state?, timeout_ms?)`
- `wait_for_text(text, timeout_ms?)`

### Scrolling
- `scroll(delta_x?, delta_y)`
- `scroll_to(x, y)`
- `scroll_into_view(selector)`

### Tabs
- `list_tabs`, `new_tab(url?)`, `switch_tab(tab_index)`, `close_tab(tab_index?)`

### Cookies / session
- `get_cookies(urls?)`, `set_cookies(cookies[])`, `clear_cookies(url?)`

### JS
- `evaluate(script)` — run arbitrary JS in the page; returns a JSON-serializable value.

## Selectors

All tools accept Playwright selectors. Common forms:

- CSS: `button.primary`, `#login`, `nav a:has-text("Pricing")`
- Text: `text=Sign in` or `text=/^Welcome/i`
- Role: `role=button[name="Submit"]`
- XPath: `xpath=//div[@id="root"]//h1`

## Notes

- **First call is slow** — the browser launches lazily on the first tool that needs it. Subsequent calls reuse the running browser, so they're fast.
- **Stealth isn't magic.** It defeats simple `navigator.webdriver`-style checks and common fingerprint heuristics, but determined anti-bot services (Cloudflare Bot Management, Akamai, PerimeterX, etc.) may still detect it. Don't expect to bypass aggressive WAFs.
- The connector uses one shared browser process. If you need parallel sessions, run multiple instances of the connector with different `BROWSER_USER_DATA_DIR` paths.
