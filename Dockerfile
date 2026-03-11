# Workspace runtime for CloseHack AI Studio
# Clones a GitHub repo, installs dependencies, and runs:
#   - Next.js dev server on port 3001 (internal)
#   - Workspace API on port 3000 (public, proxies to dev server)

FROM node:20-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY workspace-api.mjs /workspace-api.mjs
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
