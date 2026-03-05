FROM node:20-bookworm

# Install Playwright system dependencies
RUN npx -y playwright@1.42.1 install --with-deps chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 7860

CMD ["node", "server.js"]
