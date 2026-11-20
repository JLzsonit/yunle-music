# -*- coding: utf-8 -*-
"""
云乐 CloudMusic-Box：本地音乐下载/播放服务
- 粘贴任意链接（抖音/B站/音乐网站/视频链接）→ yt-dlp 下载 → ffmpeg 转 MP3（含封面）
- 手机浏览器访问，可把歌曲「保存到手机」离线播放
启动：python server.py   端口 8770
"""
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory
from mutagen.mp3 import MP3

import yt_dlp

BASE = Path(__file__).resolve().parent
MUSIC_DIR = BASE / "music_library"
ICON_DIR = BASE / "static" / "covers"
MUSIC_DIR.mkdir(exist_ok=True)
ICON_DIR.mkdir(parents=True, exist_ok=True)
LIB_FILE = BASE / "library.json"
PL_FILE = BASE / "playlists.json"

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

app = Flask(__name__, static_folder="static", static_url_path="/static")

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
jobs = {}  # job_id -> {status, progress, title, error}


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def do_download(job_id, url, use_cookies):
    """后台线程：下载 → 转 MP3 → 提取封面 → 写入曲库"""
    try:
        jobs[job_id].update(status="downloading", progress=0, title="正在解析链接…")

        def hook(d):
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                done = d.get("downloaded_bytes", 0)
                pct = int(done / total * 90) if total else 0
                info = d.get("info_dict") or {}
                jobs[job_id].update(
                    progress=pct,
                    title=info.get("title") or jobs[job_id]["title"],
                    eta=d.get("eta"),
                    speed=d.get("speed"),
                )
            elif d["status"] == "finished":
                jobs[job_id].update(status="processing", progress=92, title="正在转换音频…")

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
            "retries": 3,
            "socket_timeout": 30,
        }
        if use_cookies:
            opts["cookiesfrombrowser"] = ("chrome",)

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)

        mp3 = MUSIC_DIR / f"{job_id}.mp3"
        if not mp3.exists():
            raise RuntimeError("转换后的 MP3 文件未找到，该链接可能不受支持")

        # 提取封面图
        cover_name = "default"
        try:
            cov = ICON_DIR / f"{job_id}.jpg"
            r = subprocess.run(
                [FFMPEG, "-y", "-v", "error", "-i", str(mp3), "-an",
                 "-frames:v", "1", "-q:v", "3", str(cov)],
                capture_output=True, timeout=60,
            )
            if r.returncode == 0 and cov.exists() and cov.stat().st_size > 1000:
                cover_name = f"{job_id}.jpg"
        except Exception:
            pass

        # 读取时长
        try:
            duration = int(MP3(str(mp3)).info.length)
        except Exception:
            duration = int(info.get("duration") or 0)

        song = {
            "id": job_id,
            "title": info.get("title") or "未知标题",
            "artist": info.get("uploader") or info.get("artist") or info.get("creator") or "未知歌手",
            "duration": duration,
            "cover": cover_name,
            "size": mp3.stat().st_size,
            "added": int(time.time()),
            "source": url,
        }
        library.insert(0, song)
        save_json(LIB_FILE, library)
        jobs[job_id].update(status="done", progress=100, title=song["title"], song_id=job_id)
    except Exception as e:
        msg = str(e)
        if len(msg) > 300:
            msg = msg[:300] + "…"
        jobs[job_id].update(status="error", error=msg)


@app.get("/api/info")
def api_info():
    return jsonify({"ip": get_local_ip(), "count": len(library)})


@app.post("/api/download")
def api_download():
    url = (request.json or {}).get("url", "").strip()
    use_cookies = bool((request.json or {}).get("cookies"))
    if not url.startswith(("http://", "https://")):
        return jsonify({"error": "请输入有效的 http/https 链接"}), 400
    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {"id": job_id, "status": "queued", "progress": 0, "title": "排队中…"}
    threading.Thread(target=do_download, args=(job_id, url, use_cookies), daemon=True).start()
    return jsonify({"job": job_id})


@app.get("/api/jobs")
def api_jobs():
    return jsonify(list(jobs.values()))


@app.get("/api/library")
def api_library():
    return jsonify(library)


@app.delete("/api/song/<sid>")
def api_delete(sid):
    global library
    for f in (MUSIC_DIR / f"{sid}.mp3",):
        if f.exists():
            f.unlink(missing_ok=True)
    for p in list(library):
        if p["id"] == sid:
            library.remove(p)
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
    """根路径静态文件：manifest.json / sw.js / icons/... 等（sw 必须在根作用域）"""
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
        print(f"  手机访问:   http://{ip}:8770")
        print("  (手机与电脑需在同一 Wi-Fi 下)")
    print("=" * 52)
    app.run(host="0.0.0.0", port=port, threaded=True)
