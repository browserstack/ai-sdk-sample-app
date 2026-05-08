FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

# The npm package.json points to ../sdk-vendor/...tgz, so the build context
# must be the project root. Stage the SDK tarball + package files first
# for layer caching.
COPY sdk-vendor/browserstack-ai-sdk-1.0.0-beta.3.tar.gz /app/sdk-vendor/browserstack-ai-sdk-1.0.0-beta.3.tgz
COPY node-backend/package.json node-backend/tsconfig.json /app/node-backend/

WORKDIR /app/node-backend
RUN npm install --no-audit --no-fund --omit=dev

# Copy source last so iteration doesn't bust the deps layer
COPY node-backend/src /app/node-backend/src
COPY node-backend/data /app/node-backend/data

# Build TypeScript
RUN npm install --no-audit --no-fund --include=dev typescript && \
    npx tsc -p .

# Run as the pre-built non-root `node` user (defense in depth — limits blast
# radius if the container process is compromised). The official node images
# ship this user out of the box.
RUN chown -R node:node /app
USER node

EXPOSE 3001

CMD ["node", "dist/server.js"]
