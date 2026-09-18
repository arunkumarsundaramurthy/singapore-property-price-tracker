FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
ENTRYPOINT ["node", "--import", "tsx", "src/cli.ts"]
CMD ["status"]
