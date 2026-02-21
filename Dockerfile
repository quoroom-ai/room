FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/out/mcp ./out/mcp
COPY --from=build /app/out/ui ./out/ui

WORKDIR /app/out/mcp
RUN npm install --omit=dev

WORKDIR /app
EXPOSE 3700

CMD ["node", "out/mcp/api-server.js"]
