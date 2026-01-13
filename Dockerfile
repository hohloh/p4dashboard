# ============================================================
# Perforce Dashboard - Docker Image
# Target: Synology NAS (x86_64 Linux)
# ============================================================

# ---- Stage 1: Build dependencies ----
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Stage 2: Final runtime image ----
FROM node:20-slim

# Install curl, ca-certificates (needed for HTTPS downloads) and create non-root user
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r p4dash && useradd -r -g p4dash p4dash

WORKDIR /app

# Download and install Perforce CLI (p4) for Linux x86_64
# Using the official Perforce download URL
RUN curl -fSL "https://cdist2.perforce.com/perforce/r24.2/bin.linux26x86_64/p4" \
    -o /usr/local/bin/p4 \
    && chmod +x /usr/local/bin/p4 \
    && p4 -V

# Copy node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY package*.json ./
COPY server.js ./
COPY public ./public

# Create data directory for credential storage
RUN mkdir -p /app/data && chown -R p4dash:p4dash /app

# Switch to non-root user
USER p4dash

# Expose the dashboard port
EXPOSE 4444

# Health check - verify server is responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:4444/ || exit 1

# Start the server
CMD ["node", "server.js"]
