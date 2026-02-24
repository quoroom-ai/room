/**
 * Internet access tools for queen agents — zero API keys required.
 *
 * webSearch     → Playwright DDG (primary), HTTP DDG (fallback), Jina Search (last resort)
 * webFetch      → Jina Reader (primary), Playwright browser (fallback for blocked sites)
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
 * Tries Jina Reader first (fast, clean markdown), falls back to Playwright
 * for sites that block Jina (403/404/etc).
 */
export async function webFetch(url: string): Promise<string> {
  // Try Jina Reader first (fast, returns clean markdown)
  try {
    const jinaUrl = `https://r.jina.ai/${url}`
    const response = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(20_000)
    })
    if (response.ok) {
      const text = await response.text()
      // Jina returns short error-only responses for blocked sites (403/404)
      if (text.length > 200 && !text.includes('Warning: Target URL returned error')) {
        return text.slice(0, MAX_CONTENT_CHARS)
      }
    }
  } catch { /* Jina failed, try Playwright */ }

  // Fallback: real browser (handles 403/blocked sites)
  return fetchWithBrowser(url)
}

async function fetchWithBrowser(url: string): Promise<string> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const text = await page.innerText('body').catch(() => '')
    if (!text) throw new Error(`Could not read content from ${url}`)
    return text.slice(0, MAX_CONTENT_CHARS)
  } finally {
    await context.close()
  }
}

// ─── webSearch ───────────────────────────────────────────────────────────────

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Search the web — Playwright Yahoo (primary), HTTP DDG (fallback), Jina (last resort).
 * Returns top 5 results with title, URL, and snippet.
 */
export async function webSearch(query: string): Promise<WebSearchResult[]> {
  // Primary: real browser on Yahoo (most reliable — DDG/Google/Bing block headless)
  const browserResults = await searchWithBrowser(query)
  if (browserResults.length > 0) return browserResults

  // Fallback: HTTP DDG (faster when DDG is up and not rate-limiting)
  const ddgResults = await searchDdg(query)
  if (ddgResults.length > 0) return ddgResults

  // Last resort: Jina Search
  try {
    const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { 'Accept': 'application/json', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) {
      const data = await response.json() as { data?: Array<{ title?: string; url?: string; description?: string; content?: string }> }
      if (data.data && Array.isArray(data.data)) {
        return data.data.slice(0, 5).map(r => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: (r.description ?? r.content ?? '').slice(0, 300)
        })).filter(r => r.url)
      }
    }
  } catch { /* all methods failed */ }

  return []
}

/** Search Yahoo using a real Playwright browser — Yahoo doesn't block headless Chromium. */
async function searchWithBrowser(query: string): Promise<WebSearchResult[]> {
  let browser: import('playwright').Browser
  try {
    browser = await getBrowser()
  } catch {
    return []
  }

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
  })
  const page = await context.newPage()

  try {
    await page.goto(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000
    })
    // Brief wait for JS rendering
    await page.waitForTimeout(1_000)

    // Extract organic results from Yahoo
    const results = await page.evaluate(() => {
      const items: Array<{ title: string; url: string; snippet: string }> = []
      const blocks = document.querySelectorAll('#web .algo, .dd.algo, .algo')
      for (const block of blocks) {
        const link = block.querySelector('a')
        const h3 = block.querySelector('h3')
        const snippetEl = block.querySelector('.compText p, .compText, p')
        if (!link) continue
        const url = link.getAttribute('href') || ''
        if (!url.startsWith('http')) continue
        items.push({
          title: h3 ? (h3.textContent || '').trim() : (link.textContent || '').trim(),
          url,
          snippet: snippetEl ? (snippetEl.textContent || '').trim().slice(0, 300) : ''
        })
        if (items.length >= 5) break
      }
      return items
    })

    return results.filter(r => r.url)
  } catch {
    return []
  } finally {
    await context.close()
  }
}

async function searchDdg(query: string): Promise<WebSearchResult[]> {
  // DDG returns 202 when rate-limited; retry up to 3 times with back-off
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt))
    try {
      const response = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://html.duckduckgo.com/',
        },
        body: `q=${encodeURIComponent(query)}&b=`,
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      })
      if (response.status === 202) continue // rate-limited, retry
      if (!response.ok) continue
      const html = await response.text()
      const results = parseDdgResults(html).slice(0, 5)
      if (results.length > 0) return results
    } catch { /* network error, try next attempt */ }
  }
  return []
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
