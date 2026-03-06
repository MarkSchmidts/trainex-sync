FROM node:20-alpine

WORKDIR /app

# Install git (needed for cron script to push changes)
RUN apk add --no-cache git openssh-client

# Copy package files
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Create data directory (will be mounted as a volume)
RUN mkdir -p data/snapshots

# Configure git (for committing schedule updates)
RUN git config --global user.name "trainex-sync" && \
    git config --global user.email "trainex-sync@vps"

EXPOSE 3000

# Default: run the dashboard
CMD ["node", "src/server.js"]
