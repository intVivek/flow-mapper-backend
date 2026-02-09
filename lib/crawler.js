import { chromium } from "playwright";

/**
 * @typedef {Object} CrawlPage
 * @property {string} url
 * @property {string} title
 */

/**
 * @typedef {Object} CrawlEdge
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} UserFlow
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string[]} pageUrls
 */

/**
 * @typedef {Object} CrawlResult
 * @property {CrawlPage[]} pages
 * @property {CrawlEdge[]} edges
 * @property {UserFlow[]} [flows]
 * @property {string[]} [globalNavUrls]
 * @property {CrawlEdge[]} [denoisedEdges]
 */

function getHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

function isSameSite(url, baseUrl) {
    const baseHost = getHostname(baseUrl);
    const urlHost = getHostname(url);
    if (baseHost === urlHost) return true;
    if (urlHost === `www.${baseHost}` || baseHost === `www.${urlHost}`) return true;
    return false;
}

function normalizeUrl(url, base) {
    try {
        const u = new URL(url, base);
        u.hash = "";
        if (u.pathname !== "/" && u.pathname.endsWith("/")) {
            u.pathname = u.pathname.slice(0, -1);
        }
        return u.href;
    } catch {
        return url;
    }
}

function isMeaningfulLink(href, baseUrl) {
    if (!href || href === "#" || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return false;
    try {
        const resolved = new URL(href, baseUrl);
        if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return false;
        if (!isSameSite(resolved.href, baseUrl)) return false;
        const path = resolved.pathname;
        if (path.match(/\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|css|js|woff2?|woff|ttf|eot)(\?|$)/i)) return false;
        return true;
    } catch {
        return false;
    }
}

const MAX_LINKS_PER_PAGE = 12;
const MAX_PATH_DEPTH = 5;

const GLOBAL_NAV_PATH_PATTERNS = /^\/(login|signin|signup|logout|register|terms|privacy|about|contact|help|faq|cookie)(\/|$)/i;

function isLikelyGlobalNav(pathname) {
    return GLOBAL_NAV_PATH_PATTERNS.test(pathname);
}

function pathDepth(pathname) {
    const segments = pathname.split("/").filter(Boolean);
    return segments.length;
}

function filterAndPrioritizeLinks(links, pageUrl, inboundCount, pageCount) {
    const meaningful = [];
    for (const href of links) {
        const targetUrl = normalizeUrl(href, pageUrl);
        if (!isMeaningfulLink(href, pageUrl)) continue;
        try {
            const path = new URL(targetUrl).pathname;
            if (isLikelyGlobalNav(path)) continue;
            if (pathDepth(path) > MAX_PATH_DEPTH) continue;
            meaningful.push(targetUrl);
        } catch {
            continue;
        }
    }

    const threshold = Math.max(2, Math.ceil(pageCount * 0.4));
    const prioritized = meaningful.filter((url) => {
        const count = inboundCount.get(normalizeUrl(url, pageUrl)) ?? 0;
        return count < threshold;
    });
    const toUse = prioritized.length > 0 ? prioritized : meaningful;
    return toUse.slice(0, MAX_LINKS_PER_PAGE);
}

async function performLogin(page, email, password, startUrl) {
    try {
        await page.goto(startUrl, { waitUntil: "load", timeout: 20000 });
        await new Promise((r) => setTimeout(r, 1500));

        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input[autocomplete="username"]',
            'input[placeholder*="mail" i]',
            'input[placeholder*="user" i]',
        ];
        const passSelector = 'input[type="password"]';
        const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            'button:has-text("Login")',
            '[type="submit"]',
        ];

        let emailEl = null;
        for (const sel of emailSelectors) {
            emailEl = await page.$(sel);
            if (emailEl) break;
        }
        const passEl = await page.$(passSelector);
        if (!emailEl || !passEl) return false;

        await emailEl.fill(email);
        await passEl.fill(password);

        let submitted = false;
        for (const sel of submitSelectors) {
            const btn = await page.$(sel);
            if (btn) {
                await btn.click();
                submitted = true;
                break;
            }
        }
        if (!submitted) return false;

        await page.waitForLoadState("networkidle").catch(() => { });
        await new Promise((r) => setTimeout(r, 2000));
        return true;
    } catch {
        return false;
    }
}

/**
 * @callback CrawlProgressCallback
 * @param {string} currentPage
 * @param {string[]} routes
 */

/**
 * @param {string} startUrl
 * @param {Object} [options]
 * @param {string} [options.email]
 * @param {string} [options.password]
 * @param {number} [options.maxPages]
 * @param {number} [options.maxTimeMs]
 * @param {CrawlProgressCallback} [options.onProgress]
 * @returns {Promise<CrawlResult>}
 */
export async function crawl(startUrl, options) {
    const { maxPages = 10, maxTimeMs, email, password, onProgress } = options ?? {};
    /** @type {CrawlPage[]} */
    const pages = [];
    /** @type {Map<string, Set<string>>} */
    const edgesMap = new Map();
    /** @type {Map<string, number>} */
    const inboundCount = new Map();
    /** @type {Set<string>} */
    const seenUrls = new Set();
    const queue = [normalizeUrl(startUrl, startUrl)];
    const startTime = Date.now();

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    const addEdge = (from, to) => {
        if (!edgesMap.has(from)) edgesMap.set(from, new Set());
        edgesMap.get(from).add(to);
    };

    try {
        if (email && password) {
            const loginPage = await context.newPage();
            await performLogin(loginPage, email, password, startUrl);
            await loginPage.close();
        }

        while (queue.length > 0 && pages.length < maxPages) {
            if (maxTimeMs && Date.now() - startTime >= maxTimeMs) break;
            const url = queue.shift();
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);

            const page = await context.newPage();

            try {
                await page.goto(url, { waitUntil: "load", timeout: 20000 });
            } catch {
                await page.close();
                continue;
            }

            await new Promise((r) => setTimeout(r, 1500));

            await page.evaluate(async () => {
                const delay = (ms) => new Promise((r) => setTimeout(r, ms));
                for (let i = 0; i < 5; i++) {
                    window.scrollTo(0, document.body.scrollHeight * ((i + 1) / 5));
                    await delay(400);
                }
                window.scrollTo(0, 0);
                await delay(500);
            }).catch(() => { });

            await new Promise((r) => setTimeout(r, 1000));

            const actualUrl = normalizeUrl(page.url(), url);
            if (actualUrl !== url) {
                seenUrls.add(actualUrl);
            }
            const pageUrl = actualUrl;
            const title = await page.title().catch(() => pageUrl);
            pages.push({ url: pageUrl, title });

            const links = await page.$$eval(
                "a[href], [data-href], [routerlink]",
                (els) => {
                    const base = window.location.href;
                    const hrefs = [];
                    els.forEach((el) => {
                        let href = el.href;
                        if (!href) {
                            const attr = el.getAttribute("href") ?? el.getAttribute("data-href") ?? el.getAttribute("routerlink");
                            if (attr) href = new URL(attr, base).href;
                        }
                        if (href && href !== "#" && !href.startsWith("javascript:")) hrefs.push(href);
                    });
                    return [...new Set(hrefs)];
                }
            ).catch(() =>
                page.$$eval(
                    "a[href]",
                    (anchors) =>
                        anchors
                            .map((a) => a.href)
                            .filter((h) => h && h !== "#" && !h.startsWith("javascript:"))
                )
            );

            const filtered = filterAndPrioritizeLinks(
                links,
                pageUrl,
                inboundCount,
                pages.length
            );
            const routes = [];
            for (const targetUrl of filtered) {
                const norm = normalizeUrl(targetUrl, pageUrl);
                routes.push(norm);
                addEdge(pageUrl, norm);
                inboundCount.set(norm, (inboundCount.get(norm) ?? 0) + 1);
                if (!seenUrls.has(norm)) {
                    queue.push(norm);
                }
            }
            onProgress?.(pageUrl, routes);

            await page.close();
        }
    } finally {
        await context.close();
        await browser.close();
    }

    /** @type {CrawlEdge[]} */
    const edges = [];
    for (const [from, toSet] of edgesMap) {
        for (const to of toSet) edges.push({ from, to });
    }
    return { pages, edges };
}
