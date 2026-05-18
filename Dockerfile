FROM node:18-alpine AS frontend-builder
WORKDIR /app/client
COPY client/package.json ./
COPY client/vite.config.js ./
RUN npm install --legacy-peer-deps
COPY client/ ./
RUN npm run build

FROM node:18-alpine AS production
WORKDIR /app
COPY server/package.json ./
RUN npm install --production
COPY server/ ./
COPY --from=frontend-builder /app/client/build ./client/build
ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]
