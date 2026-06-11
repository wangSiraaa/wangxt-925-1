FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p backend/data uploads

EXPOSE 3001

CMD ["node", "backend/server.js"]
