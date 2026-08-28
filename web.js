const doGetUrl = require("./main");
const { closeBrowser } = require("./xhsPlaywright");
const https = require("https");
const http = require("http");

var express = require("express");
const bodyParser = require('body-parser');
var app = express();

app.use(bodyParser.json());

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
app.get("/ig-proxy", function (req, res) {
  const url = req.query.url;
  if (!url || !url.includes("cdninstagram.com")) {
    res.status(400).send("missing or invalid url");
    return;
  }
  const client = url.startsWith("https") ? https : http;
  client.get(url, {
    headers: {
      "Referer": "https://www.instagram.com/",
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15",
    },
  }, (proxyRes) => {
    // 跟随重定向
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      client.get(proxyRes.headers.location, {
        headers: {
          "Referer": "https://www.instagram.com/",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15",
        },
      }, (redirectRes) => {
        res.set("Content-Type", redirectRes.headers["content-type"] || "image/jpeg");
        res.set("Cache-Control", "public, max-age=3600");
        redirectRes.pipe(res);
      }).on("error", () => res.status(502).send("redirect fetch failed"));
      return;
    }
    res.set("Content-Type", proxyRes.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=3600");
    proxyRes.pipe(res);
  }).on("error", (e) => {
    console.log(`ig-proxy error: ${e.message}`);
    res.status(502).send("proxy fetch failed");
  });
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
