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

// Global browser instance
let browser;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log("Launching fresh browser instance...");
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });
    }
    return browser;
}

function detectLang(url) {
    const lowerUrl = url.toLowerCase();
    for (const { pattern, lang, code } of LANG_PATTERNS) {
        if (pattern.test(lowerUrl)) return { lang, code };
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
        pageUrl = `https://moviesapi.club/tv/${tmdbId}-${season}-${episode}`;
    } else {
        pageUrl = `https://moviesapi.club/movie/${tmdbId}`;
    }

    console.log(`[STEP1] Fetching ${pageUrl} ...`);
    const resp = await fetch(pageUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        },
    });

    if (!resp.ok) {
        throw new Error(`moviesapi.club returned ${resp.status}`);
    }

    const html = await resp.text();

    const iframeMatch = html.match(/src="(https?:\/\/[^"]*vidora\.stream\/embed\/[^"]*)"/i)
        || html.match(/src="(https?:\/\/[^"]*embed[^"]*)"/i);

    if (!iframeMatch) {
        console.log(`[STEP1] Could not find embed iframe in HTML. HTML sample: ${html.substring(0, 500)}`);
        return null;
    }

    console.log(`[STEP1] Found embed URL: ${iframeMatch[1]}`);
    return iframeMatch[1];
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

    const type = data.type || "movie";
    const season = data.season;
    const episode = data.episode;
    const langs = (data.langs || "ar,en").split(",").map((l) => l.trim());

    console.log(`\n════════════════════════════════════════════`);
    console.log(`[API] ${req.method} Request: tmdb_id=${tmdb_id}, type=${type}, langs=${langs.join(",")}`);

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
    }
}

app.get("/get-subtitles", handleGetSubtitles);
app.post("/get-subtitles", handleGetSubtitles);

app.get("/", (req, res) => {
    res.send("🎬 Subtitle Scraper API is running. Use /get-subtitles?tmdb_id=550");
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
