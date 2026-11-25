FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install --immutable

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY deploy/base-config.mjs deploy/indexer-loop.mjs deploy/select-start-block.mjs ./deploy/
RUN mkdir -p storage /var/lib/ownables-hub/archives /var/lib/ownables-hub/quarantine \
    && chown -R node:node storage /var/lib/ownables-hub

USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
