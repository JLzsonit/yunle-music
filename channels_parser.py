"""
微信视频号分享链接解析器

原理（走腾讯官方 Web 预览链路，不碰微信客户端的加密流）：
  1) 分享链接 -> 腾讯元宝 Web 接口 get_parse_result -> 得到 playable_url（内含 token / eid）
  2) token + eid -> 视频号 Preview 协议 get_feed_info -> 得到 H.264/H.265 视频直链、标题、作者、封面
  3) 直链（finder.video.qq.com）是未加密的预览规格，可直接下载后转 MP3

注意：
  - 第 1 步需要「腾讯元宝」网页版登录态（Cookie），只需配置一次；过期后重新复制。
  - 预览链路只下发被签名锁定的中等码率规格（xWT113/xWT158），这是 Web 链路的天花板；
    做音乐播放器完全够用（转 MP3 后音质无差别）。
"""

import re
import urllib.parse

import requests

YUANBAO_PARSE = "https://yuanbao.tencent.com/api/weixin/get_parse_result"
FEED_INFO = "https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info"

DESKTOP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1")


class ChannelsError(Exception):
    """视频号解析失败（消息面向用户，可直接展示）"""


def _deep_find(obj, keys, want_str=True):
    """在嵌套 dict/list 里按 key 名递归找一个值"""
    if isinstance(obj, dict):
        for k in keys:
            v = obj.get(k)
            if v is not None and (not want_str or isinstance(v, str)) and v:
                return v
        for v in obj.values():
            got = _deep_find(v, keys, want_str)
            if got:
                return got
    elif isinstance(obj, list):
        for v in obj:
            got = _deep_find(v, keys, want_str)
            if got:
                return got
    return None


def _pick_media(feed):
    """从 feedInfo 里挑视频直链：优先 H.264（兼容性最好），其次 H.265，再次兜底 URL"""
    cands = []
    for key in ("h264VideoInfo", "h265VideoInfo", "videoInfo", "mediaInfo"):
        node = feed.get(key)
        if isinstance(node, dict):
            u = node.get("videoUrl") or node.get("url")
            if isinstance(u, str) and u.startswith("http"):
                cands.append((key, u))
    for key in ("videoUrl", "url", "playUrl"):
        u = feed.get(key)
        if isinstance(u, str) and u.startswith("http"):
            cands.append((key, u))

    # 逐层兜底：任何 finder.video.qq.com / .mp4 链接
    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and o.startswith("http"):
            if "finder.video.qq.com" in o or re.search(r"\.mp4(\?|$)", o, re.I) or "/vweixinfx/" in o:
                cands.append(("scan", o))
    walk(feed)

    if not cands:
        return None
    # 按 264 > 265 > 其他 排序
    order = {"h264VideoInfo": 0, "h265VideoInfo": 1}
    cands.sort(key=lambda kv: order.get(kv[0], 2))
    return cands[0][1]


def _val(v):
    """微信接口常返回 {"value": "xxx"} 结构"""
    if isinstance(v, dict):
        return v.get("value") or v.get("text") or ""
    return v or ""


def resolve(share_url, cookie, timeout=25):
    """
    解析视频号分享链接
    返回 {video_url, title, author, cover, duration}
    失败抛 ChannelsError（消息可直接展示给用户）
    """
    if not cookie or "=" not in cookie:
        raise ChannelsError(
            "还需要配置「元宝 Cookie」才能解析视频号。\n"
            "设置方法：浏览器打开 yuanbao.tencent.com 并用微信登录 → F12 → Network → "
            "随便点一个请求 → 复制请求头里的 Cookie 整段，粘贴到下载页的「视频号设置」里保存。"
        )

    s = requests.Session()
    s.headers.update({
        "User-Agent": DESKTOP_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Origin": "https://yuanbao.tencent.com",
        "Referer": "https://yuanbao.tencent.com/",
    })

    # ---- 第一步：分享链接 -> export_id + playable_url ----
    try:
        r = s.post(
            YUANBAO_PARSE,
            json={"type": "video_channel_url", "url": share_url, "scene": 1},
            headers={"Cookie": cookie, "Content-Type": "application/json"},
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise ChannelsError(f"连接腾讯元宝接口失败（网络问题）：{e}")

    if r.status_code == 401:
        raise ChannelsError(
            "元宝 Cookie 已失效或未登录（接口返回 401）。\n"
            "请重新登录 yuanbao.tencent.com，复制新的 Cookie 后覆盖保存。"
        )
    try:
        pdata = r.json()
    except Exception:
        raise ChannelsError(f"元宝接口返回异常（HTTP {r.status_code}），请稍后重试")

    err = pdata.get("error") or {}
    if err:
        code = err.get("code")
        msg = err.get("message") or ""
        if str(code) == "20000":
            raise ChannelsError(
                f"元宝 Cookie 无效或已过期（{msg or '未知错误'}）。\n"
                "请重新登录 yuanbao.tencent.com 复制新 Cookie 后保存。"
            )
        raise ChannelsError(f"元宝解析失败：{msg or code}")

    data = pdata.get("data") or {}
    export_id = (data.get("wx_export_id") or data.get("export_id")
                 or _deep_find(data, ["wx_export_id", "export_id"]))
    playable = (data.get("playable_url") or _deep_find(data, ["playable_url", "playableUrl", "url"]))

    token = eid = None
    if playable:
        q = urllib.parse.parse_qs(urllib.parse.urlparse(playable).query)
        token = (q.get("token") or q.get("generalToken") or q.get("general_token") or [None])[0]
        eid = (q.get("eid") or q.get("exportId") or q.get("export_id") or [None])[0]
    if not playable:
        # 有些返回直接给 eid 或 token
        token = token or _deep_find(data, ["generalToken", "general_token", "token"])
        eid = eid or export_id

    if not token or not eid:
        raise ChannelsError(
            "解析不到视频号凭证（token/eid）。这条链接可能不是视频号内容，"
            "或该视频已被作者删除/设为不可分享。"
        )

    # ---- 第二步：token + eid -> 视频直链与元信息 ----
    try:
        fr = s.get(
            FEED_INFO,
            params={"generalToken": token, "exportId": eid},
            headers={"User-Agent": MOBILE_UA,
                     "Referer": "https://channels.weixin.qq.com/",
                     "Accept": "application/json, text/plain, */*"},
            timeout=timeout,
        )
    except requests.RequestException as e:
        raise ChannelsError(f"连接视频号接口失败（网络问题）：{e}")

    if fr.status_code == 401 or "permission verification failed" in fr.text[:200]:
        raise ChannelsError(
            "视频号接口验证失败（token 过期）。请重新复制分享链接再试一次；"
            "若持续失败，请更新元宝 Cookie。"
        )
    try:
        fdata = fr.json()
    except Exception:
        raise ChannelsError(f"视频号接口返回异常（HTTP {fr.status_code}）")

    body = fdata.get("data") or fdata
    feed = body.get("feedInfo") or body.get("feed_info") or body
    author_info = body.get("authorInfo") or body.get("author_info") or {}

    video_url = _pick_media(feed if isinstance(feed, dict) else {})
    if not video_url:
        api_msg = fdata.get("errMsg") or fdata.get("errmsg") or ""
        extra = f"（接口提示：{api_msg}）" if api_msg else ""
        raise ChannelsError(
            "拿到了视频号凭证，但接口没有下发可播放地址" + extra + "。\n"
            "可能该内容为图文/直播，或已被限制分享；也可能凭证已过期，重新复制分享链接再试一次。"
        )

    title = (_val(feed.get("description")) or _val(feed.get("title"))
             or _val(feed.get("desc")) or "")
    title = re.sub(r"\s+", " ", str(title)).strip()
    if not title:
        title = _val(author_info.get("nickname")) or "视频号音频"

    author = (_val(author_info.get("nickname")) or _val(feed.get("nickname"))
              or _val(feed.get("authorName")) or "视频号")

    pic = feed.get("picInfo") or feed.get("coverInfo") or {}
    cover = (_val(pic.get("coverUrl")) or _val(pic.get("thumbUrl"))
             or _val(pic.get("url")) or _val(feed.get("coverUrl")) or "")

    duration = 0
    for k in ("duration", "videoDuration", "mediaDuration"):
        v = feed.get(k)
        if isinstance(v, (int, float)) and v:
            duration = int(v / 1000) if v > 10000 else int(v)
            break

    return {
        "video_url": video_url,
        "title": title[:120],
        "author": str(author)[:60],
        "cover": cover,
        "duration": duration,
    }
