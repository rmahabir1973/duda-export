FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright DATA_DIR=/tmp/duda-data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright
COPY . .
RUN useradd -m -u 10001 app && chown -R app /app && chmod +x /app/docker-entrypoint.sh
# Starts as root only to fix the volume's ownership, then runs the app as the unprivileged "app" user.
EXPOSE 3000
CMD ["/app/docker-entrypoint.sh"]
