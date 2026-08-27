const doGetUrl = require("./main");
const { closeBrowser } = require("./xhsPlaywright");

var express = require("express");
const bodyParser = require('body-parser');
var app = express();

app.use(bodyParser.json());

app.all("/getXhsPicUrl", async function (req, res) {
  res.set("Content-Type", "application/json");
  const shareText = req.query.shareText || req.body.shareText;
  const xhsCookie = req.body.xhsCookie;
  const igCookie = req.body.igCookie;
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

const server = app.listen(7776);

// 退出时关闭共享的 Chromium，避免残留进程
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  });
}
