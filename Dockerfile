FROM node:20-slim

# Install build dependencies for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package metadata and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY bin ./bin
COPY src ./src
COPY assets ./assets
COPY README.md DEVELOPER_RUNBOOK.md ./

# Create directory for persistent volume mount
RUN mkdir -p /data /app/runtime && chmod 700 /data

# Default environment variables
ENV NODE_ENV=production

# Start the Telegram bot
CMD ["node", "bin/m-automation-bot.js"]
