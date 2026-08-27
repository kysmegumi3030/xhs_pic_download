# 使用官方 Playwright 镜像：已内置 Chromium 及其系统依赖
# 镜像版本需与 package.json 中的 playwright 版本保持一致
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json* /app/

RUN npm install --omit=dev && \
    npm cache clean --force

# Instagram 图片提取依赖（instaloader 使用 Python GraphQL API）
COPY requirements.txt /app/
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . /app/

EXPOSE 7776

USER pwuser

CMD ["node", "web.js"]
