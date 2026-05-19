# Stage 1: Build the React frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/client
COPY client/package.json ./
COPY client/vite.config.js ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine AS production

# Install native build tools needed for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY server/package.json ./
RUN npm install --production

COPY server/ ./
COPY --from=frontend-builder /app/client/build ./client/build

# Persistent data directory (mount a volume here in Cloud Run / Docker)
RUN mkdir -p /data

ENV PORT=8080
ENV NODE_ENV=production
ENV DATA_DIR=/data

EXPOSE 8080
CMD ["node", "index.js"]
