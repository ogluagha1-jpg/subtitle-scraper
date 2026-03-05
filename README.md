# Subtitle Scraper API

A Node.js + Playwright API that extracts subtitles from streaming movie players.

## How it works

1. Fetches the embed URL from moviesapi.club for a given TMDB ID
2. Uses Playwright (headless browser) to navigate to the embed player
3. Intercepts VTT subtitle file network requests
4. Returns subtitle content as JSON

## API

```
GET /get-subtitles?tmdb_id=550&langs=ar,en
```

## Local Development

```bash
npm install
npx playwright install chromium
node server.js
```

## Deploy to Render

1. Create a new **Web Service** on [render.com](https://render.com)
2. Connect this repo
3. Set **Environment**: Docker
4. Set **Instance Type**: Free
5. Deploy!
