FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
# RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ # Uncomment if you want to use Tencent's npm mirror
RUN npm install --production && npm install typescript && npx tsc -b && npm run copy-assets
EXPOSE 3000
CMD ["node", "dist/index.js"]
