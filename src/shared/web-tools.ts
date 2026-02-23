/**
 * Internet access tools for queen agents — zero API keys required.
 *
 * webSearch     → DuckDuckGo HTML scraping (no API key, no rate limits for basic use)
 * webFetch      → Jina Reader r.jina.ai (free, 20 req/min, converts any URL to clean markdown)
 * browserAction → Playwright chromium (headless, accessibility tree snapshots, OpenClaw pattern)
 */

const MAX_CONTENT_CHARS = 12_000
const MAX_SNAPSHOT_CHARS = 8_000

// ─── Singleton browser (OpenClaw pattern: launch once, reuse across calls) ──
// Each call gets a fresh context (isolated cookies/storage) but reuses the same
// browser process to avoid the ~2s startup cost on every tool invocation.

let _browser: import('playwright').Browser | null = null
let _browserInitPromise: Promise<import('playwright').Browser> | null = null

async function getBrowser(): Promise<import('playwright').Browser> {
  if (_browser?.isConnected()) return _browser
  if (_browserInitPromise) return _browserInitPromise
  _browserInitPromise = (async () => {
    const { chromium } = await import('playwright')
    _browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    _browser.on('disconnected', () => {
      _browser = null
      _browserInitPromise = null
    })
    return _browser
  })()
  return _browserInitPromise
}

/** Call during server shutdown to clean up the browser process. */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => { /* ignore */ })
    _browser = null
    _browserInitPromise = null
  }
}

// ─── webFetch ────────────────────────────────────────────────────────────────

/**
 * Fetch any public URL and return its content as clean LLM-friendly markdown.
 * Uses Jina Reader (r.jina.ai) — free, no API key, ~20 req/min rate limit.
 */
export async function webFetch(url: string): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-No-Cache': 'true'
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    throw new Error(`Jina fetch failed: ${response.status} ${response.statusText}`)
  }
  const text = await response.text()
  return text.slice(0, MAX_CONTENT_CHARS)
}

// ─── webSearch ───────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Search the web via DuckDuckGo HTML endpoint — no API key, no setup required.
 * Returns top 5 results with title, URL, and snippet.
 */
export async function webSearch(query: string): Promise<WebSearchResult[]> {
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`)
  }
  const html = await response.text()
  return parseDdgResults(html).slice(0, 5)
}

function parseDdgResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []

  // DuckDuckGo HTML result links: <a class="result__a" href="...">Title</a>
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  // DuckDuckGo snippets: <a class="result__snippet">...snippet...</a>
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

  const titles = [...html.matchAll(titleRe)]
  const snippets = [...html.matchAll(snippetRe)]

  for (let i = 0; i < Math.min(titles.length, 10); i++) {
    let url = titles[i][1]
    if (url.startsWith('//')) url = 'https:' + url
    results.push({
      url,
      title: stripHtml(titles[i][2]),
      snippet: snippets[i] ? stripHtml(snippets[i][1]) : ''
    })
  }
  return results
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── browserAction ───────────────────────────────────────────────────────────

export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; text?: string; selector?: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'wait'; ms: number }
  | { type: 'submit'; selector?: string }
  | { type: 'snapshot' }  // take an explicit accessibility snapshot at this step

/**
 * Control a headless Chromium browser to interact with websites.
 * Uses accessibility tree snapshots (OpenClaw pattern) — compact and LLM-friendly.
 * Requires Playwright + Chromium: run `npx playwright install chromium` once.
 *
 * Each call gets a fresh isolated browser context (clean cookies/storage).
 * The browser process itself is reused via singleton for performance.
 */
export async function browserAction(
  startUrl: string,
  actions: BrowserAction[],
  timeoutMs = 60_000
): Promise<string> {
  let browser: import('playwright').Browser
  try {
    browser = await getBrowser()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("Executable doesn't exist") || msg.includes('browserType.launch') || msg.includes('playwright')) {
      return 'Chromium not installed. Run: npx playwright install chromium'
    }
    throw err
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)

  const intermediateSnapshots: string[] = []

  const takeSnapshot = async (label?: string): Promise<string> => {
    // ARIA snapshot (Playwright >=1.46) — structured, compact, LLM-friendly
    // Falls back to innerText if ARIA snapshot fails (e.g. canvas-heavy pages)
    try {
      const text = await page.locator('body').ariaSnapshot().catch(() => null)
        ?? await page.innerText('body').catch(() => '')
      const prefix = label ? `[${label} — ${page.url()}]` : `[${page.url()}]`
      return `${prefix}\n${text.slice(0, MAX_SNAPSHOT_CHARS)}`
    } catch {
      const text = await page.innerText('body').catch(() => '(could not read page)')
      return `[${page.url()}]\n${text.slice(0, MAX_SNAPSHOT_CHARS)}`
    }
  }

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })

    for (const action of actions) {
      switch (action.type) {
        case 'navigate':
          await page.goto(action.url, { waitUntil: 'domcontentloaded' })
          break

        case 'click':
          if (action.selector) {
            await page.click(action.selector)
          } else if (action.text) {
            await page.getByText(action.text, { exact: false }).first().click()
          }
          await page.waitForTimeout(500) // brief settle after click
          break

        case 'fill':
          await page.fill(action.selector, action.value)
          break

        case 'select':
          await page.selectOption(action.selector, action.value)
          break

        case 'wait':
          await page.waitForTimeout(Math.min(action.ms, 10_000))
          break

        case 'submit':
          if (action.selector) {
            await page.click(action.selector)
          } else {
            await page.keyboard.press('Enter')
          }
          await page.waitForTimeout(1_000) // wait for navigation after submit
          break

        case 'snapshot':
          intermediateSnapshots.push(await takeSnapshot(`Step ${intermediateSnapshots.length + 1}`))
          break
      }
    }

    // Final page state
    const finalSnapshot = await takeSnapshot('Final')
    const parts = [finalSnapshot]
    if (intermediateSnapshots.length > 0) {
      parts.push(...intermediateSnapshots.map((s, i) => `[Intermediate step ${i + 1}]\n${s}`))
    }
    return parts.join('\n\n---\n\n')
  } finally {
    await context.close()
  }
}
