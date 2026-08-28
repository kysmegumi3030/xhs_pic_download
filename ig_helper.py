#!/usr/bin/env python3
"""
Instagram 图片直链提取脚本

通过 instaloader 库访问 Instagram GraphQL API，提取贴文中的图片直链。
不下载文件到磁盘——仅返回 CDN URL，由调用方（Node.js 服务 → iOS 快捷指令）负责下载。

stdin  JSON: {"shareText": "...", "igCookie": "..."}
stdout JSON: {"picUrlArray": ["https://..."]}  或  {"error": "..."}
"""

import json
import re
import sys

try:
    import instaloader
    from instaloader import (
        Instaloader,
        Post,
        LoginRequiredException,
        QueryReturnedNotFoundException,
        TooManyRequestsException,
        ConnectionException,
    )
except ImportError:
    print(json.dumps({"error": "缺少 instaloader 依赖，请执行: pip3 install instaloader"}))
    sys.exit(1)

SHORTCODE_RE = re.compile(r"instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)")
URL_RE = re.compile(r"https?://[^\s，<>]+instagram\.com[^\s，<>]*")


def extract_shortcode(text):
    """从分享文本或 URL 中提取 Instagram shortcode。"""
    urls = URL_RE.findall(text)
    for url in urls:
        m = SHORTCODE_RE.search(url)
        if m:
            return m.group(1)
    # 直接对整段文本做匹配（兜底）
    m = SHORTCODE_RE.search(text)
    if m:
        return m.group(1)
    return None


def build_loader(ig_cookie=None):
    """构造 Instaloader 实例。如有 cookie 则设置到 context 上。"""
    loader = Instaloader(
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        post_metadata_txt_pattern="",
        compress_json=False,
        dirname_pattern="/tmp",
        filename_pattern="{shortcode}",
        quiet=True,
        title_pattern="",
    )
    if ig_cookie:
        for part in ig_cookie.split(";"):
            part = part.strip()
            if "=" in part:
                name, value = part.split("=", 1)
                loader.context._session.cookies.set(
                    name.strip(), value.strip(), domain=".instagram.com"
                )
    return loader


def extract_urls(loader, shortcode):
    """从 Instagram 贴文提取图片直链。返回 URL 列表。"""
    post = Post.from_shortcode(loader.context, shortcode)
    urls = []

    if post.typename == "GraphImage":
        urls.append(post.url)

    elif post.typename == "GraphSidecar":
        for node in post.get_sidecar_nodes():
            if not node.is_video:
                urls.append(node.display_url)

    elif post.typename == "GraphVideo":
        # 视频帖：instaloader 不暴露视频 CDN URL，无法返回直链
        # 视频帖暂不支持
        raise ValueError("该贴文为视频，暂不支持下载")

    return urls


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
    except Exception:
        print(json.dumps({"error": "请求 JSON 解析失败"}))
        sys.exit(1)

    share_text = req.get("shareText", "")
    ig_cookie = req.get("igCookie", "")
    proxy_base = req.get("proxyBaseUrl", "")

    shortcode = extract_shortcode(share_text)
    if not shortcode:
        print(json.dumps({"error": "未能从分享文本中提取 Instagram 贴文链接"}))
        sys.exit(0)

    loader = build_loader(ig_cookie or None)
    try:
        urls = extract_urls(loader, shortcode)
        if urls:
            # Instagram CDN 校验 Referer，iOS 快捷指令无法设置正确的 Referer，
            # 所以通过服务端代理下载。将直链转为 /ig-proxy?url=... 代理链接。
            if proxy_base:
                from urllib.parse import quote
                urls = [f"{proxy_base}/ig-proxy?url={quote(u, safe='')}" for u in urls]
            print(json.dumps({"picUrlArray": urls}))
        else:
            print(json.dumps({"error": "该贴文不包含可提取的图片"}))
    except LoginRequiredException:
        print(json.dumps({
            "error": "该贴文需要登录才能访问，请设置 IG_COOKIE 环境变量或在请求中传入 igCookie",
            "needLogin": True,
        }))
    except QueryReturnedNotFoundException:
        print(json.dumps({"error": "贴文不存在或链接无效"}))
    except TooManyRequestsException:
        print(json.dumps({"error": "请求过于频繁，请稍后重试"}))
    except ConnectionException as e:
        print(json.dumps({"error": f"网络错误: {e}"}))
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
    except Exception as e:
        print(json.dumps({"error": f"Instagram 处理异常: {type(e).__name__}: {e}"}))


if __name__ == "__main__":
    main()
