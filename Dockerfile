# Use a modern Node image
FROM node:20-slim

# Install system dependencies for Playwright/Chromium
# These are the standard libs needed for headless browser on Debian/Ubuntu
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    libgbm-dev \
    libnss3 \
    libnspr4 \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# User 1000 is the default for Hugging Face Spaces
RUN chown -R 1000:1000 /app
USER 1000

# Install dependencies in the app's internal folder
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright

COPY --chown=1000:1000 package*.json ./
RUN npm install

# Install Chromium browser binary
RUN npx playwright install chromium

COPY --chown=1000:1000 . .

ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]

