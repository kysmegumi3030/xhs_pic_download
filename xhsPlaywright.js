const { chromium } = require('playwright')

// 浏览器行为可通过环境变量调整
const HEADLESS = process.env.XHS_HEADLESS !== 'false'
const NAV_TIMEOUT = Number(process.env.XHS_NAV_TIMEOUT || 30000)
const API_WAIT_TIMEOUT = Number(process.env.XHS_API_WAIT_TIMEOUT || 15000)
// 拦截到 API 后再多等一会儿，让同一批请求（如多图分片）都落地
const API_SETTLE_MS = Number(process.env.XHS_API_SETTLE_MS || 800)

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-infobars',
  '--disable-dev-shm-usage',
]

// 反检测：隐藏 webdriver 等自动化特征
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
`

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// 复用同一个浏览器进程，避免每个请求都冷启动 Chromium
let browserPromise = null

// 代理支持：Docker 中通过 IG_PROXY / HTTP_PROXY / HTTPS_PROXY 设置
const PROXY_SERVER = process.env.IG_PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || ''

async function getBrowser() {
  if (browserPromise) {
    try {
      const browser = await browserPromise
      if (browser.isConnected()) {
        return browser
      }
    } catch (e) {
      // 上一次启动失败，下面重新启动
    }
    browserPromise = null
  }

  const launchOpts = { headless: HEADLESS, args: LAUNCH_ARGS }
  if (PROXY_SERVER) {
    launchOpts.proxy = { server: PROXY_SERVER }
    console.log(`Playwright proxy: ${PROXY_SERVER}`)
  }

  browserPromise = chromium
    .launch(launchOpts)
    .catch((err) => {
      browserPromise = null
      throw err
    })

  return browserPromise
}

async function closeBrowser() {
  if (!browserPromise) {
    return
  }
  const pending = browserPromise
  browserPromise = null
  try {
    const browser = await pending
    await browser.close()
  } catch (e) {
    // 关闭失败不影响退出
  }
}

function parseCookieString(cookieStr) {
  const cookies = []
  for (const part of String(cookieStr).split(';')) {
    const item = part.trim()
    const idx = item.indexOf('=')
    if (idx <= 0) {
      continue
    }
    cookies.push({
      name: item.slice(0, idx).trim(),
      value: item.slice(idx + 1).trim(),
      domain: '.xiaohongshu.com',
      path: '/',
    })
  }
  return cookies
}

// 小红书获取笔记详情的几个端点：web 端 feed / note，以及 h5 端 note_info
const NOTE_API_PATHS = [
  '/api/sns/web/v1/feed',
  '/api/sns/web/v1/note/',
  '/api/sns/h5/v1/note_info',
]

// `/api/sns/web/v1/note/` 前缀下还挂着一批与笔记内容无关的埋点/统计接口，
// 它们同样返回 success:true，会被误当成详情响应：
// 既让日志谎报「拦截到 API」，也会提前结束等待、浪费 API_SETTLE_MS。
const NOTE_API_EXCLUDE = /\/(metrics_report|report|like|dislike|collect|uncollect|comment)(\/|$|\?)/

function isNoteDetailApi(url) {
  if (!url.includes('edith')) {
    return false
  }
  if (!NOTE_API_PATHS.some((path) => url.includes(path))) {
    return false
  }
  return !NOTE_API_EXCLUDE.test(url)
}

function looksLikeNote(obj) {
  if (!obj || typeof obj !== 'object') {
    return false
  }
  return Boolean(
    obj.image_list || obj.imageList || obj.images_list || obj.imagesList || obj.video || obj.cover
  )
}

// 各端点的响应层级不一致（items / note_list / note_card 混用），做有界的递归查找
function pickNoteFromApiPayload(data, depth = 0) {
  const root = depth === 0 ? (data && data.data) || {} : data
  if (!root || typeof root !== 'object' || depth > 5) {
    return null
  }

  if (Array.isArray(root)) {
    for (const entry of root) {
      const found = pickNoteFromApiPayload(entry, depth + 1)
      if (found) {
        return found
      }
    }
    return null
  }

  // 优先检查明确的 note 容器字段
  for (const key of ['note_card', 'noteCard', 'note']) {
    if (looksLikeNote(root[key])) {
      return root[key]
    }
  }
  if (looksLikeNote(root)) {
    return root
  }

  for (const key of ['items', 'note_list', 'noteList', 'note_card', 'noteCard', 'note']) {
    if (root[key]) {
      const found = pickNoteFromApiPayload(root[key], depth + 1)
      if (found) {
        return found
      }
    }
  }
  return null
}

// 笔记页被重定向时，从跳转地址里取出小红书自己的错误说明，拼成可读提示
function describeRedirect(currentUrl) {
  let detail = ''
  try {
    const params = new URL(currentUrl).searchParams
    const msg = params.get('error_msg')
    const code = params.get('error_code')
    if (msg) {
      detail = code ? `${msg}（error_code=${code}）` : msg
    } else if (code) {
      detail = `error_code=${code}`
    }
  } catch (e) {
    // URL 解析失败则不附加细节
  }
  const reason = detail || '未登录或链接已失效'
  return `无法打开笔记页（${reason}），请在请求中传入有效的 xhsCookie，并确保链接包含 xsec_token`
}

// 从页面 __INITIAL_STATE__ 读 note（仅接受真正带媒体字段的）
function readNoteFromInitialState(page) {
  return page
    .evaluate(() => {
      const state = window.__INITIAL_STATE__
      const map = state && state.note && state.note.noteDetailMap
      if (!map) {
        return null
      }
      const hasMedia = (n) => n && (n.imageList || n.image_list || n.video || n.cover)
      const firstNoteId = state.note.firstNoteId
      if (firstNoteId && map[firstNoteId] && hasMedia(map[firstNoteId].note)) {
        return map[firstNoteId].note
      }
      for (const key of Object.keys(map)) {
        if (map[key] && hasMedia(map[key].note)) {
          return map[key].note
        }
      }
      return null
    })
    .catch(() => null)
}

/**
 * 用真实 Chromium 打开笔记页面，拦截小红书自己发出的详情 API，拿到完整 note 数据。
 * 浏览器会自动带上 X-s / X-t / X-s-common 签名，无需手动生成。
 * 若未拦截到 API，则回退读取页面内的 window.__INITIAL_STATE__。
 *
 * @returns {Promise<{note: object, source: string}>}
 */
async function fetchNoteViaPlaywright(fullUrl, xhsCookie) {
  const browser = await getBrowser()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: USER_AGENT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })

  try {
    await context.addInitScript(STEALTH_SCRIPT)
    if (xhsCookie) {
      const cookies = parseCookieString(xhsCookie)
      if (cookies.length > 0) {
        await context.addCookies(cookies)
      }
    }

    const page = await context.newPage()
    page.setDefaultTimeout(NAV_TIMEOUT)

    const apiPayloads = []
    let resolveFirstHit
    const firstHit = new Promise((resolve) => {
      resolveFirstHit = resolve
    })

    page.on('response', async (response) => {
      if (!isNoteDetailApi(response.url())) {
        return
      }
      try {
        const data = await response.json()
        if (data && data.success) {
          apiPayloads.push(data)
          resolveFirstHit()
        }
      } catch (e) {
        // 非 JSON 或响应体已释放，忽略
      }
    })

    try {
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
    } catch (e) {
      console.log(`页面加载超时，继续尝试解析: ${e.message}`)
    }

    // 等详情 API 落地。实测很多笔记页根本不发详情 API（数据直接 SSR 进
    // __INITIAL_STATE__），此时死等 API_WAIT_TIMEOUT 会让每个请求都白等满
    // 15s。所以改为「API 命中」与「页面状态已可用」二者竞速，谁先到用谁。
    const stateReady = (async () => {
      const deadline = Date.now() + API_WAIT_TIMEOUT
      while (Date.now() < deadline) {
        const note = await readNoteFromInitialState(page)
        if (note) {
          return note
        }
        await page.waitForTimeout(250)
      }
      return null
    })()

    const earlyStateNote = await Promise.race([
      firstHit.then(() => null),
      stateReady,
      page.waitForTimeout(API_WAIT_TIMEOUT).then(() => null),
    ])

    // 若是 API 先命中，多等一会儿让同批请求（如多图分片）都落地
    if (apiPayloads.length > 0) {
      await page.waitForTimeout(API_SETTLE_MS)
    }

    const currentUrl = page.url()
    if (currentUrl.includes('/login') || currentUrl.includes('captcha')) {
      throw new Error('被小红书安全验证拦截，请更新 xhsCookie 后重试')
    }

    // API 数据比 SSR 更完整，优先使用
    for (const payload of apiPayloads) {
      const note = pickNoteFromApiPayload(payload)
      if (note) {
        return { note, source: 'api' }
      }
    }

    // 兜底：页面内的初始状态（竞速阶段可能已经读到）
    const stateNote = earlyStateNote || (await readNoteFromInitialState(page))

    if (stateNote) {
      return { note: stateNote, source: 'initial_state' }
    }

    // 笔记页被重定向走，通常是缺少有效 Cookie 或 xsec_token 已失效
    if (!/\/explore\/|\/discovery\/item\//.test(currentUrl)) {
      throw new Error(describeRedirect(currentUrl))
    }

    throw new Error('未能获取笔记数据，可能是 Cookie 失效 / 笔记已删除 / 链接缺少 xsec_token')
  } finally {
    await context.close().catch(() => {})
  }
}

module.exports = {
  fetchNoteViaPlaywright,
  closeBrowser,
  parseCookieString,
}
