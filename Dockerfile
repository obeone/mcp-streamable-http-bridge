FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

COPY src ./src
COPY config /config

RUN mkdir -p /app/logs && chown -R node:node /app /config
USER node

ENV PORT=8080

EXPOSE 8080

CMD ["node", "src/index.js"]
