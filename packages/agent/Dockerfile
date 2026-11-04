# BRC agent image - for controlling a Linux server/container. On desktops prefer `npx`.
# docker run -d --name brc-agent -v brc-agent:/home/rdp/.brc -v /srv:/srv \
#   -e BRC_RELAY=https://rdp.example.com -e BRC_NAME=my-server brc/agent
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/agent/package.json packages/agent/tsconfig.json packages/agent/
RUN pnpm install --frozen-lockfile --filter brc-agent... --config.confirmModulesPurge=false
COPY packages/shared/src packages/shared/src
COPY packages/agent/src packages/agent/src
COPY packages/shared/LICENSE packages/shared/NOTICE packages/shared/
COPY packages/agent/LICENSE packages/agent/NOTICE packages/agent/THIRD_PARTY_NOTICES.md packages/agent/
COPY packages/agent/licenses packages/agent/licenses
RUN pnpm --filter brc-shared build && pnpm --filter brc-agent build
RUN pnpm --filter brc-agent --prod deploy --legacy /out

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production BRC_HOME=/home/rdp/.brc
RUN set -eu; \
    . /etc/os-release; test "$ID" = debian; test "$VERSION_CODENAME" = bookworm; \
    test -s /usr/share/keyrings/debian-archive-keyring.gpg; \
    rm -f /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; \
    printf '%s\n' \
      'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg check-valid-until=no] http://snapshot.debian.org/archive/debian/20261102T000000Z bookworm main' \
      'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261102T000000Z bookworm-security main' > /etc/apt/sources.list; \
    apt-get -o Acquire::Retries=5 -o Acquire::Check-Valid-Until=false -o APT::Update::Error-Mode=any update; \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates; \
    sed -i 's|http://snapshot.debian.org|https://snapshot.debian.org|g' /etc/apt/sources.list; \
    apt-get -o Acquire::Retries=5 -o Acquire::Check-Valid-Until=false -o APT::Update::Error-Mode=any update; \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y --no-install-recommends bash git curl procps python3; \
    git --version; python3 --version; \
    rm -rf /var/lib/apt/lists/*; \
    useradd -m -s /bin/bash rdp; mkdir -p /home/rdp/.brc; chown rdp:rdp /home/rdp/.brc
WORKDIR /app
COPY --from=build --chown=rdp:rdp /out .
USER rdp
VOLUME ["/home/rdp/.brc"]
ENTRYPOINT ["node", "dist/cli.js", "--no-browser"]
