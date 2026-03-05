# Use a Debian-based image for better compatibility with Playwright dependencies
FROM node:20-bookworm

# Set environment variable to install browsers in the app directory for persistence and permissions
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
ENV PORT=7860

# Install system dependencies required by Playwright/Chromium
RUN apt-get update && apt-get install -y \
    libgbm1 \
    libasound2 \
    libnss3 \
    libxss1 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create a non-root user (Hugging Face uses UID 1000)
RUN chown -R 1000:1000 /app
USER 1000

# Copy package files first for better caching
COPY --chown=1000:1000 package*.json ./
RUN npm install

# Install only the chromium browser in the specified path
RUN npx playwright install chromium

# Copy the rest of the application
COPY --chown=1000:1000 . .

EXPOSE 7860

CMD ["node", "server.js"]

