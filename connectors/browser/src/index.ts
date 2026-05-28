#!/usr/bin/env node
/**
 * Browser MCP connector.
 *
 * Drives a real Chromium browser via Playwright with stealth-plugin so
 * navigator.webdriver and other automation fingerprints are scrubbed. The
 * browser uses a persistent user-data-dir so cookies, localStorage, and
 * service-worker state survive across sessions — log in once, stay logged in.
 *
 * All tools operate on the "current page" by default; pass `tab_index` to
 * target a specific tab.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve as resolvePath } from "node:path";
import type { Page } from "playwright";
import { BrowserSession, loadConfig } from "./session.js";

const session = new BrowserSession(loadConfig(process.env));

const server = new McpServer({
  name: "browser-connector",
  version: "0.1.0",
});

function jsonText(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function plainText(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

const tabIndexArg = {
  tab_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Tab index from `list_tabs`. Default: current tab."),
};

// =====================================================================
// Session
// =====================================================================

server.tool(
  "start_browser",
  "Launch the browser (idempotent — does nothing if already started). " +
    "Uses a persistent user-data-dir so logins, cookies, and history are kept between runs. " +
    "Stealth plugin is always on.",
  {},
  async () => {
    const r = await session.start();
    return jsonText({
      started: true,
      pages: r.pages,
      first_url: r.firstUrl,
      config: session.describeConfig(),
    });
  },
);

server.tool(
  "close_browser",
  "Close the browser. The user-data-dir is preserved, so the next `start_browser` resumes the same session.",
  {},
  async () => {
    await session.close();
    return jsonText({ closed: true });
  },
);

server.tool(
  "session_info",
  "Report whether the browser is running, the current configuration, and the open tabs.",
  {},
  async () => {
    if (!session.isStarted()) {
      return jsonText({ started: false, config: session.describeConfig() });
    }
    const tabs = session.getTabs();
    return jsonText({
      started: true,
      tabs: tabs.length,
      current_url: session.getPage().url(),
      config: session.describeConfig(),
    });
  },
);

// =====================================================================
// Helpers
// =====================================================================

async function ensureStarted(): Promise<void> {
  if (!session.isStarted()) await session.start();
}

function pageOr(tabIndex?: number): Page {
  return session.getPage(tabIndex);
}

// =====================================================================
// Navigation
// =====================================================================

server.tool(
  "goto",
  "Navigate the current tab to a URL.",
  {
    url: z.string().describe("Full URL (must include scheme, e.g. https://)"),
    wait_until: z
      .enum(["load", "domcontentloaded", "networkidle", "commit"])
      .optional()
      .describe("When to consider navigation succeeded. Default: load."),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ url, wait_until, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    const resp = await page.goto(url, {
      waitUntil: wait_until ?? "load",
      timeout: timeout_ms,
    });
    return jsonText({
      url: page.url(),
      title: await page.title(),
      status: resp?.status() ?? null,
      ok: resp?.ok() ?? null,
    });
  },
);

server.tool(
  "back",
  "Navigate back in the tab's history.",
  { ...tabIndexArg },
  async ({ tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.goBack();
    return jsonText({ url: page.url(), title: await page.title() });
  },
);

server.tool(
  "forward",
  "Navigate forward in the tab's history.",
  { ...tabIndexArg },
  async ({ tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.goForward();
    return jsonText({ url: page.url(), title: await page.title() });
  },
);

server.tool(
  "reload",
  "Reload the current tab.",
  { ...tabIndexArg },
  async ({ tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.reload();
    return jsonText({ url: page.url(), title: await page.title() });
  },
);

server.tool(
  "wait_for_load",
  "Wait for the page to reach a load state.",
  {
    state: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .optional()
      .describe("Default: load."),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ state, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.waitForLoadState(state ?? "load", { timeout: timeout_ms });
    return jsonText({ ok: true, url: page.url() });
  },
);

// =====================================================================
// Reading
// =====================================================================

server.tool(
  "get_url",
  "Return the URL of the current (or specified) tab.",
  { ...tabIndexArg },
  async ({ tab_index }) => jsonText({ url: pageOr(tab_index).url() }),
);

server.tool(
  "get_title",
  "Return the document title of the current (or specified) tab.",
  { ...tabIndexArg },
  async ({ tab_index }) => jsonText({ title: await pageOr(tab_index).title() }),
);

server.tool(
  "get_text",
  "Return visible text content. If `selector` is given, returns the text of that element; otherwise the whole body. " +
    "Useful for extracting data without screenshotting.",
  {
    selector: z
      .string()
      .optional()
      .describe("CSS, XPath (xpath=...), text= or role= selector."),
    max_chars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Truncate result to this many characters. Default: 50000."),
    ...tabIndexArg,
  },
  async ({ selector, max_chars, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    let text: string;
    if (selector) {
      text = (await page.locator(selector).first().textContent()) ?? "";
    } else {
      text = await page.evaluate(() => document.body?.innerText ?? "");
    }
    const limit = max_chars ?? 50_000;
    if (text.length > limit) {
      text = text.slice(0, limit) + `\n[... truncated, ${text.length - limit} more chars]`;
    }
    return plainText(text);
  },
);

server.tool(
  "get_html",
  "Return the HTML of the page or a specific element. Useful for understanding structure when text alone is ambiguous.",
  {
    selector: z.string().optional(),
    max_chars: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, max_chars, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    let html: string;
    if (selector) {
      html = (await page.locator(selector).first().innerHTML()) ?? "";
    } else {
      html = await page.content();
    }
    const limit = max_chars ?? 100_000;
    if (html.length > limit) {
      html = html.slice(0, limit) + `\n<!-- truncated, ${html.length - limit} more chars -->`;
    }
    return plainText(html);
  },
);

server.tool(
  "screenshot",
  "Capture a screenshot of the page (or a single element). Writes a PNG to disk and returns the path.",
  {
    path: z
      .string()
      .describe("Output file path, e.g. ./screenshot.png. Absolute or relative."),
    full_page: z.boolean().optional().describe("Capture the full scrollable page. Default: false."),
    selector: z.string().optional().describe("If given, screenshot only this element."),
    ...tabIndexArg,
  },
  async ({ path, full_page, selector, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    const out = resolvePath(path);
    if (selector) {
      await page.locator(selector).first().screenshot({ path: out });
    } else {
      await page.screenshot({ path: out, fullPage: full_page ?? false });
    }
    return jsonText({ path: out });
  },
);

server.tool(
  "pdf",
  "Save the current page as a PDF. Headless-only (Playwright limitation).",
  {
    path: z.string().describe("Output PDF path."),
    format: z.string().optional().describe("Paper format e.g. A4, Letter. Default: A4."),
    landscape: z.boolean().optional(),
    ...tabIndexArg,
  },
  async ({ path, format, landscape, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    const out = resolvePath(path);
    const buf = await page.pdf({
      path: out,
      format: format ?? "A4",
      landscape: landscape ?? false,
    });
    return jsonText({ path: out, bytes: buf.length });
  },
);

// =====================================================================
// Interaction
// =====================================================================

const clickArgs = {
  selector: z
    .string()
    .describe("CSS, XPath (xpath=...), text= or role= selector."),
  timeout_ms: z.number().int().positive().optional(),
  force: z.boolean().optional().describe("Bypass actionability checks."),
  ...tabIndexArg,
};

server.tool(
  "click",
  "Click an element. Resolves the selector to the first match.",
  clickArgs,
  async ({ selector, timeout_ms, force, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().click({ timeout: timeout_ms, force });
    return jsonText({ clicked: selector, url_after: page.url() });
  },
);

server.tool(
  "double_click",
  "Double-click an element.",
  clickArgs,
  async ({ selector, timeout_ms, force, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().dblclick({ timeout: timeout_ms, force });
    return jsonText({ double_clicked: selector });
  },
);

server.tool(
  "right_click",
  "Right-click an element (opens the context menu).",
  clickArgs,
  async ({ selector, timeout_ms, force, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page
      .locator(selector)
      .first()
      .click({ button: "right", timeout: timeout_ms, force });
    return jsonText({ right_clicked: selector });
  },
);

server.tool(
  "hover",
  "Hover the mouse over an element.",
  clickArgs,
  async ({ selector, timeout_ms, force, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().hover({ timeout: timeout_ms, force });
    return jsonText({ hovered: selector });
  },
);

server.tool(
  "type",
  "Type text into the currently-focused element (or focus a selector first and type). Simulates real keystrokes — use this when a site needs key-by-key input events.",
  {
    text: z.string().describe("Text to type."),
    selector: z
      .string()
      .optional()
      .describe("Optional selector to focus first."),
    delay_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Delay between keystrokes in ms. Default: 0."),
    ...tabIndexArg,
  },
  async ({ text, selector, delay_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    if (selector) {
      await page.locator(selector).first().focus();
    }
    await page.keyboard.type(text, { delay: delay_ms ?? 0 });
    return jsonText({ typed_chars: text.length });
  },
);

server.tool(
  "fill",
  "Set the value of an <input> or <textarea> in one shot. Faster than `type` when key-by-key events aren't needed.",
  {
    selector: z.string(),
    text: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, text, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().fill(text, { timeout: timeout_ms });
    return jsonText({ filled: selector, length: text.length });
  },
);

server.tool(
  "clear",
  "Clear the value of an input/textarea.",
  {
    selector: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().fill("", { timeout: timeout_ms });
    return jsonText({ cleared: selector });
  },
);

server.tool(
  "press_key",
  "Press a key (or chord). Examples: 'Enter', 'Escape', 'Control+C', 'ArrowDown'.",
  {
    key: z.string().describe("Playwright keyboard key string."),
    selector: z
      .string()
      .optional()
      .describe("Optional selector to focus first."),
    ...tabIndexArg,
  },
  async ({ key, selector, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    if (selector) await page.locator(selector).first().focus();
    await page.keyboard.press(key);
    return jsonText({ pressed: key });
  },
);

server.tool(
  "select_option",
  "Select an <option> in a <select> by value, label, or index.",
  {
    selector: z.string().describe("Selector for the <select> element."),
    value: z.string().optional(),
    label: z.string().optional(),
    index: z.number().int().min(0).optional(),
    ...tabIndexArg,
  },
  async ({ selector, value, label, index, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    const target: { value?: string; label?: string; index?: number } = {};
    if (value != null) target.value = value;
    if (label != null) target.label = label;
    if (index != null) target.index = index;
    if (Object.keys(target).length === 0) {
      throw new Error("select_option requires one of: value, label, index");
    }
    const result = await page.locator(selector).first().selectOption(target);
    return jsonText({ selected: result });
  },
);

server.tool(
  "check",
  "Check a checkbox or radio button.",
  {
    selector: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().check({ timeout: timeout_ms });
    return jsonText({ checked: selector });
  },
);

server.tool(
  "uncheck",
  "Uncheck a checkbox.",
  {
    selector: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.locator(selector).first().uncheck({ timeout: timeout_ms });
    return jsonText({ unchecked: selector });
  },
);

server.tool(
  "upload_file",
  "Set the file(s) on an <input type=file>.",
  {
    selector: z.string(),
    paths: z
      .array(z.string())
      .min(1)
      .describe("Absolute or relative paths to the files to upload."),
    ...tabIndexArg,
  },
  async ({ selector, paths, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    const abs = paths.map((p) => resolvePath(p));
    await page.locator(selector).first().setInputFiles(abs);
    return jsonText({ uploaded: abs });
  },
);

// =====================================================================
// Search / wait
// =====================================================================

server.tool(
  "find_elements",
  "Find elements matching a selector and return summary info (count, visible-text snippets, attributes). Useful for the agent to inspect what's on the page without dumping full HTML.",
  {
    selector: z.string(),
    max_results: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, max_results, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    const locator = page.locator(selector);
    const total = await locator.count();
    const limit = Math.min(total, max_results ?? 20);
    const results: Array<Record<string, unknown>> = [];
    for (let i = 0; i < limit; i++) {
      const el = locator.nth(i);
      const [text, tag, attrs] = await Promise.all([
        el.textContent().catch(() => null),
        el.evaluate((e: Element) => e.tagName.toLowerCase()).catch(() => null),
        el
          .evaluate((e: Element) => {
            const out: Record<string, string> = {};
            for (const a of e.attributes) out[a.name] = a.value;
            return out;
          })
          .catch(() => ({})),
      ]);
      const trimmed = (text ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      results.push({ index: i, tag, text: trimmed, attributes: attrs });
    }
    return jsonText({ total, returned: results.length, results });
  },
);

server.tool(
  "wait_for_selector",
  "Wait until an element matching the selector appears (or reaches a state).",
  {
    selector: z.string(),
    state: z
      .enum(["attached", "detached", "visible", "hidden"])
      .optional()
      .describe("Default: visible."),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, state, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page
      .locator(selector)
      .first()
      .waitFor({ state: state ?? "visible", timeout: timeout_ms });
    return jsonText({ ok: true, selector });
  },
);

server.tool(
  "wait_for_text",
  "Wait until the given text appears anywhere on the page. Useful for SPA navigation.",
  {
    text: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ text, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.getByText(text).first().waitFor({ timeout: timeout_ms });
    return jsonText({ ok: true, text });
  },
);

// =====================================================================
// Scrolling
// =====================================================================

server.tool(
  "scroll",
  "Scroll the page by a relative amount (in CSS pixels).",
  {
    delta_x: z.number().optional().describe("Default: 0."),
    delta_y: z.number().describe("Negative = up, positive = down."),
    ...tabIndexArg,
  },
  async ({ delta_x, delta_y, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.mouse.wheel(delta_x ?? 0, delta_y);
    return jsonText({ scrolled_by: { x: delta_x ?? 0, y: delta_y } });
  },
);

server.tool(
  "scroll_to",
  "Scroll to an absolute (x, y) position in the page.",
  {
    x: z.number().int(),
    y: z.number().int(),
    ...tabIndexArg,
  },
  async ({ x, y, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page.evaluate(([sx, sy]) => window.scrollTo(sx, sy), [x, y]);
    return jsonText({ scrolled_to: { x, y } });
  },
);

server.tool(
  "scroll_into_view",
  "Scroll until an element is visible.",
  {
    selector: z.string(),
    timeout_ms: z.number().int().positive().optional(),
    ...tabIndexArg,
  },
  async ({ selector, timeout_ms, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    await page
      .locator(selector)
      .first()
      .scrollIntoViewIfNeeded({ timeout: timeout_ms });
    return jsonText({ scrolled_into_view: selector });
  },
);

// =====================================================================
// Tabs
// =====================================================================

server.tool(
  "list_tabs",
  "List all open tabs with their index and URL.",
  {},
  async () => {
    await ensureStarted();
    const ctx = session.getContext();
    const pages = ctx.pages();
    const tabs = await Promise.all(
      pages.map(async (p, i) => ({
        index: i,
        url: p.url(),
        title: await p.title().catch(() => ""),
      })),
    );
    return jsonText(tabs);
  },
);

server.tool(
  "new_tab",
  "Open a new tab. Optionally navigate to a URL. The new tab becomes the current tab.",
  {
    url: z.string().optional(),
  },
  async ({ url }) => {
    await ensureStarted();
    const ctx = session.getContext();
    const page = await ctx.newPage();
    if (url) await page.goto(url);
    // Force currentPageId update by routing through getPage(tabIndex)
    const index = ctx.pages().indexOf(page);
    session.setCurrentTab(index);
    return jsonText({
      opened_index: index,
      url: page.url(),
      title: await page.title().catch(() => ""),
    });
  },
);

server.tool(
  "switch_tab",
  "Switch the current tab to the one at the given index.",
  { tab_index: z.number().int().min(0) },
  async ({ tab_index }) => {
    await ensureStarted();
    const page = session.setCurrentTab(tab_index);
    return jsonText({
      switched_to: tab_index,
      url: page.url(),
      title: await page.title().catch(() => ""),
    });
  },
);

server.tool(
  "close_tab",
  "Close the tab at the given index (default: current tab).",
  { ...tabIndexArg },
  async ({ tab_index }) => {
    await ensureStarted();
    const ctx = session.getContext();
    const page = tab_index != null ? ctx.pages()[tab_index] : pageOr();
    if (!page) throw new Error("tab not found");
    const idx = ctx.pages().indexOf(page);
    await page.close();
    return jsonText({ closed_index: idx, remaining_tabs: ctx.pages().length });
  },
);

// =====================================================================
// Cookies
// =====================================================================

server.tool(
  "get_cookies",
  "Return cookies for the current context, optionally filtered to one or more URLs.",
  {
    urls: z.array(z.string()).optional(),
  },
  async ({ urls }) => {
    await ensureStarted();
    const cookies = await session.getContext().cookies(urls);
    return jsonText(cookies);
  },
);

server.tool(
  "set_cookies",
  "Add cookies to the context. Each cookie needs at minimum {name, value, url or domain}.",
  {
    cookies: z.array(
      z
        .object({
          name: z.string(),
          value: z.string(),
          url: z.string().optional(),
          domain: z.string().optional(),
          path: z.string().optional(),
          expires: z.number().optional(),
          httpOnly: z.boolean().optional(),
          secure: z.boolean().optional(),
          sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
        })
        .passthrough(),
    ),
  },
  async ({ cookies }) => {
    await ensureStarted();
    await session.getContext().addCookies(cookies);
    return jsonText({ added: cookies.length });
  },
);

server.tool(
  "clear_cookies",
  "Clear all cookies (or just those for the given URL).",
  { url: z.string().optional() },
  async ({ url }) => {
    await ensureStarted();
    if (url) {
      const all = await session.getContext().cookies();
      const u = new URL(url);
      const keep = all.filter((c) => !c.domain.endsWith(u.hostname));
      await session.getContext().clearCookies();
      await session.getContext().addCookies(keep);
      return jsonText({ cleared_for: u.hostname, kept: keep.length });
    }
    await session.getContext().clearCookies();
    return jsonText({ cleared: "all" });
  },
);

// =====================================================================
// JS evaluation
// =====================================================================

server.tool(
  "evaluate",
  "Run JavaScript in the page context and return its result. The script body is wrapped in an async function — use `return X` or just an expression. The result must be JSON-serializable.",
  {
    script: z
      .string()
      .describe(
        "JavaScript body. Examples: 'document.title', 'document.querySelectorAll(\"a\").length', 'return await fetch(\"/api\").then(r => r.json())'.",
      ),
    ...tabIndexArg,
  },
  async ({ script, tab_index }) => {
    await ensureStarted();
    const page = pageOr(tab_index);
    // Wrap so the agent can use `return` even for one-liners.
    const wrapped = `(async () => { ${script} })()`;
    const result = await page.evaluate(wrapped);
    return jsonText({ result });
  },
);

// =====================================================================
// Boot
// =====================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("browser-connector MCP server running on stdio");
}

// Best-effort: close the browser cleanly on process exit signals.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await session.close();
  } catch {
    /* ignore */
  }
};
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
