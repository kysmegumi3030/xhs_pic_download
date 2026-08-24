const axios = require('axios')
const { fetchNoteViaPlaywright } = require('./xhsPlaywright')

module.exports = async function (params, context) {
  const shareText = params['shareText']
  const xhsCookie = params['xhsCookie']
  if (!shareText) {
    return {
      error: '缺少shareText参数',
    }
  }

  console.log(`shareText->${shareText}`)
  const fullUrl = await getFullURL(shareText)
  console.log(`fullUrl->${fullUrl}`)

  const picUrlArray = await getPicUrl(fullUrl, xhsCookie)
  return {
    picUrlArray,
  }
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
      maxRedirects: 0
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

// 图片 trace id：从任意 sns-*.xhscdn.com 图片地址中提取，用于拼无水印原图
const PIC_ID_REGEX = /https?:\/\/sns-[\w-]+\.xhscdn\.com\/(?:\d+\/[0-9a-z]+\/)?([^/!?\s]+)/

function extractPicId(url) {
  if (!url || typeof url !== 'string') {
    return null
  }
  const match = url.match(PIC_ID_REGEX)
  return match && match[1] ? match[1] : null
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
    for (const candidate of collectImageCandidates(item)) {
      const picId = extractPicId(candidate)
      if (picId) {
        picIdArray.push(picId)
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
