FROM node:20-alpine AS frontend-builder
WORKDIR /build
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine
RUN apk add --no-cache tesseract-ocr \
  tesseract-ocr-data-eng \
  poppler-utils \
  build-base \
  python3
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY worker/package*.json ./worker/
RUN cd worker && npm install --omit=dev
COPY backend/ ./backend/
COPY worker/ ./worker/
COPY --from=frontend-builder /build/dist ./frontend/dist
WORKDIR /app/backend
ENV NODE_ENV=production
CMD ["node", "src/server.js"]
