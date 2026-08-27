# XhsPicDownload

结合 iOS「快捷指令」，一键从小红书 / Instagram 下载无水印图片。

服务提供一个 HTTP 接口：传入分享文本或链接，自动判断来源平台（小红书 / Instagram），返回该贴文中全部图片的直链数组，由快捷指令批量保存到相册。

> 小红书的 Live Photo 会被拆分为「封面图片 + 一段视频」两个文件，可自行使用其他 App 合并。

---

## 目录

- [工作原理](#工作原理)
- [快速开始](#快速开始)
- [接口说明](#接口说明)
- [Cookie 配置（重要）](#cookie-配置重要)
- [环境变量](#环境变量)
- [iPhone 快捷指令配置](#iphone-快捷指令配置)
- [常见错误排查](#常见错误排查)
- [本地开发](#本地开发)
- [声明](#声明)

---

## 工作原理

小红书早期会把完整笔记数据直接内联在页面 HTML 的 `window.__INITIAL_STATE__` 中，因此只需请求页面源码即可解析出 `imageList`。但纯 HTTP 抓取时小红书会拦截未登录/无签名的请求，经常拿不到图片列表。Instagram 则通过 GraphQL API 提供数据，需要登录态或匿名会话。

服务会根据链接域名自动判断来源平台，选择对应的技术方案：

```
剪贴板 shareText
  └─ POST /getXhsPicUrl { shareText, xhsCookie?, igCookie? }
       └─ Node.js 自动检测 URL 域名
            ├─ xiaohongshu.com / xhslink.cn → Playwright 浏览器方案
            │    ├─ 解析短链接，得到完整笔记 URL（保留 xsec_token）
            │    ├─ Playwright 打开笔记页（注入反检测脚本 + Cookie）
            │    │    ├─ 拦截详情 API 响应（数据更完整，优先采用）
            │    │    └─ 轮询页面内的 window.__INITIAL_STATE__
            │    └─ 从 note.fileId 拼接无水印原图
            │
            ├─ instagram.com / instagr.am → instaloader GraphQL 方案
            │    ├─ 提取贴文 shortcode（/p/ABC, /reel/ABC）
            │    ├─ 通过 GraphQL API 获取帖子元数据
            │    └─ 提取图片 CDN 直链（scontent-*.cdninstagram.com）
            │
            └─ 其他域名 → 返回错误
       └─ 返回统一格式 { picUrlArray: [...] }
            └─ 快捷指令循环下载（GET + Referer 头）→ 保存到相册
```

### 小红书：Playwright 浏览器方案

关键收益：小红书 API 需要 `X-s` / `X-t` / `X-s-common` 签名参数，**由真实浏览器自动生成，无需自行实现签名算法**；页面内的 `__INITIAL_STATE__` 也只有在浏览器真正通过风控后才会填充。

> **实测（2026-08-24）：多数笔记页的数据是直接 SSR 进 `__INITIAL_STATE__` 的，并不会发出详情 API。** 因此两条路径设计为竞速而非「主路径 + 兜底」——若死等 API 超时（`XHS_API_WAIT_TIMEOUT`，默认 15s），每个请求都会白等满。竞速后单次请求约 1s。

提取到图片后，从 note 数据的 `fileId` 字段拼接无水印原图：`https://ci.xiaohongshu.com/{fileId}?imageView2/2/w/0/format/png`。

> `fileId` 形如 `oss-sg/notes/1040g3l03248c7jhe2o…`，**带 bucket 前缀**，并不等于 CDN 地址 path 的最后一段。若只取最后一段（如 `1040g3l…`）拼接，`ci.xiaohongshu.com` 会返回 404。直接用 `urlDefault` 虽然能下载，但拿到的是压缩过的 webp（几百 KB），而非原图（数 MB）。

### Instagram：instaloader GraphQL 方案

Instagram 的 GraphQL API 可通过 `instaloader` Python 库访问。公开帖文支持匿名访问，私密帖文需要登录态（通过 `igCookie` 参数传入）。

支持的贴文类型：
- 单图（`GraphImage`）→ 直接返回图片 CDN URL
- 轮播（`GraphSidecar`）→ 遍历所有 sidecar 节点，返回每张图片 URL
- 视频（`GraphVideo`）→ 暂不支持（instaloader 不暴露视频 CDN URL）

### 相关文件

| 文件 | 职责 |
| --- | --- |
| [web.js](web.js) | Express 服务入口，暴露 `/getXhsPicUrl`，退出时关闭浏览器 |
| [main.js](main.js) | 平台检测、短链接解析、分发到对应处理器 |
| [xhsPlaywright.js](xhsPlaywright.js) | 浏览器管理、API 响应拦截、note 数据定位（小红书） |
| [ig_helper.py](ig_helper.py) | Instagram 图片直链提取（通过 instaloader GraphQL API） |

---

## 快速开始

### Docker（推荐）

镜像基于 `mcr.microsoft.com/playwright`，已内置 Chromium 及其全部系统依赖，无需额外安装。镜像已发布到 Docker Hub，直接拉取即可：

```sh
# 拉取镜像
docker pull kys00/xhs_dwd:latest

# 启动容器
docker run -d \
  -p 7776:7776 \
  --shm-size=2g \
  --name xhs_dwd \
  kys00/xhs_dwd:latest
```

如需自行构建（例如修改源码后）：

```sh
docker build -t kys00/xhs_dwd:latest .
```

> **必须加 `--shm-size=2g`。** Chromium 对共享内存敏感，Docker 默认的 64MB `/dev/shm` 在渲染较大页面时可能导致浏览器异常退出。启动参数中虽已加 `--disable-dev-shm-usage` 让 Chromium 走 `/tmp`，但增大 shm 仍是更稳妥的实践。

验证是否启动成功：

```sh
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' -d ''
# 预期返回：{"error":"缺少shareText参数"}
```

---

## 接口说明

### `POST /getXhsPicUrl`

请求体必须是 **JSON**（`Content-Type: application/json`）。服务会根据链接域名自动判断平台（小红书 / Instagram）。

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `shareText` | JSON body 或 URL query | 是 | 分享文本或链接（小红书 / Instagram），会自动识别平台 |
| `xhsCookie` | **仅 JSON body** | 否（小红书强烈建议） | 小红书网页版 Cookie 字符串 |
| `igCookie` | **仅 JSON body** | 否 | Instagram Cookie 字符串（公开帖文不需要） |

`shareText` 可直接传入 App「复制链接」得到的整段文本（含中文描述），服务会自行提取链接部分。

> **注意：**
> - `xhsCookie` / `igCookie` 只从 JSON body 读取，因此**必须用 POST + JSON**。
> - 服务只挂载了 JSON body 解析，**不支持 form-encoded**（`-d "shareText=..."` 会被判定为缺少参数）。

#### 成功响应

```json
{
  "picUrlArray": [
    "https://ci.xiaohongshu.com/oss-sg/notes/1040g3l03248c7jhe2o?imageView2/2/w/0/format/png",
    "https://ci.xiaohongshu.com/notes_uhdr/1040g3qg3248cbp6jns10?imageView2/2/w/0/format/png",
    "https://sns-video-bd.xhscdn.com/....mp4"
  ]
}
```

数组顺序为：全部图片 → Live Photo 视频（若有）→ 笔记视频（若有）。

#### 失败响应

```json
{ "error": "错误描述" }
```

> 接口在失败时同样返回 HTTP 200，请通过判断响应中是否存在 `error` 字段来识别失败。

#### 调用示例

```sh
# 小红书：POST + JSON，带 Cookie
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{
        "shareText": "99 看看这个笔记 https://xhslink.cn/a/xxxxxx 复制本条信息...",
        "xhsCookie": "a1=xxxxx; web_session=xxxxx"
      }'

# Instagram：公开帖文不需要 Cookie
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{"shareText": "https://www.instagram.com/p/ABC123/"}'

# Instagram：私密帖文需带 Cookie
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{
        "shareText": "https://www.instagram.com/p/ABC123/",
        "igCookie": "sessionid=xxx; ds_user_id=yyy; csrftoken=zzz"
      }'

# 小红书不带 Cookie（大概率被拦截，仅用于连通性测试）
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{"shareText": "https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy"}'
```

---

## Cookie 配置

### 小红书（重要）

小红书对未登录访问限制较严，**不传 Cookie 时笔记页通常会被重定向到登录页**，接口会返回类似：

```
无法打开笔记页（账号异常，请稍后重试（error_code=300011）），请在请求中传入有效的 xhsCookie，并确保链接包含 xsec_token
```

因此实际使用时请务必配置 `xhsCookie`。

### 获取 Cookie

1. 电脑浏览器登录 <https://www.xiaohongshu.com>
2. 打开开发者工具（F12）→ Network 面板
3. 刷新页面，点击任意一个 `xiaohongshu.com` 的请求
4. 在 Request Headers 中复制 `cookie` 字段的完整值

最关键的字段是 `a1` 和 `web_session`，最简形式：

```
a1=19ff4898b5xxxxxxxxxxxx; web_session=0400698dcexxxxxxxxxxxx
```

### 两个注意事项

- **保留链接中的 `xsec_token`。** 小红书分享链接携带的 `xsec_token` 是访问凭证，缺失或过期都会导致访问失败，请不要手动截断 `?` 之后的部分。
- **Cookie 会过期。** 若原本正常的服务突然开始报「账号异常」或「未登录」，通常是 Cookie 失效，重新获取即可。

> Cookie 等同于账号登录凭证，请勿提交到公开仓库或分享给他人。

### Instagram（可选）

Instagram 公开帖文支持匿名访问，**不需要 Cookie**。只有私密帖文需要登录态。

如需访问私密帖文，在请求中传入 `igCookie` 字段：

```
igCookie: "sessionid=xxx; ds_user_id=yyy; csrftoken=zzz"
```

获取方式：电脑浏览器登录 <https://www.instagram.com> → F12 → Network → 复制任意 `instagram.com` 请求的 Cookie 头。

> Instagram Cookie 通常比小红书更持久，但频繁请求可能触发限流。

---

## 环境变量

均为可选，用于调整浏览器行为：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `XHS_HEADLESS` | `true` | 设为 `false` 显示浏览器窗口，便于本地排查验证码 / 登录问题 |
| `XHS_NAV_TIMEOUT` | `30000` | 页面导航超时（毫秒）。网络较慢可增大 |
| `XHS_API_WAIT_TIMEOUT` | `15000` | 等待详情 API 响应的最长时间（毫秒） |
| `XHS_API_SETTLE_MS` | `800` | 拦截到首个 API 后的额外等待（毫秒），用于等同批请求落地 |

```sh
docker run -d -p 7776:7776 --shm-size=2g \
  -e XHS_NAV_TIMEOUT=45000 \
  --name xhs_dwd kys00/xhs_dwd:latest
```

---

## iPhone 快捷指令配置

> ⚠️ 原作者 [nfe-w](https://github.com/nfe-w) 提供的 iCloud 快捷指令 <https://www.icloud.com/shortcuts/fef496ed540e42949e8154ddbf6ac8f9> 在本仓库移植后**不再适用**——它不传 `xhsCookie` 且很可能用 GET 请求，而移植后的服务必须 POST + JSON + Cookie 才能成功。

### 1. 先用 curl 验证服务端跑通

替换 `YOUR_SERVER_IP` 和 Cookie 后执行：

```sh
# 小红书
curl -X POST http://YOUR_SERVER_IP:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{"shareText": "https://xhslink.cn/a/xxxxxx", "xhsCookie": "a1=...; web_session=..."}'

# Instagram（公开帖文不需要 Cookie）
curl -X POST http://YOUR_SERVER_IP:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{"shareText": "https://www.instagram.com/p/ABC123/"}'
```

预期返回 `{"picUrlArray": [...]}`。curl 跑通后再去配快捷指令，能省去端到端排查时间。

### 2. 直接导入 .shortcut 文件

仓库根目录的 [小红书&Ins图片下载.shortcut](小红书&Ins图片下载.shortcut) 是已生成好的可导入快捷指令文件，由 [build_shortcut.py](build_shortcut.py) 依据 [shortcut.json](shortcut.json) 的结构化描述自动生成。导入后只需填入服务地址和 Cookie 即可使用，**不再需要 14 步手动重建**。

**导入方式（任选其一）**：

| 方式 | 操作 |
| --- | --- |
| **AirDrop** | Mac 下载本仓库中的 [小红书&Ins图片下载.shortcut](小红书&Ins图片下载.shortcut) → AirDrop 发送给 iPhone → 在弹窗中点「添加快捷指令」 |
| **iCloud Drive** | 把文件放到 iCloud Drive → 在 iPhone 的「文件」App 中点击该文件 → 「添加快捷指令」 |
| **Git clone + 拷贝** | `git clone` 后通过任意方式（邮件/网盘/U盘）将文件传到 iPhone 文件系统，再用「文件」App 打开 |

导入后点击快捷指令右上角「···」进入编辑页，需要填入两处：

1. **服务地址文本**：把 `http://YOUR_SERVER_IP:7776/getXhsPicUrl` 改成实际部署地址
2. **Cookie 文本**：把 `a1=...; web_session=...` 占位符替换为你的真实 Cookie

如需重新生成 `.shortcut` 文件（修改了 `build_shortcut.py` 或 `shortcut.json` 后）：

```sh
python3 build_shortcut.py /tmp/xhs_download.plist
cp /tmp/xhs_download.plist /tmp/xhs_download.shortcut
/usr/bin/shortcuts sign --mode anyone -i /tmp/xhs_download.shortcut -o 小红书\&Ins图片下载.shortcut
```

> **注意：** `shortcuts sign` 要求输入文件扩展名为 `.shortcut`（即使内容是 raw plist），否则会报"文件格式不正确"。

### 3. 关键配置点（仅供修改快捷指令时参考）

[build_shortcut.py](build_shortcut.py) 生成的快捷指令已默认按以下规则配置，正常使用无需关心。仅当你在「快捷指令」App 里手动调整或重新生成 [shortcut.json](shortcut.json) 后才需要对照：

| 配置项 | 值 | 原因 |
| --- | --- | --- |
| HTTP 方法 | **POST** | [web.js:13](web.js) 只从 body 读 `xhsCookie`，GET 没有 body |
| Header | `Content-Type: application/json` | 服务只挂了 `bodyParser.json()`（[web.js:8](web.js)），不支持 form-encoded |
| 请求体 | `{"shareText": "<剪贴板>", "xhsCookie": "<你的Cookie>"}` | Cookie 必传，否则 Playwright 打开页面会被重定向到登录页 |
| 下载图片的 Header | `Referer: https://www.xiaohongshu.com/` | 小红书 CDN 防盗链，缺失会 403 |

> Cookie 会过期（通常 1–4 周），失效后服务端返回 `error_code=300011`，重新获取并替换快捷指令里的 `xhsCookie` 文本即可。

### 4. 重新生成 .shortcut 文件（开发者）

若修改了 [shortcut.json](shortcut.json) 的步骤结构、变量名或默认值，需要用 [build_shortcut.py](build_shortcut.py) 重新生成产物：

```sh
python3 build_shortcut.py   # 读取 shortcut.json，覆盖输出 小红书&Ins图片下载.shortcut
```

依赖仅标准库（`plistlib` + `uuid`），无需额外安装。

### 5. 使用

1. 小红书 App 打开笔记 → 右上角分享箭头 → 「复制链接」（带短链的分享文本会被复制到剪贴板）
2. 打开「快捷指令」App → 点击「小红书图片下载」
3. 等待循环下载完成，相册中可见全部图片/视频

> 首次请求因 Chromium 冷启动可能耗时 5–10s，热请求 2–5s，属正常现象。视频文件较大时单次下载也可能耗时数秒。

---

## 常见错误排查

| 错误信息 | 原因与处理 |
| --- | --- |
| `缺少shareText参数` | 未传 `shareText`；或用了 form-encoded 而非 JSON，请加 `-H 'Content-Type: application/json'` |
| `不支持的链接类型` | 链接既不是小红书也不是 Instagram，请检查分享文本中是否包含有效 URL |
| `未能从分享文本中提取链接` | `shareText` 中不含 `http(s)://` 链接 |
| **小红书错误** | |
| `无法打开笔记页（账号异常…error_code=300011）` | 未传或 Cookie 已失效，请重新获取 `xhsCookie` |
| `无法打开笔记页（未登录或链接已失效）` | 同上；同时确认链接完整保留了 `xsec_token` |
| `被小红书安全验证拦截，请更新 xhsCookie 后重试` | 触发验证码。更换 Cookie / 网络环境，或本地设 `XHS_HEADLESS=false` 手动过验证 |
| `未能获取笔记数据，可能是 Cookie 失效 / 笔记已删除 / 链接缺少 xsec_token` | 页面已打开但取不到数据，多为笔记被删除或权限受限 |
| `不包含图片` | 笔记确实无图无视频（纯文本笔记） |
| `解析分享链接失败: …` | 短链接展开失败，通常是服务器网络不通或短链已失效 |
| **Instagram 错误** | |
| `该贴文需要登录才能访问` | 私密帖文，请在请求中传入 `igCookie` |
| `贴文不存在或链接无效` | 链接中的 shortcode 无效，或帖文已被删除 |
| `该贴文为视频，暂不支持` | Instagram 视频帖（Reel）暂不支持，instaloader 无法暴露视频 CDN URL |
| `请求过于频繁` | Instagram 限流，稍后重试 |
| `Instagram 处理异常` | 网络问题或 instaloader 内部错误，查看容器日志 |
| **通用错误** | |
| 浏览器启动异常 / 容器内崩溃 | 加大共享内存：`--shm-size=2g`（仅影响小红书） |

查看容器日志定位问题：

```sh
docker logs -f xhs_dwd
```

---

## 本地开发

需要 Node.js、可运行的 Chromium，以及 Python 3（Instagram 功能）。

```sh
# 安装 Node.js 依赖
npm install

# 安装 Python 依赖（Instagram 图片提取）
pip3 install -r requirements.txt

# 首次需下载 Chromium（Docker 镜像已内置，无需执行）
npx playwright install chromium

# 启动服务（监听 7776）
node web.js
```

服务会复用同一个 Chromium 进程以降低单次请求开销，每个请求使用独立的浏览器 context 以隔离 Cookie；收到 `SIGINT` / `SIGTERM` 时会关闭浏览器，避免残留进程。

> `playwright` 固定为具体版本（非版本范围），需与 [Dockerfile](Dockerfile) 中的镜像 tag 保持一致。升级时请同步修改 [package.json](package.json) 和 [Dockerfile](Dockerfile) 两处。

---

## 声明

本仓库是 [nfe-w/xhs_pic_download](https://github.com/nfe-w/xhs_pic_download) 的 fork，主要改动是将数据获取方式从「纯 HTTP + 解析 `window.__INITIAL_STATE__`」改为「Playwright 驱动真实 Chromium + 拦截笔记详情 API」，以解决小红书不再稳定内联 SSR 数据导致拿不到图片的问题。原仓库的声明继续适用：

- 本仓库发布的 `xhs_pic_download` 项目中涉及的任何脚本，仅用于测试和学习研究，禁止用于商业用途
- `nfe-w` 对任何脚本问题概不负责，包括但不限于由任何脚本错误导致的任何损失或损害
- 以任何方式查看此项目的人或直接或间接使用 `xhs_pic_download` 项目的任何脚本的使用者都应仔细阅读此声明
- `xhs_pic_download` 保留随时更改或补充此免责声明的权利。一旦使用并复制了任何相关脚本或 `xhs_pic_download` 项目，则视为已接受此免责声明
- 本项目遵循 `MIT LICENSE` 协议，如果本声明与 `MIT LICENSE` 协议有冲突之处，以本声明为准
