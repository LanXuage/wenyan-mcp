# 使用多阶段构建，减小最终镜像体积
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
# RUN npm config set registry https://mirrors.cloud.tencent.com/npm/ # Uncomment if you want to use Tencent's npm mirror
RUN npm install --production=false && npm install typescript && npx tsc -b && npm run copy-assets

# 生产环境镜像
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000
CMD ["node", "dist/index.js"]
