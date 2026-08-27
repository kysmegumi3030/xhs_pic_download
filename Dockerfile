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
# 基础镜像 mcr.microsoft.com/playwright:*-jammy 仅含 python3 解释器，不含 pip3，需先安装
COPY requirements.txt /app/
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3-pip && \
    rm -rf /var/lib/apt/lists/* && \
    pip3 install --no-cache-dir -r requirements.txt

COPY . /app/

EXPOSE 7776

USER pwuser

CMD ["node", "web.js"]
