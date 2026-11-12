FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG HOMETUBE_LANG
ENV NEXT_PUBLIC_HOMETUBE_LANG=$HOMETUBE_LANG
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
# yt-dlp needs python; ffmpeg merges video + audio and converts thumbnails; fpcalc (chromaprint) fingerprints the audio
RUN apk add --no-cache ffmpeg python3 chromaprint \
  && wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/server.js ./
COPY --from=build /app/lib ./lib
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
EXPOSE 3000
# YouTube changes often and old yt-dlp versions stop working, so update it on every start
CMD ["sh", "-c", "yt-dlp -U || true; exec node server.js"]
