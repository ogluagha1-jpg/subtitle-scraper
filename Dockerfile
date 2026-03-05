# Use official Playwright image which has ALL dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Set port for Hugging Face
ENV PORT=7860
ENV HOME=/home/pwuser

WORKDIR /app

# The official image creates a 'pwuser' with UID 1000, which matches Hugging Face
# We'll use this user for permissions
RUN chown -R 1000:1000 /app

USER 1000

# Copy package files
COPY --chown=1000:1000 package*.json ./
RUN npm install

# Copy the rest of the application
COPY --chown=1000:1000 . .

# Playwright browsers are already in /ms-playwright in the base image
# but we need to point to them if we want to use the pre-installed ones
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 7860

CMD ["node", "server.js"]
