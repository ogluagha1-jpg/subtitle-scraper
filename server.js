import express from "express";
import cors from "cors";
import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(stealthPlugin());

const app = express();
const PORT = process.env.PORT || 7860;

app.use(cors());
app.use(express.json());

// Language detection from VTT filenames
const LANG_PATTERNS = [
    { pattern: /(_eng|[-_]en)\.vtt/i, lang: "English", code: "en" },
    { pattern: /(_ara|[-_]ar)\.vtt/i, lang: "Arabic", code: "ar" },
    { pattern: /(_fre|[-_]fr)\.vtt/i, lang: "French", code: "fr" },
    { pattern: /(_spa|[-_]es)\.vtt/i, lang: "Spanish", code: "es" },
    { pattern: /(_ger|[-_]de)\.vtt/i, lang: "German", code: "de" },
    { pattern: /(_tur|[-_]tr)\.vtt/i, lang: "Turkish", code: "tr" },
    { pattern: /(_por|[-_]pt)\.vtt/i, lang: "Portuguese", code: "pt" },
    { pattern: /(_ita|[-_]it)\.vtt/i, lang: "Italian", code: "it" },
    { pattern: /(_dut|[-_]nl)\.vtt/i, lang: "Dutch", code: "nl" },
    { pattern: /(_rus|[-_]ru)\.vtt/i, lang: "Russian", code: "ru" },
    { pattern: /(_chi|[-_]zh)\.vtt/i, lang: "Chinese", code: "zh" },
    { pattern: /(_jpn|[-_]ja)\.vtt/i, lang: "Japanese", code: "ja" },
    { pattern: /(_kor|[-_]ko)\.vtt/i, lang: "Korean", code: "ko" },
    { pattern: /(_hin|[-_]hi)\.vtt/i, lang: "Hindi", code: "hi" },
    { pattern: /(_ind|[-_]id)\.vtt/i, lang: "Indonesian", code: "id" },
    { pattern: /(_may|[-_]ms)\.vtt/i, lang: "Malay", code: "ms" },
    { pattern: /_sli\.vtt/i, lang: "Slovenian", code: "sl" },
];

// Global browser instance with memory management
let browser;
let requestCount = 0;
const MAX_REQUESTS_BEFORE_RECYCLE = 10; // Recycle browser every N requests
let activeRequests = 0;
const MAX_CONCURRENT = 2; // Max simultaneous scraping requests

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log("Launching fresh browser instance...");
        browser = await chromium.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-extensions",
                "--disable-background-networking",
                "--single-process",
                "--no-zygote",
                "--js-flags=--max-old-space-size=256",
            ],
        });
        requestCount = 0;
    }
    return browser;
}

async function recycleBrowser() {
    if (browser) {
        console.log(`[MEMORY] Recycling browser after ${requestCount} requests...`);
        try { await browser.close(); } catch (e) { /* ignore */ }
        browser = null;
    }
}

// Label-to-ISO-code mapping for metadata-based subtitle labels
const LABEL_TO_CODE = {
    'arabic': 'ar', 'english': 'en', 'french': 'fr', 'spanish': 'es',
    'german': 'de', 'turkish': 'tr', 'portuguese': 'pt', 'italian': 'it',
    'dutch': 'nl', 'russian': 'ru', 'chinese': 'zh', 'japanese': 'ja',
    'korean': 'ko', 'hindi': 'hi', 'indonesian': 'id', 'malay': 'ms',
    'slovenian': 'sl', 'swedish': 'sv', 'norwegian': 'no', 'danish': 'da',
    'finnish': 'fi', 'polish': 'pl', 'romanian': 'ro', 'croatian': 'hr',
    'czech': 'cs', 'hungarian': 'hu', 'greek': 'el', 'thai': 'th',
    'vietnamese': 'vi', 'hebrew': 'he', 'persian': 'fa', 'urdu': 'ur',
};

function labelToCode(label) {
    if (!label) return null;
    const base = label.toLowerCase().replace(/[\d\s]+$/g, '').trim(); // "English Hi2" -> "english hi" -> "english"
    const clean = base.replace(/\s+hi$/i, '').trim(); // "english hi" -> "english"
    return LABEL_TO_CODE[clean] || LABEL_TO_CODE[base] || null;
}

function detectLang(url) {
    const lowerUrl = url.toLowerCase();
    for (const { pattern, lang, code } of LANG_PATTERNS) {
        if (pattern.test(lowerUrl)) return { lang, code };
    }
    // Also check if the filename itself is a language name (e.g. /Arabic.vtt)
    const filenameMatch = lowerUrl.match(/\/([a-z]+[\d]*)\.vtt/i);
    if (filenameMatch) {
        const code = labelToCode(filenameMatch[1]);
        if (code) return { lang: filenameMatch[1], code };
    }
    return { lang: "Unknown", code: "und" };
}

/**
 * Step 1: Fetch the moviesapi.club page via plain HTTP and extract the
 * vidora.stream/embed/ iframe src URL.
 */
async function getEmbedUrl(tmdbId, type = "movie", season, episode) {
    let pageUrl;
    if (type === "tv" && season && episode) {
        pageUrl = `https://ww2.moviesapi.to/tv/${tmdbId}-${season}-${episode}`;
    } else {
        pageUrl = `https://ww2.moviesapi.to/movie/${tmdbId}`;
    }

    console.log(`[STEP1] Fetching ${pageUrl} via Playwright...`);
    const b = await getBrowser();
    const context = await b.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    try {
        await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 25000 });

        // Wait for potential redirects and iframe loading
        await page.waitForTimeout(4000);

        // Find the most likely player iframe
        const embedUrl = await page.evaluate(() => {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            // prioritize known domains, then fall back to any iframe with src
            const playerIframe = iframes.find(f =>
                f.src && (
                    f.src.includes('vidora.stream') ||
                    f.src.includes('flixcdn.cyou') ||
                    f.src.includes('/embed/') ||
                    f.src.includes('vidsrc') ||
                    f.src.includes('rabbitstream') ||
                    f.src.includes('2embed')
                )
            ) || iframes.find(f => f.src && f.src.startsWith('http'));
            return playerIframe ? playerIframe.src : null;
        });

        if (embedUrl) {
            console.log(`[STEP1] Found embed URL: ${embedUrl}`);
            return embedUrl;
        }

        // Fallback to searching the whole HTML if iframe not found via selector
        const html = await page.content();
        const iframeMatch = html.match(/src=["'](https?:\/\/[^"']+(vidora\.stream|flixcdn\.cyou|vidsrc|embed|rabbitstream|2embed)[^"']*)["']/i)
            || html.match(/src=["'](https?:\/\/[^"']+)["'].*?<\/iframe>/i);

        if (iframeMatch) {
            console.log(`[STEP1] Found embed URL (Regex): ${iframeMatch[1]}`);
            return iframeMatch[1];
        }

        // Log HTML for debugging when nothing is found
        const pageText = await page.evaluate(() => document.body?.innerText || '');
        console.log(`[STEP1] No player iframe found for ID ${tmdbId}. Page text: ${pageText.substring(0, 300)}`);
        console.log(`[STEP1] Page URL after redirects: ${page.url()}`);
        console.log(`[STEP1] Iframes found: ${await page.evaluate(() => document.querySelectorAll('iframe').length)}`);
        return null;
    } catch (err) {
        console.error(`[STEP1 ERROR] ${err.message}`);
        return null;
    } finally {
        await page.close().catch(() => { });
        await context.close().catch(() => { });
    }
}

/**
 * Step 2: Use Playwright to navigate to the embed URL and intercept
 * VTT/SRT subtitle network requests.
 */
async function scrapeSubtitles(embedUrl, langs = ["en", "ar"]) {
    console.log(`[STEP2] Scraping subtitles from ${embedUrl} ...`);
    const b = await getBrowser();
    const context = await b.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });
    const page = await context.newPage();

    const vttUrls = [];

    // Check if the URL itself contains subtitle metadata (common in flixcdn)
    try {
        const urlObj = new URL(embedUrl);
        const subsParam = urlObj.searchParams.get('subs') || (embedUrl.includes('#') ? new URLSearchParams(embedUrl.split('#')[1]).get('subs') : null);
        if (subsParam) {
            console.log(`[STEP2] Found 'subs' parameter in URL`);
            const decodedSubs = JSON.parse(decodeURIComponent(subsParam));
            if (Array.isArray(decodedSubs)) {
                decodedSubs.forEach(s => {
                    if (s.url && !vttUrls.find(v => v.url === s.url)) {
                        let { lang, code } = detectLang(s.url);
                        // If metadata provides a label, use it for both display and code
                        if (s.label) {
                            const labelCode = labelToCode(s.label);
                            if (labelCode) {
                                code = labelCode;
                                lang = s.label;
                            } else {
                                lang = s.label;
                            }
                        }
                        console.log(`[STEP2] Found subtitle (URL Metadata - ${lang} [${code}]): ${s.url}`);
                        vttUrls.push({ url: s.url, lang, code });
                    }
                });
            }
        }
    } catch (e) {
        // Not a URL with subs param or invalid JSON
    }

    page.on("request", (request) => {
        const reqUrl = request.url();
        if (/\.(vtt|srt)(\?.*)?$/i.test(reqUrl)) {
            if (!vttUrls.find((v) => v.url === reqUrl)) {
                const { lang, code } = detectLang(reqUrl);
                console.log(`[STEP2] Found subtitle (${lang}): ${reqUrl}`);
                vttUrls.push({ url: reqUrl, lang, code });
            }
        }
    });

    try {
        await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(3000);

        // Try extracting tracks directly from DOM/JWPlayer config (More reliable)
        const tracks = await page.evaluate(() => {
            const found = [];

            // 1. Look for JWPlayer tracks
            if (window.jwplayer && window.jwplayer().getConfig) {
                const config = window.jwplayer().getConfig();
                if (config.playlist && config.playlist[0] && config.playlist[0].tracks) {
                    config.playlist[0].tracks.forEach(t => {
                        if (t.file && (t.file.includes('.vtt') || t.file.includes('.srt'))) {
                            found.push(t.file);
                        }
                    });
                }
            }

            // 2. Look for script tags with JSON configs
            document.querySelectorAll('script').forEach(s => {
                const content = s.textContent;
                if (content.includes('tracks') && content.includes('.vtt')) {
                    const matches = content.match(/https?:\/\/[^"']+\.(vtt|srt)[^"']*/g);
                    if (matches) found.push(...matches);
                }
            });

            // 3. Look for video/track elements
            document.querySelectorAll('track').forEach(t => {
                if (t.src) found.push(t.src);
            });

            return found;
        });

        tracks.forEach(url => {
            console.log(`[STEP2] Evaluated Track: ${url}`);
            if (!vttUrls.find(v => v.url === url)) {
                const { lang, code } = detectLang(url);
                console.log(`[STEP2] Found subtitle (DOM): ${url} [${code}]`);
                vttUrls.push({ url, lang, code });
            }
        });

        const box = await page.locator("body").boundingBox();
        if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }

        await page.waitForTimeout(5000);
    } catch (err) {
        console.error(`[STEP2] Navigation error: ${err.message}`);
    }

    await page.close().catch(() => { });
    await context.close().catch(() => { });

    const filtered = vttUrls.filter((v) => langs.includes(v.code) || v.code === "und");
    console.log(`[STEP2] Total VTTs: ${vttUrls.length}, filtered: ${filtered.length}`);

    const results = [];
    for (const track of filtered) {
        try {
            console.log(`[DOWNLOAD] Attempting ${track.url}`);
            const resp = await fetch(track.url);
            console.log(`[DOWNLOAD] Status: ${resp.status} for ${track.url}`);
            if (resp.ok) {
                const content = await resp.text();
                console.log(`[DOWNLOAD] Content length: ${content.length}`);
                if (content.length > 50) {
                    results.push({
                        lang: track.lang,
                        lang_code: track.code,
                        url: track.url,
                        content,
                    });
                }
            }
        } catch (e) {
            console.error(`[DOWNLOAD ERROR] ${e.message}`);
        }
    }

    return results;
}

// ─── Subtitle Endpoint ──────────────────────────────────────────────────────

async function handleGetSubtitles(req, res) {
    const data = req.method === "POST" ? req.body : req.query;
    const tmdb_id = data.tmdb_id;

    if (!tmdb_id) {
        return res.status(400).json({ error: "Missing tmdb_id parameter" });
    }

    // Concurrency limiter
    if (activeRequests >= MAX_CONCURRENT) {
        console.log(`[API] Rejecting request for ${tmdb_id} — too many concurrent requests (${activeRequests}/${MAX_CONCURRENT})`);
        return res.status(429).json({ error: "Server busy, try again in a few seconds", tmdb_id });
    }

    activeRequests++;
    const type = data.type || "movie";
    const season = data.season;
    const episode = data.episode;
    const langs = (data.langs || "ar,en").split(",").map((l) => l.trim());

    console.log(`\n════════════════════════════════════════════`);
    console.log(`[API] ${req.method} Request: tmdb_id=${tmdb_id}, type=${type}, langs=${langs.join(",")} (active: ${activeRequests})`);

    try {
        const embedUrl = await getEmbedUrl(tmdb_id, type, season, episode);
        if (!embedUrl) {
            return res.json({ tmdb_id, count: 0, subtitles: [], error: "No embed URL found" });
        }

        const subtitles = await scrapeSubtitles(embedUrl, langs);

        console.log(`[API] Returning ${subtitles.length} subtitles for tmdb_id=${tmdb_id}`);
        res.json({ tmdb_id, count: subtitles.length, subtitles });
    } catch (err) {
        console.error(`[API ERROR] ${err.message}`);
        res.status(500).json({ error: "Scraping failed", details: err.message });
    } finally {
        activeRequests--;
        requestCount++;
        // Recycle browser periodically to free memory
        if (requestCount >= MAX_REQUESTS_BEFORE_RECYCLE && activeRequests === 0) {
            await recycleBrowser();
        }
    }
}

app.get("/get-subtitles", handleGetSubtitles);
app.post("/get-subtitles", handleGetSubtitles);

app.get("/", (req, res) => {
    const memUsage = process.memoryUsage();
    res.json({
        status: "running",
        message: "🎬 Subtitle Scraper API",
        requestCount,
        activeRequests,
        memory: {
            rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
            heap: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        },
    });
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.get("/debug-screenshot", async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send("URL required");

    let page;
    try {
        const browserInstance = await getBrowser();
        page = await browserInstance.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        const buffer = await page.screenshot({ fullPage: true });
        res.setHeader('Content-Type', 'image/png');
        res.send(buffer);
    } catch (err) {
        res.status(500).send(err.message);
    } finally {
        if (page) await page.close();
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Subtitle Scraper API listening on port ${PORT}`);
    getBrowser()
        .then(() => console.log("Browser initialized. Ready to scrape."))
        .catch(err => {
            console.error("CRITICAL: Failed to initialize browser on startup:", err.message);
        });
});

process.on("SIGINT", async () => {
    if (browser) await browser.close();
    process.exit();
});
process.on("SIGTERM", async () => {
    if (browser) await browser.close();
    process.exit();
});
