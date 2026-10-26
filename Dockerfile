FROM oven/bun:1.4.3-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV DATA_DIR=/app/data
CMD ["bun", "src/index.ts"]
