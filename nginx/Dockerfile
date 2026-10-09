# Build context is the repository root (see docker-compose.yml).
FROM node:20-alpine AS lab
WORKDIR /lab
COPY frontend/package.json frontend/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=lab /lab/dist /usr/share/nginx/html/demo
