/**
 * Browser session — lazy-launches a single persistent Chromium context and
 * keeps it alive across tool calls. The context is configured with
 * playwright-extra + stealth-plugin so navigator.webdriver, canvas/WebGL/font
 * fingerprints, and a few dozen other automation tells are scrubbed.
 *
 * The context uses a persistent userDataDir so cookies, localStorage,
 * sessionStorage, IndexedDB, and service workers survive between runs.
 *
 * The session also tracks the "current page" (the page most recently
 * navigated or interacted with) so most tools don't need an explicit
 * `tab_index` argument.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

export interface SessionConfig {
  headless: boolean;
  userDataDir: string;
  channel: "chrome" | "msedge" | undefined;
  viewport: { width: number; height: number };
  locale: string;
  timezone?: string;
  userAgent?: string;
  proxy?: string;
  defaultTimeoutMs: number;
  defaultNavigationTimeoutMs: number;
}

function parseViewport(input?: string): { width: number; height: number } {
  if (!input) return { width: 1280, height: 800 };
  const m = input.match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`Invalid viewport '${input}', expected WIDTHxHEIGHT`);
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export function loadConfig(env: NodeJS.ProcessEnv): SessionConfig {
  const userDataDir =
    env.BROWSER_USER_DATA_DIR ||
    join(homedir(), ".opencode-connectors", "browser-profile");
  mkdirSync(userDataDir, { recursive: true });

  const channelEnv = env.BROWSER_CHANNEL?.toLowerCase();
  const channel =
    channelEnv === "chrome" || channelEnv === "msedge" ? channelEnv : undefined;

  return {
    headless: parseBool(env.BROWSER_HEADLESS, true),
    userDataDir,
    channel,
    viewport: parseViewport(env.BROWSER_VIEWPORT),
    locale: env.BROWSER_LOCALE || "en-US",
    timezone: env.BROWSER_TIMEZONE || undefined,
    userAgent: env.BROWSER_USER_AGENT || undefined,
    proxy: env.BROWSER_PROXY || undefined,
    defaultTimeoutMs: parseInt(env.BROWSER_DEFAULT_TIMEOUT_MS || "30000", 10),
    defaultNavigationTimeoutMs: parseInt(
      env.BROWSER_NAVIGATION_TIMEOUT_MS || "45000",
      10,
    ),
  };
}

export class BrowserSession {
  private context: BrowserContext | null = null;
  private currentPageId: number = 0;
  private pageIds = new WeakMap<Page, number>();
  private nextPageId = 1;
  private config: SessionConfig;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  isStarted(): boolean {
    return this.context !== null;
  }

  async start(): Promise<{ pages: number; firstUrl: string }> {
    if (this.context) {
      return {
        pages: this.context.pages().length,
        firstUrl: this.context.pages()[0]?.url() ?? "about:blank",
      };
    }

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.config.headless,
      viewport: this.config.viewport,
      locale: this.config.locale,
      timezoneId: this.config.timezone,
      userAgent: this.config.userAgent,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    };
    if (this.config.channel) {
      launchOptions.channel = this.config.channel;
    }
    if (this.config.proxy) {
      launchOptions.proxy = { server: this.config.proxy };
    }

    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(
        this.config.userDataDir,
        launchOptions,
      );
    } catch (err) {
      // If the user asked for channel 'chrome' but it isn't installed, fall
      // back to bundled Chromium with a warning.
      const msg = (err as Error).message;
      if (
        this.config.channel === "chrome" &&
        (msg.includes("channel") || msg.includes("executable"))
      ) {
        console.error(
          "[browser] channel=chrome not available, falling back to bundled chromium",
        );
        delete launchOptions.channel;
        ctx = await chromium.launchPersistentContext(
          this.config.userDataDir,
          launchOptions,
        );
      } else {
        throw err;
      }
    }

    ctx.setDefaultTimeout(this.config.defaultTimeoutMs);
    ctx.setDefaultNavigationTimeout(this.config.defaultNavigationTimeoutMs);

    // Register existing pages and watch for new ones.
    for (const page of ctx.pages()) this.registerPage(page);
    if (ctx.pages().length === 0) {
      const p = await ctx.newPage();
      this.registerPage(p);
    }
    ctx.on("page", (page) => this.registerPage(page));

    this.context = ctx;
    const pages = ctx.pages();
    this.currentPageId = this.pageIds.get(pages[0])!;
    return { pages: pages.length, firstUrl: pages[0].url() };
  }

  async close(): Promise<void> {
    if (!this.context) return;
    await this.context.close();
    this.context = null;
    this.currentPageId = 0;
  }

  private registerPage(page: Page) {
    if (!this.pageIds.has(page)) {
      this.pageIds.set(page, this.nextPageId++);
    }
    page.on("close", () => {
      // No explicit cleanup needed (WeakMap); but if it was the current page,
      // shift focus to the most recently opened remaining page.
      if (this.context && this.pageIds.get(page) === this.currentPageId) {
        const remaining = this.context.pages();
        if (remaining.length > 0) {
          this.currentPageId = this.pageIds.get(remaining[remaining.length - 1]) ?? 0;
        } else {
          this.currentPageId = 0;
        }
      }
    });
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new Error(
        "Browser session is not started. Call `start_browser` first.",
      );
    }
    return this.context;
  }

  getPage(tabIndex?: number): Page {
    const ctx = this.requireContext();
    const pages = ctx.pages();
    if (pages.length === 0) {
      throw new Error("Browser has no open pages.");
    }
    if (tabIndex != null) {
      if (tabIndex < 0 || tabIndex >= pages.length) {
        throw new Error(
          `tab_index ${tabIndex} out of range (0..${pages.length - 1})`,
        );
      }
      const page = pages[tabIndex];
      this.currentPageId = this.pageIds.get(page)!;
      return page;
    }
    // Find page by currentPageId.
    for (const page of pages) {
      if (this.pageIds.get(page) === this.currentPageId) return page;
    }
    // Fallback: first page.
    const fallback = pages[0];
    this.currentPageId = this.pageIds.get(fallback)!;
    return fallback;
  }

  getContext(): BrowserContext {
    return this.requireContext();
  }

  getTabs(): Array<{ index: number; url: string; title_pending: boolean }> {
    const ctx = this.requireContext();
    return ctx.pages().map((p, i) => ({
      index: i,
      url: p.url(),
      title_pending: true, // titles are async; caller uses get_title if needed
    }));
  }

  setCurrentTab(index: number): Page {
    return this.getPage(index);
  }

  describeConfig() {
    return {
      headless: this.config.headless,
      user_data_dir: this.config.userDataDir,
      channel: this.config.channel ?? "(bundled chromium)",
      viewport: `${this.config.viewport.width}x${this.config.viewport.height}`,
      locale: this.config.locale,
      timezone: this.config.timezone ?? null,
      proxy: this.config.proxy ?? null,
      stealth: true,
    };
  }
}
