# XhsPicDownload

结合 iOS「快捷指令」，一键从小红书下载无水印图片 / 视频。

服务提供一个 HTTP 接口：传入小红书的分享文本或链接，返回该笔记中全部图片、Live Photo 视频、笔记视频的直链数组，由快捷指令批量保存到相册。

> Live Photo 会被拆分为「封面图片 + 一段视频」两个文件，可自行使用其他 App 合并。

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

小红书早期会把完整笔记数据直接内联在页面 HTML 的 `window.__INITIAL_STATE__` 中，因此只需请求页面源码即可解析出 `imageList`。目前该数据已不再稳定内联，纯 HTTP 抓取 HTML 的方式经常拿不到图片列表。

现在的实现方式是 **用 Playwright 驱动真实 Chromium 打开笔记页，拦截小红书前端自己发出的笔记详情 API 响应**：

```
请求 shareText
  └─ 解析短链接，得到完整笔记 URL（保留 xsec_token）
       └─ Playwright 打开笔记页（注入反检测脚本 + Cookie）
            ├─ 拦截详情 API 响应  ← 主路径
            │    /api/sns/web/v1/feed
            │    /api/sns/web/v1/note/
            │    /api/sns/h5/v1/note_info
            └─ 未拦截到则回退读取 window.__INITIAL_STATE__  ← 兜底
                 └─ 提取图片 / Live Photo / 视频直链
```

这样做的关键收益：小红书 API 需要 `X-s` / `X-t` / `X-s-common` 签名参数，**由真实浏览器自动生成，无需自行实现签名算法**。

提取到图片后，仍沿用原有做法：从 CDN 地址中取出图片 ID，拼接为 `https://ci.xiaohongshu.com/{id}?imageView2/2/w/0/format/png` 得到无水印原图。

### 相关文件

| 文件 | 职责 |
| --- | --- |
| [web.js](web.js) | Express 服务入口，暴露 `/getXhsPicUrl`，退出时关闭浏览器 |
| [main.js](main.js) | 解析短链接、从 note 数据中提取图片 / 视频直链 |
| [xhsPlaywright.js](xhsPlaywright.js) | 浏览器管理、API 响应拦截、note 数据定位 |

---

## 快速开始

### Docker（推荐）

镜像基于 `mcr.microsoft.com/playwright`，已内置 Chromium 及其全部系统依赖，无需额外安装。

```sh
# 构建镜像
docker build -t nfew/xhs_pic_download:latest .

# 启动容器
docker run -d \
  -p 7776:7776 \
  --shm-size=1g \
  --name xhs_pic_download \
  nfew/xhs_pic_download:latest
```

> **建议加上 `--shm-size=1g`。** Chromium 对共享内存较敏感，Docker 默认的 64MB `/dev/shm` 在渲染较大页面时可能导致浏览器异常退出。

验证是否启动成功：

```sh
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' -d ''
# 预期返回：{"error":"缺少shareText参数"}
```

---

## 接口说明

### `POST /getXhsPicUrl`

请求体必须是 **JSON**（`Content-Type: application/json`）。

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `shareText` | JSON body 或 URL query | 是 | 小红书分享文本或链接，会自动用正则提取其中的 URL |
| `xhsCookie` | **仅 JSON body** | 否（强烈建议传） | 小红书网页版 Cookie 字符串 |

`shareText` 可直接传入小红书 App「复制链接」得到的整段文本（含中文描述），服务会自行提取链接部分。

> **注意两个限制：**
> - `xhsCookie` 只从 JSON body 读取，因此**传 Cookie 必须用 POST + JSON**，无法通过 URL query 传递。
> - 服务只挂载了 JSON body 解析，**不支持 form-encoded**（`-d "shareText=..."` 会被判定为缺少参数）。

#### 成功响应

```json
{
  "picUrlArray": [
    "https://ci.xiaohongshu.com/1040g00831abcdefg?imageView2/2/w/0/format/png",
    "https://ci.xiaohongshu.com/1040g00831hijklmn?imageView2/2/w/0/format/png",
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
# 推荐：POST + JSON，带 Cookie
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{
        "shareText": "99 看看这个笔记 https://xhslink.cn/a/xxxxxx 复制本条信息...",
        "xhsCookie": "a1=xxxxx; web_session=xxxxx"
      }'

# 不带 Cookie（大概率被小红书拦截，仅用于连通性测试）
curl -X POST http://127.0.0.1:7776/getXhsPicUrl \
  -H 'Content-Type: application/json' \
  -d '{"shareText": "https://www.xiaohongshu.com/explore/xxx?xsec_token=yyy"}'
```

---

## Cookie 配置（重要）

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
docker run -d -p 7776:7776 --shm-size=1g \
  -e XHS_NAV_TIMEOUT=45000 \
  --name xhs_pic_download nfew/xhs_pic_download:latest
```

---

## iPhone 快捷指令配置

1. **部署服务**：按上文用 Docker 部署，确保接口可从手机所在网络访问。

2. **添加快捷指令**：在 iPhone 浏览器中打开
   <https://www.icloud.com/shortcuts/fef496ed540e42949e8154ddbf6ac8f9>
   点击「获取捷径」，再点「添加快捷指令」。

3. **填入服务地址**：点击刚添加的快捷指令右上角「···」进入编辑页，将部署地址填入「文本」区域，点右上角「完成」。

   > 格式形如 `http://1.2.3.4:7776/getXhsPicUrl`

4. **使用**：在小红书 App 打开笔记 → 右上角分享箭头 → 「复制链接」→ 打开「快捷指令」App → 点击「一键保存小红书图片/视频」（会自动读取剪贴板）。

> 若快捷指令未提供 Cookie 输入位置，可在其发送请求的步骤中，为 JSON 请求体额外增加一个 `xhsCookie` 字段。

---

## 常见错误排查

| 错误信息 | 原因与处理 |
| --- | --- |
| `缺少shareText参数` | 未传 `shareText`；或用了 form-encoded 而非 JSON，请加 `-H 'Content-Type: application/json'` |
| `无法打开笔记页（账号异常…error_code=300011）` | 未传或 Cookie 已失效，请重新获取 `xhsCookie` |
| `无法打开笔记页（未登录或链接已失效）` | 同上；同时确认链接完整保留了 `xsec_token` |
| `被小红书安全验证拦截，请更新 xhsCookie 后重试` | 触发验证码。更换 Cookie / 网络环境，或本地设 `XHS_HEADLESS=false` 手动过验证 |
| `未能获取笔记数据，可能是 Cookie 失效 / 笔记已删除 / 链接缺少 xsec_token` | 页面已打开但取不到数据，多为笔记被删除或权限受限 |
| `不包含图片` | 笔记确实无图无视频（纯文本笔记） |
| `未能从分享文本中提取链接` | `shareText` 中不含 `http(s)://` 链接 |
| `解析分享链接失败: …` | 短链接展开失败，通常是服务器网络不通或短链已失效 |
| 浏览器启动异常 / 容器内崩溃 | 加大共享内存：`--shm-size=1g` |

查看容器日志定位问题：

```sh
docker logs -f xhs_pic_download
```

---

## 本地开发

需要 Node.js 与可运行的 Chromium。

```sh
# 安装依赖
npm install

# 首次需下载 Chromium（Docker 镜像已内置，无需执行）
npx playwright install chromium

# 启动服务（监听 7776）
node web.js
```

服务会复用同一个 Chromium 进程以降低单次请求开销，每个请求使用独立的浏览器 context 以隔离 Cookie；收到 `SIGINT` / `SIGTERM` 时会关闭浏览器，避免残留进程。

> `playwright` 固定为具体版本（非版本范围），需与 [Dockerfile](Dockerfile) 中的镜像 tag 保持一致。升级时请同步修改 [package.json](package.json) 和 [Dockerfile](Dockerfile) 两处。

---

## 声明

- 本仓库发布的 `xhs_pic_download` 项目中涉及的任何脚本，仅用于测试和学习研究，禁止用于商业用途
- `nfe-w` 对任何脚本问题概不负责，包括但不限于由任何脚本错误导致的任何损失或损害
- 以任何方式查看此项目的人或直接或间接使用 `xhs_pic_download` 项目的任何脚本的使用者都应仔细阅读此声明
- `xhs_pic_download` 保留随时更改或补充此免责声明的权利。一旦使用并复制了任何相关脚本或 `xhs_pic_download` 项目，则视为已接受此免责声明
- 本项目遵循 `MIT LICENSE` 协议，如果本声明与 `MIT LICENSE` 协议有冲突之处，以本声明为准
