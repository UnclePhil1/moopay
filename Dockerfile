FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && chmod +x docker-entrypoint.sh
ENV NODE_ENV=production
# starts as root only to fix the volume's owner, then runs the server as the unprivileged "node" user
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
