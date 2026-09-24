# Static widget server: builds widget/ and serves widget/dist with Caddy.
#   docker build -t mxwiki .
#   docker run -p 8080:80 -e MXWIKI_FRAME_ANCESTORS=https://element.example.org mxwiki
# Configuration: see examples/Caddyfile and docs/DEPLOY.md.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src/widget
COPY widget/package.json widget/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY widget/ ./
RUN pnpm build

FROM caddy:2-alpine
COPY examples/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/widget/dist /srv
EXPOSE 80 443
