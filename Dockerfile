# Workspace runtime for CloseHack AI Studio
# Clones a GitHub repo, installs dependencies, and runs the dev server.
#
# Build: docker build -t closehack-workspace .
# Push:  fly deploy --image closehack-workspace (from the workspace-runtime app)

FROM node:20-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
