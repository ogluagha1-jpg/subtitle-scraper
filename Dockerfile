# Use the official Playwright image which includes all dependencies and browsers
FROM mcr.microsoft.com/playwright:v1.42.1-jammy

# Playwright image already has a user with UID 1000 (usually 'pwuser')
# We just need to ensure the app directory belongs to UID 1000
WORKDIR /app
RUN chown -R 1000:1000 /app

# Switch to the user with UID 1000
USER 1000
ENV HOME=/home/pwuser \
    PATH=/home/pwuser/.local/bin:$PATH


# Playwright image already has browsers in a global location, 
# so we don't need to install them again or set custom paths.

COPY --chown=user package*.json ./
RUN npm install

# Copy application files
COPY --chown=user . .

# Hugging Face requirement
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]


