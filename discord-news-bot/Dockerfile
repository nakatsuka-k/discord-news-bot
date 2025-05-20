# Nodeベースイメージ
FROM node:20

WORKDIR /app

# パッケージをコピー
COPY package.json yarn.lock ./
RUN yarn install

# 全コードをコピー
COPY . .

# TypeScript → JavaScript（必要なら）
RUN yarn build

# 本番起動
CMD ["node", "dist/index.js"]
