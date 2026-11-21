# -*- coding: utf-8 -*-
"""
云乐 Yunle：本地音乐下载/播放服务
- 粘贴任意分享链接（抖音/快手/B站/小红书/微博/YouTube…或任意视频直链）
- 解析链：yt-dlp（1755+站点）→ 通用网页嗅探 → 直链下载
- 统一转 MP3（含封面、歌名、歌手、时长），手机端可保存到本地离线播放
启动：python server.py
"""
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests
from flask import Flask, jsonify, request, send_file, send_from_directory
from mutagen.id3 import APIC, ID3, TIT2, TPE1
from mutagen.mp3 import MP3

import channels_parser
import yt_dlp

BASE = Path(__file__).resolve().parent
MUSIC_DIR = BASE / "music_library"
ICON_DIR = BASE / "static" / "covers"
MUSIC_DIR.mkdir(exist_ok=True)
ICON_DIR.mkdir(parents=True, exist_ok=True)
LIB_FILE = BASE / "library.json"
PL_FILE = BASE / "playlists.json"
CONFIG_FILE = BASE / "config.json"

FFMPEG = shutil.which("ffmpeg")
if not FFMPEG:
    try:
        import imageio_ffmpeg
        FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        FFMPEG = None
if not FFMPEG:
    cands = list(Path(os.environ.get("LOCALAPPDATA", "")).glob(
        "Microsoft/WinGet/Packages/*FFmpeg*/ffmpeg-*/bin/ffmpeg.exe"))
    FFMPEG = str(cands[0]) if cands else "ffmpeg"

MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1")

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 允许上传 1GB 以内的视频


@app.after_request
def _cors(resp):
    # 允许 APK 壳应用（本地 https://localhost）跨域调用云端引擎
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Max-Age"] = "86400"
    return resp

_lock = threading.Lock()


def load_json(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default


def save_json(path, data):
    with _lock:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


library = load_json(LIB_FILE, [])
playlists = load_json(PL_FILE, [])
config = load_json(CONFIG_FILE, {})
jobs = {}

# 平台识别：用于友好错误提示
PLATFORM_GUESS = [
    (r"channels\.weixin\.qq\.com|finder\.video\.qq\.com|weixin110|weixin\.qq\.com/sph", "微信视频号"),
    (r"kuaishou\.com|chenzhongtech\.com|gifshow\.com", "快手"),
    (r"douyin\.com|iesdouyin\.com", "抖音"),
    (r"bilibili\.com|b23\.tv", "B站"),
    (r"xiaohongshu\.com|xhslink\.com", "小红书"),
    (r"weibo\.com|weibo\.cn", "微博"),
    (r"ixigua\.com", "西瓜视频"),
    (r"youtube\.com|youtu\.be", "YouTube"),
    (r"tiktok\.com", "TikTok"),
    (r"instagram\.com", "Instagram"),
    (r"x\.com|twitter\.com", "X/Twitter"),
    (r"music\.163\.com", "网易云音乐"),
    (r"y\.qq\.com|qq\.com/n/ryqq", "QQ音乐"),
    (r"kugou\.com", "酷狗音乐"),
]


def guess_platform(url):
    for pat, name in PLATFORM_GUESS:
        if re.search(pat, url):
            return name
    return "通用"


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ---------------- 解析工具 ----------------

MEDIA_EXT_RE = re.compile(r"\.(mp4|m4a|mp3|aac|flac|wav|ogg|webm|mkv|mov|m3u8|ts)(\?|$)", re.I)
HTML_MEDIA_RE = re.compile(
    r'(?:https?:)?(?:\\u002F|\\/|/){2}[^"\'\s<>]+?\.(?:mp4|m3u8|m4a|mp3)(?:\?[^"\'\s<>]*)?', re.I)


def http_get(url, timeout=25, ua=MOBILE_UA):
    return requests.get(url, headers={
        "User-Agent": ua,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }, timeout=timeout, allow_redirects=True)


def probe_page(url):
    """网页嗅探：抓 og:title / og:image / 页面里的媒体地址（快手等无解析器的站点兜底）"""
    meta = {"title": None, "cover": None, "candidates": [], "final_url": url}
    try:
        r = http_get(url)
        meta["final_url"] = r.url
        html = r.text
        ct = r.headers.get("Content-Type", "")
        # 直接就是媒体文件
        if "video" in ct or "audio" in ct or MEDIA_EXT_RE.search(urlparse(r.url).path or ""):
            meta["candidates"].append(r.url)
            meta["direct"] = True
            if "video" in ct or "audio" in ct:
                meta["content_type"] = ct
            return meta
        for prop, key in (("og:title", "title"), ('"caption"', "title"),
                          ("og:image", "cover"), ('"coverUrl"', "cover"),
                          ('"cover"', "cover")):
            m = re.search(rf'{prop}"?\s*(?:content=|:)\s*"([^"]{{2,200}})"', html)
            if m and not meta[key]:
                v = m.group(1).replace("\\u002F", "/").replace("\\/", "/")
                if v.startswith("//"):
                    v = "https:" + v
                if key == "title":
                    v = v.encode().decode("unicode_escape", errors="ignore") if "\\u" in v else v
                meta[key] = v
        # 页面内媒体地址（去重，优先无水印/高清）
        cands = []
        for m in HTML_MEDIA_RE.finditer(html):
            u = m.group(0).replace("\\u002F", "/").replace("\\/", "/")
            if u.startswith("//"):
                u = "https:" + u
            if u not in cands:
                cands.append(u)
        meta["candidates"] = cands[:8]
    except Exception as e:
        meta["error"] = str(e)[:150]
    return meta


def extract_cover(mp3, job_id):
    """从 MP3 内嵌封面导出 jpg"""
    cov = ICON_DIR / f"{job_id}.jpg"
    try:
        r = subprocess.run(
            [FFMPEG, "-y", "-v", "error", "-i", str(mp3), "-an",
             "-frames:v", "1", "-q:v", "3", str(cov)],
            capture_output=True, timeout=60,
        )
        if r.returncode == 0 and cov.exists() and cov.stat().st_size > 1000:
            return f"{job_id}.jpg"
    except Exception:
        pass
    return None


def save_remote_cover(cover_url, job_id):
    """下载网页封面作为本地封面"""
    try:
        r = http_get(cover_url, timeout=20)
        if r.ok and len(r.content) > 1000:
            f = ICON_DIR / f"{job_id}.jpg"
            f.write_bytes(r.content)
            return f"{job_id}.jpg"
    except Exception:
        pass
    return None


def ydl_opts(job_id, use_cookies, hook, cookie_file=None):
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(MUSIC_DIR / f"{job_id}.%(ext)s"),
        "ffmpeg_location": str(Path(FFMPEG).parent),
        "writethumbnail": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
            {"key": "EmbedThumbnail", "already_have_thumbnail": True},
        ],
        "progress_hooks": [hook],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 2,
        "socket_timeout": 25,
        "geo_bypass": True,
        "http_headers": {"User-Agent": MOBILE_UA},
    }
    if cookie_file:
        opts["cookiefile"] = str(cookie_file)
    elif use_cookies:
        opts["cookiesfrombrowser"] = ("chrome",)
    return opts


# ---------------- Cookie 工具（抖音等需要登录态的站点） ----------------

def cookie_file_for(raw_cookie, domain, tag):
    """把浏览器复制的 "k=v; k2=v2" 转成 yt-dlp 可用的 Netscape cookie 文件"""
    raw = (raw_cookie or "").strip()
    if not raw:
        return None
    path = BASE / f".{tag}_cookies.txt"
    exp = int(time.time()) + 86400 * 30
    lines = ["# Netscape HTTP Cookie File"]
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if not k:
            continue
        lines.append(f"{domain}\tTRUE\t/\tFALSE\t{exp}\t{k}\t{v}")
    if len(lines) == 1:
        return None
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def resolve_douyin(url):
    """短链跳转解析：v.douyin.com -> 真实作品页；返回 (规范链接, 类型)"""
    try:
        r = http_get(url, timeout=25)
        final = r.url or url
    except Exception:
        final = url
    if "/note/" in final:
        return final, "note"
    m = re.search(r"/(?:video|share/video)/(\d+)", final)
    if m:
        return f"https://www.douyin.com/video/{m.group(1)}", "video"
    m = re.search(r"modal_id=(\d+)", final)
    if m:
        return f"https://www.douyin.com/video/{m.group(1)}", "video"
    return final, "unknown"


def download_media(url, dest, job_id, referer=None, ua=MOBILE_UA):
    """流式下载媒体文件，带进度回报"""
    headers = {"User-Agent": ua, "Accept": "*/*"}
    if referer:
        headers["Referer"] = referer
    with requests.get(url, headers=headers, stream=True, timeout=60, allow_redirects=True) as r:
        r.raise_for_status()
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        tick = time.time()
        tick_bytes = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=262144):
                if not chunk:
                    continue
                f.write(chunk)
                done += len(chunk)
                tick_bytes += len(chunk)
                now = time.time()
                if now - tick > 0.5:
                    speed = int(tick_bytes / (now - tick))
                    tick, tick_bytes = now, 0
                    upd = {"speed": speed}
                    if total:
                        upd["progress"] = min(5 + int(done / total * 80), 88)
                    jobs[job_id].update(upd)
    return dest


def tag_mp3(mp3_path, title, artist, cover_bytes=None):
    """写入歌名/歌手标签，并把封面嵌入 MP3（锁屏、系统播放器都能显示）"""
    try:
        try:
            tags = ID3(str(mp3_path))
        except Exception:
            tags = ID3()
        if title:
            tags.add(TIT2(encoding=3, text=str(title)))
        if artist:
            tags.add(TPE1(encoding=3, text=str(artist)))
        if cover_bytes and len(cover_bytes) > 1000:
            tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover",
                          data=cover_bytes))
        tags.save(str(mp3_path))
    except Exception:
        pass


def add_song(job_id, title, artist, duration, cover, url, plat, mp3):
    """把转换完成的 MP3 写入曲库"""
    try:
        duration = int(MP3(str(mp3)).info.length)
    except Exception:
        duration = int(duration or 0)
    song = {
        "id": job_id,
        "title": (title or "未知标题").strip()[:150],
        "artist": (artist or plat or "未知")[:80],
        "duration": duration,
        "cover": cover or "default",
        "size": mp3.stat().st_size,
        "added": int(time.time()),
        "source": url,
        "platform": plat,
    }
    library.insert(0, song)
    save_json(LIB_FILE, library)
    jobs[job_id].update(status="done", progress=100, title=song["title"], song_id=job_id)
    return song


def download_channels(job_id, url):
    """微信视频号专用链路：元宝解析 -> 视频号 preview -> 直链 -> MP3"""
    cookie = (config.get("yuanbao_cookie") or "").strip()
    try:
        jobs[job_id].update(status="processing", progress=6, title="正在解析视频号分享链接…",
                            platform="微信视频号")
        info = channels_parser.resolve(url, cookie)
        jobs[job_id].update(progress=12, title=info["title"] or "视频号内容", stage="下载视频中")

        src = MUSIC_DIR / f"{job_id}.src.mp4"
        download_media(info["video_url"], src, job_id,
                       referer="https://channels.weixin.qq.com/",
                       ua=channels_parser.MOBILE_UA)
        jobs[job_id].update(status="processing", progress=90, title="正在转换为 MP3…", stage="转码中")

        mp3 = MUSIC_DIR / f"{job_id}.mp3"
        r = subprocess.run(
            [FFMPEG, "-y", "-v", "error", "-i", str(src), "-vn",
             "-c:a", "libmp3lame", "-b:a", "192k", str(mp3)],
            capture_output=True, timeout=600,
        )
        if r.returncode != 0 or not mp3.exists():
            err = (r.stderr or b"").decode("utf-8", "ignore")[:200]
            raise RuntimeError(f"视频转音频失败：{err or 'ffmpeg 执行异常'}")

        # 封面：优先视频首帧，其次接口给的封面图
        cover = extract_cover(mp3, job_id)
        cover_bytes = None
        if cover:
            try:
                cover_bytes = (ICON_DIR / cover).read_bytes()
            except Exception:
                cover_bytes = None
        if not cover and info.get("cover"):
            cover = save_remote_cover(info["cover"], job_id)
            if cover:
                try:
                    cover_bytes = (ICON_DIR / cover).read_bytes()
                except Exception:
                    pass

        tag_mp3(mp3, info["title"], info["author"], cover_bytes)
        src.unlink(missing_ok=True)
        add_song(job_id, info["title"], info["author"], info["duration"],
                 cover, url, "微信视频号", mp3)
    except channels_parser.ChannelsError as e:
        jobs[job_id].update(status="error", error=str(e), platform="微信视频号")
    except requests.RequestException as e:
        jobs[job_id].update(status="error", platform="微信视频号",
                            error=f"下载视频号视频失败（网络问题）：{str(e)[:150]}")
    except Exception as e:
        msg = str(e)
        jobs[job_id].update(status="error", platform="微信视频号",
                            error=msg[:300] if msg else "视频号解析失败")


def do_download(job_id, url, use_cookies):
    plat = guess_platform(url)
    if plat == "微信视频号":
        download_channels(job_id, url)
        return
    cookie_file = None
    if plat == "抖音":
        jobs[job_id].update(status="downloading", progress=4, title="正在解析抖音链接…", platform=plat)
        real, kind = resolve_douyin(url)
        if kind == "note":
            jobs[job_id].update(status="error", platform=plat,
                                error="这是抖音「图文」作品（只有图片），没有音轨可提取。请换一条视频作品链接。")
            return
        if kind == "video":
            url = real
        dy_ck = (config.get("douyin_cookie") or "").strip()
        if not dy_ck:
            jobs[job_id].update(status="error", platform=plat,
                                error="抖音解析需要先配置一次「抖音 Cookie」：\n"
                                      "1. 电脑浏览器打开 douyin.com（登录或不登录都行）\n"
                                      "2. F12 → Network → 刷新页面，点任意一条请求\n"
                                      "3. 复制 Request Headers 里 cookie: 后面的整段\n"
                                      "4. 粘贴到下载页「抖音设置」里保存，再回来点下载")
            return
        cookie_file = cookie_file_for(dy_ck, ".douyin.com", "douyin")
    try:
        jobs[job_id].update(status="downloading", progress=3, title=f"正在解析{plat}链接…", platform=plat)

        def hook(d):
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes", 0)
                pct = 3 + int(done / total * 87) if total else jobs[job_id]["progress"]
                info = d.get("info_dict") or {}
                jobs[job_id].update(progress=pct,
                                    title=info.get("title") or jobs[job_id]["title"],
                                    speed=d.get("speed"))
            elif d["status"] == "finished":
                jobs[job_id].update(status="processing", progress=92, title="正在转换为 MP3…")

        info, meta = None, {}
        # ---- 第一步：yt-dlp 直接解析（支持 1755+ 站点）----
        try:
            with yt_dlp.YoutubeDL(ydl_opts(job_id, use_cookies, hook, cookie_file)) as ydl:
                info = ydl.extract_info(url, download=True)
        except Exception as e1:
            first_err = str(e1)
            # ---- 第二步：网页嗅探兜底（快手等）----
            jobs[job_id].update(progress=8, title=f"{plat}链接转通用解析…")
            meta = probe_page(url)
            cand = None
            for c in meta.get("candidates", []):
                if ".m3u8" in c or ".mp4" in c:
                    cand = c
                    break
            if not cand and meta.get("candidates"):
                cand = meta["candidates"][0]
            if cand:
                try:
                    with yt_dlp.YoutubeDL(ydl_opts(job_id, use_cookies, hook, cookie_file)) as ydl:
                        info = ydl.extract_info(cand, download=True)
                except Exception:
                    info = None
                if info is None:
                    # ---- 第三步：直接下载媒体再转码 ----
                    tmp = MUSIC_DIR / f"{job_id}.src"
                    r = http_get(cand, timeout=120)
                    if not r.ok:
                        raise RuntimeError(first_err)
                    tmp.write_bytes(r.content)
                    mp3 = MUSIC_DIR / f"{job_id}.mp3"
                    subprocess.run(
                        [FFMPEG, "-y", "-v", "error", "-i", str(tmp),
                         "-vn", "-c:a", "libmp3lame", "-b:a", "192k", str(mp3)],
                        capture_output=True, timeout=300)
                    tmp.unlink(missing_ok=True)
                    info = {"title": meta.get("title") or url, "uploader": plat,
                            "duration": 0, "thumbnail": meta.get("cover")}
            else:
                if plat == "微信视频号":
                    raise RuntimeError(
                        "微信视频号不支持：其视频地址经过加密并绑定微信客户端，"
                        "任何第三方工具（包括本应用）都无法解析。"
                        "建议在微信里打开视频号内容，用手机录屏或让对方发原视频文件。")
                if plat == "抖音":
                    raise RuntimeError(
                        "抖音解析失败：Cookie 可能已过期，或该链接不是视频作品。\n"
                        "请重新复制一次抖音 Cookie（电脑浏览器打开 douyin.com → F12 → Network → 复制 cookie）粘贴保存后再试。")
                if plat == "快手":
                    raise RuntimeError(
                        "快手解析失败：快手对分享页做了强反爬限制。"
                        "可以在电脑浏览器打开该链接（登录状态），勾选下载页的"
                        "「使用浏览器登录状态」后再试；或把视频另存为文件后直接上传/使用直链。")
                raise RuntimeError(
                    f"该链接解析失败（{plat}）。原因：{first_err[:200]}\n"
                    "提示：可尝试在电脑浏览器登录该平台后，勾选「使用浏览器登录状态」重试。")

        mp3 = MUSIC_DIR / f"{job_id}.mp3"
        if not mp3.exists():
            raise RuntimeError("转换后的 MP3 未找到，该链接可能不受支持")

        # ---- 封面：优先内嵌封面 → 网页 og:image ----
        cover = extract_cover(mp3, job_id)
        if not cover:
            thumb = (info or {}).get("thumbnail") or meta.get("cover")
            if thumb:
                cover = save_remote_cover(thumb, job_id)

        try:
            duration = int(MP3(str(mp3)).info.length)
        except Exception:
            duration = int((info or {}).get("duration") or 0)

        i = info or {}
        title = (i.get("title") or meta.get("title") or "未知标题").strip()
        artist = (i.get("uploader") or i.get("artist") or i.get("creator")
                  or i.get("uploader_id") or meta.get("artist") or plat)
        song = {
            "id": job_id,
            "title": title,
            "artist": artist,
            "duration": duration,
            "cover": cover or "default",
            "size": mp3.stat().st_size,
            "added": int(time.time()),
            "source": url,
            "platform": plat,
        }
        library.insert(0, song)
        save_json(LIB_FILE, library)
        jobs[job_id].update(status="done", progress=100, title=song["title"], song_id=job_id)
    except Exception as e:
        msg = str(e)
        if len(msg) > 400:
            msg = msg[:400] + "…"
        jobs[job_id].update(status="error", error=msg, platform=plat)


# ---------------- 路由 ----------------

@app.get("/api/info")
def api_info():
    return jsonify({"ip": get_local_ip(), "count": len(library), "version": "1.2.0",
                    "channels_cookie": bool((config.get("yuanbao_cookie") or "").strip())})


@app.get("/api/config")
def api_config_get():
    ck = (config.get("yuanbao_cookie") or "").strip()
    dy = (config.get("douyin_cookie") or "").strip()
    masked = ""
    if ck:
        # 只回显首尾，避免整段凭证暴露在页面上
        masked = (ck[:24] + "…" + ck[-8:]) if len(ck) > 40 else "已配置"
    dy_masked = ""
    if dy:
        dy_masked = (dy[:24] + "…" + dy[-8:]) if len(dy) > 40 else "已配置"
    return jsonify({"channels_cookie_set": bool(ck), "channels_cookie_preview": masked,
                    "douyin_cookie_set": bool(dy), "douyin_cookie_preview": dy_masked})


@app.post("/api/config")
def api_config_set():
    global config
    data = request.json or {}
    if "yuanbao_cookie" in data:
        config["yuanbao_cookie"] = (data.get("yuanbao_cookie") or "").strip()
    if "douyin_cookie" in data:
        config["douyin_cookie"] = (data.get("douyin_cookie") or "").strip()
    save_json(CONFIG_FILE, config)
    return jsonify({"ok": True,
                    "channels_cookie_set": bool(config.get("yuanbao_cookie")),
                    "douyin_cookie_set": bool(config.get("douyin_cookie"))})


def convert_local_file(jid, src_path, orig_name):
    """本地上传的视频/音频 -> MP3（视频号等无法解析时的万能兜底）"""
    try:
        jobs[jid].update(status="processing", progress=30, title=f"正在转换 {orig_name}…")
        mp3 = MUSIC_DIR / f"{jid}.mp3"
        r = subprocess.run(
            [FFMPEG, "-y", "-v", "error", "-i", str(src_path), "-vn",
             "-c:a", "libmp3lame", "-b:a", "192k", str(mp3)],
            capture_output=True, timeout=900,
        )
        if r.returncode != 0 or not mp3.exists():
            err = (r.stderr or b"").decode("utf-8", "ignore")[:200]
            raise RuntimeError(f"转换失败：{err or 'ffmpeg 执行异常'}")

        # 封面：优先源文件自带封面/首帧，其次音频内嵌
        cover = None
        cov = ICON_DIR / f"{jid}.jpg"
        try:
            subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(src_path), "-an",
                            "-frames:v", "1", "-q:v", "3", str(cov)],
                           capture_output=True, timeout=90)
            if cov.exists() and cov.stat().st_size > 1000:
                cover = f"{jid}.jpg"
        except Exception:
            pass
        if not cover:
            cover = extract_cover(mp3, jid)
        cover_bytes = None
        if cover:
            try:
                cover_bytes = (ICON_DIR / cover).read_bytes()
            except Exception:
                pass

        title = re.sub(r"\.[a-zA-Z0-9]{2,5}$", "", orig_name).strip() or "本地上传"
        title = re.sub(r"[_\s]+", " ", title)[:120]
        tag_mp3(mp3, title, "本地上传", cover_bytes)
        src_path.unlink(missing_ok=True)
        add_song(jid, title, "本地上传", 0, cover, "local:" + orig_name, "本地上传", mp3)
    except Exception as e:
        src_path.unlink(missing_ok=True)
        jobs[jid].update(status="error", error=str(e)[:300], platform="本地上传")


@app.post("/api/upload")
def api_upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "没有收到文件"}), 400
    jid = uuid.uuid4().hex[:12]
    raw = MUSIC_DIR / f"{jid}.upload"
    f.save(str(raw))
    if raw.stat().st_size < 1024:
        raw.unlink(missing_ok=True)
        return jsonify({"error": "文件为空或上传失败"}), 400

    jobs[jid] = {"id": jid, "status": "queued", "progress": 10,
                 "title": f"已上传 {f.filename}", "platform": "本地上传",
                 "url": "local"}

    def run():
        # 先探测时长做展示（ffprobe 用 ffmpeg 同目录）
        convert_local_file(jid, raw, f.filename)

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"jobs": [jid]})


@app.post("/api/download")
def api_download():
    data = request.json or {}
    raw = data.get("urls") or data.get("url") or ""
    if isinstance(raw, str):
        # 兼容抖音等「口令+链接」混合文本
        urls = re.findall(r"https?://[^\s，。！？、；：\"'<>（）()]+", raw)
        urls = [u.rstrip("),.;!?") for u in urls]
    else:
        urls = [str(u).strip() for u in raw if str(u).strip()]
    use_cookies = bool(data.get("cookies"))
    urls = [u for u in urls if u.startswith(("http://", "https://"))][:10]
    if not urls:
        return jsonify({"error": "请粘贴有效的 http/https 分享链接"}), 400
    out = []
    for u in urls:
        jid = uuid.uuid4().hex[:12]
        jobs[jid] = {"id": jid, "status": "queued", "progress": 0,
                     "title": "排队中…", "platform": guess_platform(u), "url": u}
        threading.Thread(target=do_download, args=(jid, u, use_cookies), daemon=True).start()
        out.append(jid)
    return jsonify({"jobs": out})


@app.get("/api/jobs")
def api_jobs():
    return jsonify(list(jobs.values()))


@app.get("/api/platform")
def api_platform():
    u = request.args.get("url", "")
    return jsonify({"platform": guess_platform(u)})


@app.get("/api/library")
def api_library():
    return jsonify(library)


@app.delete("/api/song/<sid>")
def api_delete(sid):
    global library
    (MUSIC_DIR / f"{sid}.mp3").unlink(missing_ok=True)
    library = [p for p in library if p["id"] != sid]
    save_json(LIB_FILE, library)
    return jsonify({"ok": True})


@app.get("/api/playlists")
def api_pl():
    return jsonify(playlists)


@app.post("/api/playlists")
def api_pl_create():
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "歌单名不能为空"}), 400
    playlists.append({"id": uuid.uuid4().hex[:8], "name": name, "songIds": []})
    save_json(PL_FILE, playlists)
    return jsonify({"ok": True})


@app.put("/api/playlists/<pid>")
def api_pl_update(pid):
    pl = next((p for p in playlists if p["id"] == pid), None)
    if not pl:
        return jsonify({"error": "歌单不存在"}), 404
    data = request.json or {}
    if "songIds" in data:
        pl["songIds"] = data["songIds"]
    if "name" in data:
        pl["name"] = data["name"]
    save_json(PL_FILE, playlists)
    return jsonify({"ok": True})


@app.delete("/api/playlists/<pid>")
def api_pl_delete(pid):
    global playlists
    playlists = [p for p in playlists if p["id"] != pid]
    save_json(PL_FILE, playlists)
    return jsonify({"ok": True})


@app.get("/api/audio/<sid>")
def api_audio(sid):
    f = MUSIC_DIR / f"{sid}.mp3"
    if not f.exists():
        return jsonify({"error": "文件不存在"}), 404
    return send_file(f, mimetype="audio/mpeg", conditional=True)


@app.get("/api/cover/<name>")
def api_cover(name):
    if name == "default":
        return send_from_directory("static", "default-cover.svg")
    f = ICON_DIR / name
    if not f.exists():
        return send_from_directory("static", "default-cover.svg")
    return send_file(f, mimetype="image/jpeg", max_age=86400)


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/<path:filename>")
def static_root(filename):
    resp = send_from_directory("static", filename)
    if filename == "sw.js":
        resp.headers["Service-Worker-Allowed"] = "/"
    return resp


if __name__ == "__main__":
    ip = get_local_ip()
    port = int(os.environ.get("PORT", 8770))
    print("=" * 52)
    print("  云乐 · 链接变音乐")
    print(f"  本机访问:   http://127.0.0.1:{port}")
    if port == 8770:
        print(f"  手机访问:   http://{ip}:{port}")
    print("=" * 52)
    app.run(host="0.0.0.0", port=port, threaded=True)
