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
    { pattern: /_eng\.vtt/i, lang: "English", code: "en" },
    { pattern: /_ara\.vtt/i, lang: "Arabic", code: "ar" },
    { pattern: /_fre\.vtt/i, lang: "French", code: "fr" },
    { pattern: /_spa\.vtt/i, lang: "Spanish", code: "es" },
    { pattern: /_ger\.vtt/i, lang: "German", code: "de" },
    { pattern: /_tur\.vtt/i, lang: "Turkish", code: "tr" },
    { pattern: /_por\.vtt/i, lang: "Portuguese", code: "pt" },
    { pattern: /_ita\.vtt/i, lang: "Italian", code: "it" },
    { pattern: /_dut\.vtt/i, lang: "Dutch", code: "nl" },
    { pattern: /_rus\.vtt/i, lang: "Russian", code: "ru" },
    { pattern: /_chi\.vtt/i, lang: "Chinese", code: "zh" },
    { pattern: /_jpn\.vtt/i, lang: "Japanese", code: "ja" },
    { pattern: /_kor\.vtt/i, lang: "Korean", code: "ko" },
    { pattern: /_hin\.vtt/i, lang: "Hindi", code: "hi" },
    { pattern: /_ind\.vtt/i, lang: "Indonesian", code: "id" },
    { pattern: /_may\.vtt/i, lang: "Malay", code: "ms" },
    { pattern: /_sli\.vtt/i, lang: "Slovenian", code: "sl" },
];

// Global browser instance
let browser;

async function getBrowser() {
    if (!browser) {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });
    }
    return browser;
}

function detectLang(url) {
    for (const { pattern, lang, code } of LANG_PATTERNS) {
        if (pattern.test(url)) return { lang, code };
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

    // Extract iframe src from the HTML (e.g., src="https://vidora.stream/embed/e5ccbb10n1xp")
    const iframeMatch = html.match(/src="(https?:\/\/[^"]*vidora\.stream\/embed\/[^"]*)"/i)
        || html.match(/src="(https?:\/\/[^"]*embed[^"]*)"/i);

    if (!iframeMatch) {
        console.log(`[STEP1] Could not find embed iframe in HTML`);
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

        // Click center of page to trigger player (starts loading subtitles)
        const box = await page.locator("body").boundingBox();
        if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }

        // Wait for subtitle files to load
        await page.waitForTimeout(5000);
    } catch (err) {
        console.error(`[STEP2] Navigation error: ${err.message}`);
    }

    await page.close().catch(() => { });
    await context.close().catch(() => { });

    // Filter for requested languages
    const filtered = vttUrls.filter((v) => langs.includes(v.code) || v.code === "und");
    console.log(`[STEP2] Total VTTs: ${vttUrls.length}, filtered: ${filtered.length}`);

    // Download content for each filtered subtitle
    const results = [];
    for (const track of filtered) {
        try {
            console.log(`[DOWNLOAD] ${track.url}`);
            const resp = await fetch(track.url);
            if (resp.ok) {
                const content = await resp.text();
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

// ─── API Endpoint ───────────────────────────────────────────────────────────

app.get("/get-subtitles", async (req, res) => {
    const tmdb_id = req.query.tmdb_id;
    if (!tmdb_id) {
        return res.status(400).json({ error: "Missing tmdb_id parameter" });
    }

    const type = req.query.type || "movie";
    const season = req.query.season;
    const episode = req.query.episode;
    const langs = (req.query.langs || "ar,en").split(",").map((l) => l.trim());

    console.log(`\n════════════════════════════════════════════`);
    console.log(`[API] Request: tmdb_id=${tmdb_id}, type=${type}, langs=${langs.join(",")}`);

    try {
        // Step 1: Get the embed URL from moviesapi.club
        const embedUrl = await getEmbedUrl(tmdb_id, type, season, episode);
        if (!embedUrl) {
            return res.json({ tmdb_id, count: 0, subtitles: [], error: "No embed URL found" });
        }

        // Step 2: Scrape subtitles from the embed player
        const subtitles = await scrapeSubtitles(embedUrl, langs);

        console.log(`[API] Returning ${subtitles.length} subtitles for tmdb_id=${tmdb_id}`);
        res.json({ tmdb_id, count: subtitles.length, subtitles });
    } catch (err) {
        console.error(`[API ERROR] ${err.message}`);
        res.status(500).json({ error: "Scraping failed", details: err.message });
    }
});

app.get("/", (req, res) => {
    res.send("🎬 Subtitle Scraper API is running. Use /get-subtitles?tmdb_id=550");
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`Subtitle Scraper API listening on port ${PORT}`);
    getBrowser().then(() => console.log("Browser initialized. Ready to scrape."));
});

process.on("SIGINT", async () => {
    if (browser) await browser.close();
    process.exit();
});
process.on("SIGTERM", async () => {
    if (browser) await browser.close();
    process.exit();
});
