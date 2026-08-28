const axios = require('axios')
const { spawn } = require('child_process')
const path = require('path')
const { fetchNoteViaPlaywright } = require('./xhsPlaywright')

// 代理支持：从环境变量读取，Docker 中通过 IG_PROXY / HTTP_PROXY / HTTPS_PROXY 设置
function getProxyConfig() {
  const proxyUrl = process.env.IG_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY
  if (!proxyUrl) return {}
  try {
    const u = new URL(proxyUrl)
    return {
      proxy: {
        protocol: u.protocol,
        host: u.hostname,
        port: parseInt(u.port, 10),
      }
    }
  } catch (e) {
    console.log(`proxy URL parse failed: ${e.message}`)
    return {}
  }
}
const PROXY_CONFIG = getProxyConfig()
if (PROXY_CONFIG.proxy) {
  console.log(`using proxy: ${process.env.IG_PROXY || process.env.HTTP_PROXY}`)
}

// Instagram URL 检测
const IG_URL_RE = /instagram\.com\/(?:p|reel|reels|tv)\//
const IG_DOMAIN_RE = /(?:instagram\.com|instagr\.am)/
const URL_EXTRACT_RE = /(https?:\/\/[^\s，<>]+)/

// XHS URL 检测
const XHS_DOMAIN_RE = /(?:xiaohongshu\.com|xhslink\.cn)/

/**
 * 从分享文本中提取 URL 并判断平台。
 * 返回 'instagram' | 'xiaohongshu' | null
 */
function detectPlatform(shareText) {
  const urlMatch = shareText.match(URL_EXTRACT_RE)
  const url = urlMatch ? urlMatch[0] : shareText

  if (IG_URL_RE.test(url) || (IG_DOMAIN_RE.test(url) && !XHS_DOMAIN_RE.test(url))) {
    return 'instagram'
  }
  if (XHS_DOMAIN_RE.test(url)) {
    return 'xiaohongshu'
  }
  // 无法识别域名时返回 null
  return null
}

/**
 * 调用 ig_helper.py 提取 Instagram 图片直链。
 * stdin 写入 JSON，stdout 读取 JSON 结果。
 */
async function getIgPicUrl(shareText, igCookie, serverUrl) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'ig_helper.py')
    const child = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const input = JSON.stringify({
      shareText,
      igCookie: igCookie || '',
      proxyBaseUrl: serverUrl || '',
    })
    child.stdin.write(input)
    child.stdin.end()

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('close', (code) => {
      if (code !== 0) {
        console.log(`ig_helper.py exited ${code}: ${stderr}`)
        resolve({ error: `Instagram 处理失败 (exit ${code})` })
        return
      }
      try {
        const result = JSON.parse(stdout.trim())
        resolve(result)
      } catch (e) {
        console.log(`ig_helper.py output parse error: ${stdout}`)
        resolve({ error: 'Instagram 响应解析失败' })
      }
    })

    child.on('error', (e) => {
      console.log(`ig_helper.py spawn error: ${e.message}`)
      resolve({ error: `Instagram 脚本启动失败: ${e.message}` })
    })
  })
}

module.exports = async function (params, context) {
  const shareText = params['shareText']
  const xhsCookie = params['xhsCookie']
  const igCookie = params['igCookie']
  const serverUrl = params['serverUrl']
  if (!shareText) {
    return {
      error: '缺少shareText参数',
    }
  }

  console.log(`shareText->${shareText}`)
  const platform = detectPlatform(shareText)
  console.log(`platform->${platform || 'unknown'}`)

  if (platform === 'instagram') {
    return await getIgPicUrl(shareText, igCookie, serverUrl)
  }

  if (platform === 'xiaohongshu') {
    const fullUrl = await getFullURL(shareText)
    console.log(`fullUrl->${fullUrl}`)
    const picUrlArray = await getPicUrl(fullUrl, xhsCookie)
    return { picUrlArray }
  }

  return { error: '不支持的链接类型，请使用小红书或 Instagram 的分享链接' }
}

async function getHeaders() {
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "zh-CN,zh;q=0.9",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "sec-ch-ua": "\"Google Chrome\";v=\"119\", \"Chromium\";v=\"119\", \"Not?A_Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  }
}

async function getFullURL(shortURLWithText) {
  const headers = await getHeaders()
  // 正则表达式提取url
  const urlRegex = /(http[s]?:\/\/[^\s，]+)/;
  const matched = shortURLWithText.match(urlRegex)
  if (!matched) {
    throw new Error('未能从分享文本中提取链接')
  }
  const shortURL = matched[0];
  try {
    await axios.get(shortURL, {
      headers,
      maxRedirects: 0,
      ...PROXY_CONFIG,
    })
    return shortURL
  } catch (error) {
    // 短链接会以 3xx + location 头返回真实地址
    const location = error.response && error.response.headers && error.response.headers.location
    if (location) {
      return location
    }
    // 本身已是完整笔记链接时，网络异常不影响后续用浏览器打开
    if (shortURL.includes('xiaohongshu.com')) {
      return shortURL
    }
    throw new Error(`解析分享链接失败: ${error.message}`)
  }
}

// 无水印原图靠 ci.xiaohongshu.com/{fileId} 拼接。
//
// fileId 形如 `oss-sg/notes/1040g3l03248c7jhe2o...`——**带 bucket 前缀**，
// 不等于 CDN 地址 path 的最后一段。实测（2026-08-24，真实笔记）：
//   ci/{fileId}?imageView2/2/w/0/format/png  → 200 image/png 5.1MB  ← 唯一可用
//   ci/{path 最后一段}                        → 404
//   urlDefault 原样                            → 200 但仅 298KB webp（压缩过）
// 因此必须优先取 fileId；从 URL path 提取只作兜底（旧数据 / 字段缺失时）。
function extractPicIdFromUrl(url) {
  if (!url || typeof url !== 'string') {
    return null
  }
  // 视频域不是图片，不能拼 ci.xiaohongshu.com
  if (!/^https?:\/\/sns-(?!video)[^.]+\.xhscdn\.com\//.test(url)) {
    return null
  }
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch (e) {
    return null
  }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) {
    return null
  }
  // 去掉 `!nd_dft_wlteh_webp_3` 这类尺寸/格式修饰符
  const lastSegment = segments[segments.length - 1].split('!')[0]
  if (!lastSegment) {
    return null
  }
  // 尽量还原 bucket 前缀：跳过 timestamp 段（纯数字）与 hash 段（长十六进制）
  const prefix = segments
    .slice(0, -1)
    .filter((seg) => !/^\d+$/.test(seg) && !/^[0-9a-f]{16,}$/i.test(seg))
  return [...prefix, lastSegment].join('/')
}

// 优先用 note 数据里现成的 fileId，其次回退到从 URL 解析
function extractPicId(item, candidateUrl) {
  const fileId = item && (item.fileId || item.file_id)
  if (fileId && typeof fileId === 'string') {
    return fileId
  }
  return extractPicIdFromUrl(candidateUrl)
}

// API(snake_case) 与 __INITIAL_STATE__(camelCase) 的字段命名不同，这里统一收集候选地址
function collectImageCandidates(item) {
  if (!item) {
    return []
  }
  if (typeof item === 'string') {
    return [item]
  }

  const candidates = []
  const infoList = item.infoList || item.info_list
  if (Array.isArray(infoList)) {
    for (const info of infoList) {
      if (info && info.url) {
        candidates.push(info.url)
      }
    }
  }

  const directFields = [
    item.urlDefault,
    item.url_default,
    item.url,
    item.urlPre,
    item.url_pre,
    item.original,
  ]
  for (const url of directFields) {
    if (url) {
      candidates.push(url)
    }
  }
  return candidates
}

function getImageList(note) {
  const list = note.imageList || note.image_list || note.images_list || note.imagesList
  return Array.isArray(list) ? list : []
}

// Live Photo 的视频流，兼容两种命名
function extractLivePhotoUrl(item) {
  const stream = item && item.stream
  if (!stream) {
    return null
  }
  for (const codec of ['h264', 'h265', 'av1']) {
    const variants = stream[codec]
    if (Array.isArray(variants) && variants.length > 0) {
      const url = variants[0].masterUrl || variants[0].master_url
      if (url) {
        return url
      }
    }
  }
  return null
}

function extractVideoUrl(note) {
  // 图文笔记没有 video 字段，属正常情况，不必报错
  const media = note.video && note.video.media
  if (!media || !media.video || !media.stream) {
    return null
  }
  try {
    const streamTypes = media.video.streamTypes || media.video.stream_types
    const streamType = Array.isArray(streamTypes) ? streamTypes[0] : undefined
    let videoUrl = null
    Object.entries(media.stream).forEach(([key, value]) => {
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0]
        const type = first.streamType !== undefined ? first.streamType : first.stream_type
        if (type === streamType) {
          videoUrl = first.masterUrl || first.master_url
        }
      }
    })
    return videoUrl
  } catch (error) {
    console.log(error)
    return null
  }
}

async function getPicUrl(fullUrl, xhsCookie) {
  // 用 Playwright 打开页面并拦截小红书自身的详情 API，
  // 由浏览器完成 X-s / X-t 签名，避免直接请求 HTML 拿不到数据的问题
  const { note, source } = await fetchNoteViaPlaywright(fullUrl, xhsCookie)
  console.log(`note data source->${source}`)

  const imageList = getImageList(note)
  const picUrlArray = []

  const picIdArray = []
  for (const item of imageList) {
    // fileId 直接可用时不必看 URL；否则逐个候选地址尝试解析
    const candidates = collectImageCandidates(item)
    const picId = extractPicId(item, candidates[0])
    if (picId) {
      picIdArray.push(picId)
      continue
    }
    for (const candidate of candidates.slice(1)) {
      const fallbackId = extractPicId(item, candidate)
      if (fallbackId) {
        picIdArray.push(fallbackId)
        break
      }
    }
  }

  picIdArray.forEach((item) =>
    picUrlArray.push(`https://ci.xiaohongshu.com/${item}?imageView2/2/w/0/format/png`)
  )

  for (const item of imageList) {
    const livePhotoVideoUrl = extractLivePhotoUrl(item)
    if (livePhotoVideoUrl) {
      picUrlArray.push(livePhotoVideoUrl)
    }
  }

  const videoUrl = extractVideoUrl(note)
  if (videoUrl) {
    picUrlArray.push(videoUrl)
  }

  if (picUrlArray.length === 0) {
    throw new Error('不包含图片')
  }
  return picUrlArray
}
