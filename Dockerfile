# Use the official Playwright image which includes all dependencies and browsers
FROM mcr.microsoft.com/playwright:v1.42.1-jammy

# Hugging Face uses user 1000
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

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


