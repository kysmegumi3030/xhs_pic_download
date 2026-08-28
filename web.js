const doGetUrl = require("./main");
const { closeBrowser } = require("./xhsPlaywright");
const axios = require("axios");

var express = require("express");
const bodyParser = require('body-parser');
var app = express();

app.use(bodyParser.json());

// 代理支持：从环境变量读取
function getProxyConfig() {
  const proxyUrl = process.env.IG_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (!proxyUrl) return {};
  try {
    const u = new URL(proxyUrl);
    return {
      proxy: { protocol: u.protocol, host: u.hostname, port: parseInt(u.port, 10) }
    };
  } catch (e) {
    return {};
  }
}
const PROXY_CONFIG = getProxyConfig();

app.all("/getXhsPicUrl", async function (req, res) {
  res.set("Content-Type", "application/json");
  const shareText = req.query.shareText || req.body.shareText;
  const xhsCookie = req.body.xhsCookie;
  const igCookie = req.body.igCookie;
  // 从 Host 头构建服务器基础地址，供 Instagram 代理链接使用
  const host = req.headers.host || '127.0.0.1:7776';
  const serverUrl = `http://${host}`;
  if (!shareText) {
    res.send(JSON.stringify({
      error: "缺少shareText参数",
    }));
    return;
  }
  try {
    const result = await doGetUrl(
      {
        shareText: shareText,
        xhsCookie: xhsCookie,
        igCookie: igCookie,
        serverUrl: serverUrl,
      },
      null
    );
    res.send(JSON.stringify(result));
  } catch (e) {
    console.log(e);
    res.send(JSON.stringify({
      error: e.message,
    }));
  }
});

// Instagram 图片代理：快捷指令无法为 Instagram CDN 设置正确的 Referer，
// 所以由服务端代理下载，带上 Referer: https://www.instagram.com/
// 如果配置了代理（IG_PROXY），也会通过代理访问 Instagram CDN。
app.get("/ig-proxy", async function (req, res) {
  const url = req.query.url;
  if (!url || !url.includes("cdninstagram.com")) {
    res.status(400).send("missing or invalid url");
    return;
  }
  try {
    const response = await axios.get(url, {
      headers: {
        "Referer": "https://www.instagram.com/",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15",
      },
      responseType: "stream",
      timeout: 30000,
      maxRedirects: 5,
      ...PROXY_CONFIG,
    });
    res.set("Content-Type", response.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    response.data.pipe(res);
  } catch (e) {
    console.log(`ig-proxy error: ${e.message}`);
    res.status(502).send("proxy fetch failed");
  }
});

const server = app.listen(7776);

// 退出时关闭共享的 Chromium，避免残留进程
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
