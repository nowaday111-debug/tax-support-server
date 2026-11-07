# Máy chủ tài khoản & license — image nhỏ, chỉ cần Node + express
FROM node:20-bookworm-slim
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js cli.js ./
COPY lib ./lib
COPY public ./public
ENV LICENSE_DATA_DIR=/srv/data LICENSE_PORT=4000
RUN mkdir -p /srv/data
EXPOSE 4000
CMD ["node", "server.js"]
