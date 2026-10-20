FROM node:22-bookworm-slim
WORKDIR /app

# Install deps first for better caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# SQLite + uploads live here — mount a persistent volume at /app/data and /app/public/assets/movies
RUN mkdir -p /app/data /app/public/assets/movies
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
