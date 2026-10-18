FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm ci

COPY tsconfig.json .openrabbit.yaml ./
COPY src ./src
COPY public ./public

RUN npm run build

EXPOSE 3847

ENV NODE_ENV=production
ENV PORT=3847

CMD ["node", "dist/cli/index.js", "serve"]
