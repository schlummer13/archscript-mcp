# Runs the ArchScript MCP bridge (stdio). Without ArchScript for Mac on the same
# machine it answers introspection (initialize, tools/list) and explains how to
# connect the app on tool calls.
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/index.js server/tools.json ./
USER node
ENTRYPOINT ["node", "index.js"]
