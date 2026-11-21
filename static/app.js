/* 云乐 - 前端逻辑 */
"use strict";

/* ---------- IndexedDB：手机本地曲库 ---------- */
const DB_NAME = "yunle", DB_STORE = "songs";
let db = null;
function openDB() {
  return new Promise((res, rej) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(guard); fn(arg); } };
    const guard = setTimeout(() => finish(rej, new Error("IndexedDB 响应超时")), 3000);
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE, { keyPath: "id" });
    rq.onsuccess = () => { db = rq.result; finish(res, db); };
    rq.onerror = () => finish(rej, rq.error);
    rq.onblocked = () => finish(rej, new Error("IndexedDB 被占用"));
  });
}
/* IndexedDB 在个别 WebView / 无头环境下回调可能不触发，统一加超时兜底 */
const idbGuard = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), 2500))]);
const idb = {
  put: (o) => idbGuard(new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, "readwrite");
    t.objectStore(DB_STORE).put(o);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  })),
  get: (id) => idbGuard(new Promise((res) => {
    const rq = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
  })),
  del: (id) => idbGuard(new Promise((res) => {
    const t = db.transaction(DB_STORE, "readwrite");
    t.objectStore(DB_STORE).delete(id);
    t.oncomplete = res; t.onerror = res;
  })),
  all: () => idbGuard(new Promise((res) => {
    const rq = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
  })),
};

/* ---------- 状态 ---------- */
const state = {
  library: [], playlists: [], offlineIds: new Set(),
  queue: [], pos: -1, playing: false,
  mode: localStorage.getItem("yl_mode") || "order", // order | loop | one | random
  currentJobSong: null, currentPl: null,
  onlyOffline: false, serverOk: true,
};
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200);
}
/* 云端引擎地址：APK 壳内（本地界面）指向云端，网页版用同源 */
const REMOTE_SERVER = "https://yunle-music.app.workbuddy.host";
const IS_CAP = typeof window.Capacitor !== "undefined";
const serverUrl = IS_CAP ? REMOTE_SERVER : location.origin;
const SHARECODE = "YBAGATMDBV"; // 托管网关访问凭证，APK 内置页面必须随请求携带
const api = (p) => {
  if (!IS_CAP) return serverUrl + p;
  return serverUrl + p + (p.includes("?") ? "&" : "?") + "sharecode=" + SHARECODE;
};
const coverUrl = (c) => api(`/api/cover/${encodeURIComponent(c)}`);

/* ---------- 数据加载（服务器优先，离线时回退到手机本地库） ---------- */
async function loadLibrary() {
  try {
    state.library = await (await fetch(api("/api/library"))).json();
    state.serverOk = true;
  } catch (e) {
    // 服务器不可达：用手机本地已保存的歌曲构建曲库
    const off = await idb.all();
    state.library = off.map((o) => ({
      id: o.id, title: o.title, artist: o.artist, duration: o.duration || 0,
      cover: "default", size: 0, offlineOnly: true,
    }));
    state.serverOk = false;
    setOnline(false);
  }
}
async function loadPlaylists() {
  try { state.playlists = await (await fetch(api("/api/playlists"))).json(); }
  catch { state.playlists = state.playlists || []; }
}

/* ---------- 曲库渲染 ---------- */
function songItemHtml(s, opts = {}) {
  const off = state.offlineIds.has(s.id);
  const playing = state.queue[state.pos] && state.queue[state.pos].id === s.id;
  const plat = s.platform && s.platform !== "通用" ? s.platform : "";
  return `<li class="song-item ${playing ? "playing" : ""}" data-id="${s.id}">
    <img class="song-cover" src="${coverUrl(s.cover)}" loading="lazy"
         onerror="this.src='static/default-cover.svg'">
    <div class="song-info">
      <div class="song-title">${esc(s.title)}</div>
      <div class="song-artist">${off ? '<span class="badge-offline">已存手机</span>' : ""}${esc(s.artist)}${plat ? " · " + esc(plat) : ""}${s.duration ? " · " + fmt(s.duration) : ""}</div>
    </div>
    <button class="song-more" data-more="${s.id}">⋯</button>
  </li>`;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function renderLibrary() {
  const q = $("searchInput").value.trim().toLowerCase();
  let list = state.library;
  if (state.onlyOffline) list = list.filter((s) => state.offlineIds.has(s.id));
  if (q) list = list.filter((s) => (s.title + s.artist).toLowerCase().includes(q));
  $("songList").innerHTML = list.map((s) => songItemHtml(s)).join("");
  $("libEmpty").style.display = state.library.length ? "none" : "block";
  if (q && !list.length) $("libEmpty").innerHTML = `<div class="empty-icon">🔍</div><p>没有匹配「${esc(q)}」的歌曲</p>`;
  else $("libEmpty").innerHTML = `<div class="empty-icon">🎵</div><p>曲库还是空的</p><p class="sub">粘贴一个链接，把它变成音乐</p><button id="goDlBtn" class="btn primary cta">＋ 去下载音乐</button>`;
  $("offlineStat").textContent = state.library.length ? `${state.offlineIds.size}/${state.library.length} 已离线` : "";
}

function renderPlaylists() {
  $("plList").innerHTML = state.playlists.map((p) => `<li class="pl-item" data-pl="${p.id}">
    <div class="pl-icon">📂</div>
    <div class="song-info"><div class="song-title">${esc(p.name)}</div>
    <div class="pl-count">${p.songIds.length} 首</div></div></li>`).join("");
  $("plEmpty").style.display = state.playlists.length ? "none" : "block";
}

/* ---------- Tab 切换 ---------- */
function switchView(id) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.view === id));
  ["view-lib", "view-dl", "view-pl"].forEach((v) => $(v).hidden = v !== id);
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
$("libEmpty").addEventListener("click", (e) => { if (e.target.closest("#goDlBtn")) switchView("view-dl"); });

/* ---------- 下载（支持多链接批量） ---------- */
let jobTimer = null;
let dlActive = false;       // 本次提交后才有状态反馈，避免启动时被历史任务干扰
let dlSeenError = "";
function setDlStatus(text, kind, pct) {
  const box = $("dlStatus");
  if (!box) return;
  box.hidden = !text;
  box.className = "dl-status" + (kind ? " " + kind : "");
  $("dlStatusText").textContent = text || "";
  const bar = $("dlBarWrap");
  if (pct === undefined || pct === null) bar.hidden = true;
  else { bar.hidden = false; $("dlBar").style.width = Math.max(0, Math.min(100, pct)) + "%"; }
}
function pollJobs() {
  fetch(api("/api/jobs")).then((r) => r.json()).then((jobs) => {
    $("jobGroup").hidden = !jobs.length;
    const recent = jobs.slice(-10).reverse();
    $("jobList").innerHTML = recent.map((j) => {
      let st = "", cls = "";
      if (j.status === "error") { st = `✗ ${esc(j.error || "失败")}`; cls = "err"; }
      else if (j.status === "done") { st = "✓ 已加入曲库"; cls = "ok"; }
      else {
        const label = j.status === "queued" ? "排队中" : j.status === "processing" ? "转换音频中" : "下载中";
        st = `${label} ${j.progress}%${j.speed ? " · " + fmtSpeed(j.speed) : ""}${j.stage ? " · " + esc(j.stage) : ""}`;
      }
      return `<li class="job-item"><div class="job-title">${j.platform ? `<span class="plat-tag">${esc(j.platform)}</span>` : ""}${esc(j.title)}</div>
        <div class="job-status ${cls}">${st}</div>
        ${j.status !== "done" && j.status !== "error" ? `<div class="progress"><i style="width:${j.progress}%"></i></div>` : ""}</li>`;
    }).join("");

    const busy = jobs.filter((j) => ["queued", "downloading", "processing"].includes(j.status));
    const errs = jobs.filter((j) => j.status === "error");
    if (busy.length) {
      const top = busy[busy.length - 1];
      const label = top.status === "queued" ? "排队中" : top.status === "processing" ? "转换音频中" : "下载中";
      const extra = busy.length > 1 ? `（共 ${busy.length} 个任务）` : "";
      setDlStatus(`${label}：${esc(top.title || "正在解析链接")} · ${top.progress}%${top.stage ? " · " + esc(top.stage) : ""}${extra}`, "run", top.progress);
      if (!jobTimer) jobTimer = setInterval(pollJobs, 1200);
    } else {
      clearInterval(jobTimer); jobTimer = null;
      if (dlActive) {
        dlActive = false;
        if (errs.length) {
          const e = errs.slice(-1)[0];
          setDlStatus(e.error || "下载失败", "err");
          if (dlSeenError !== e.id) {
            dlSeenError = e.id;
            toast("下载失败，请看上方红字说明");
            if (/cookie|Cookie|元宝/i.test(e.error || "")) {
              const p = $("wxPanel"); if (p) p.open = true;
              p?.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }
        } else if (jobs.length) {
          setDlStatus("✓ 下载完成，已加入曲库", "ok");
          toast("下载完成，已加入曲库");
        }
      }
      refreshAll();
    }
  }).catch(() => {
    clearInterval(jobTimer); jobTimer = null;
    if (dlActive) { dlActive = false; setDlStatus("连接服务器失败，请检查网络后重试", "err"); }
  });
}
function fmtSpeed(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + "MB/s" : Math.round(b / 1024) + "KB/s"; }

$("downloadBtn").addEventListener("click", async () => {
  const raw = $("urlInput").value.trim();
  if (!raw) return toast("请先粘贴链接");
  const urls = raw.split(/[\n\r\s]+/).filter((u) => /^https?:\/\//.test(u)).slice(0, 10);
  if (!urls.length) return toast("没有识别到有效链接");
  const wxLinks = urls.filter((u) => /channels\.weixin\.qq\.com|weixin\.qq\.com\/sph|finder\.video\.qq\.com/.test(u));
  if (wxLinks.length && !$("wxBadge").classList.contains("on")) {
    const p = $("wxPanel");
    if (p) p.open = true;
    $("wxPanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    setDlStatus("视频号链接需要先配置「元宝 Cookie」：按下面 4 步复制 Cookie 保存后，再点开始下载。", "err");
    toast("视频号需要先配置一次元宝 Cookie");
    return;
  }
  $("downloadBtn").disabled = true;
  $("downloadBtn").textContent = "提交中…";
  dlActive = true;
  setDlStatus(`正在提交 ${urls.length} 个链接…`, "run", 0);
  $("dlStatus")?.scrollIntoView({ behavior: "smooth", block: "center" });
  try {
    const r = await fetch(api("/api/download"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, cookies: $("cookieChk").checked }),
    });
    const txt = await r.text();
    let data = null;
    try { data = JSON.parse(txt); } catch {}
    if (!r.ok || !data) {
      dlActive = false;
      setDlStatus(`提交失败（HTTP ${r.status}）` + (r.status === 403 ? "：当前安装的是旧版应用，请安装最新版 APK" : "：请稍后重试"), "err");
      toast("提交失败，请看上方提示");
    } else if (data.error) {
      dlActive = false;
      setDlStatus(data.error, "err");
      toast(data.error);
    } else {
      $("urlInput").value = "";
      setDlStatus(`已提交 ${urls.length} 个链接，正在解析…`, "run", 2);
      pollJobs();
    }
  } catch {
    dlActive = false;
    setDlStatus("无法连接服务器，请检查网络（或确认已安装最新版 APK）", "err");
    toast("无法连接服务器");
  }
  $("downloadBtn").disabled = false;
  $("downloadBtn").textContent = "开始下载";
});
$("pasteBtn").addEventListener("click", async () => {
  try { $("urlInput").value = await navigator.clipboard.readText(); toast("已粘贴"); }
  catch { toast("请长按输入框手动粘贴"); }
});

/* ---------- 歌曲操作菜单 ---------- */
let sheetSong = null;
$("songList").addEventListener("click", (e) => {
  const more = e.target.closest("[data-more]");
  const item = e.target.closest(".song-item");
  if (!item) return;
  const id = more ? more.dataset.more : item.dataset.id;
  const s = state.library.find((x) => x.id === id);
  if (!s) return;
  if (more) { sheetSong = s; openSongSheet(s); }
  else playSong(s);
});
$("songSheetClose").addEventListener("click", () => $("songSheetMask").hidden = true);
$("songSheetMask").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
function openSongSheet(s) {
  $("songSheetTitle").textContent = s.title;
  $("actSave").textContent = state.offlineIds.has(s.id) ? "✓ 已保存到手机（重新下载）" : "⬇ 保存到手机（离线可听）";
  $("songSheetMask").hidden = false;
}
$("actSave").addEventListener("click", async () => { await saveOffline(sheetSong); $("songSheetMask").hidden = true; });
$("actDelete").addEventListener("click", async () => {
  if (!confirm(`确定从曲库删除「${sheetSong.title}」？（手机已存的离线副本会保留）`)) return;
  await fetch(api(`/api/song/${sheetSong.id}`), { method: "DELETE" });
  state.library = state.library.filter((s) => s.id !== sheetSong.id);
  renderLibrary(); $("songSheetMask").hidden = true; toast("已删除");
});
$("actPlayNext").addEventListener("click", () => {
  if (state.pos < 0) { playSong(sheetSong); } else {
    state.queue.splice(state.pos + 1, 0, sheetSong); toast("已设为下一首");
  }
  $("songSheetMask").hidden = true;
});
$("actAddPl").addEventListener("click", () => {
  $("plAddSelect").innerHTML = state.playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")
    || `<option value="">先创建一个歌单</option>`;
  $("songSheetMask").hidden = true;
  $("plSheetMask").hidden = false; $("plSheetTitle").textContent = "添加到歌单";
  $("plSongList").innerHTML = ""; $("plAddBtn").onclick = null; state.currentPl = null;
  $("plAddBtn").onclick = async () => {
    const pid = $("plAddSelect").value; if (!pid) return toast("先创建一个歌单");
    const pl = state.playlists.find((p) => p.id === pid);
    if (!pl.songIds.includes(sheetSong.id)) pl.songIds.push(sheetSong.id);
    await fetch(api(`/api/playlists/${pid}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ songIds: pl.songIds }) });
    toast(`已添加到「${pl.name}」`); $("plSheetMask").hidden = true;
  };
});

/* ---------- 歌单 ---------- */
$("plCreateBtn").addEventListener("click", async () => {
  const name = $("plNameInput").value.trim(); if (!name) return toast("请输入歌单名");
  await fetch(api("/api/playlists"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  $("plNameInput").value = ""; await loadPlaylists(); renderPlaylists(); toast("已创建");
});
$("plList").addEventListener("click", (e) => {
  const li = e.target.closest("[data-pl]"); if (!li) return;
  openPlSheet(state.playlists.find((p) => p.id === li.dataset.pl));
});
function openPlSheet(pl) {
  state.currentPl = pl;
  $("plSheetTitle").textContent = pl.name;
  const songs = pl.songIds.map((id) => state.library.find((s) => s.id === id)).filter(Boolean);
  $("plSongList").innerHTML = songs.map((s) => songItemHtml(s)).join("") || `<div class="empty"><p>歌单是空的，从下方添加歌曲</p></div>`;
  $("plAddSelect").innerHTML = state.library.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join("");
  $("plSheetMask").hidden = false;
  $("plAddBtn").onclick = async () => {
    const sid = $("plAddSelect").value; if (!sid) return;
    if (!pl.songIds.includes(sid)) pl.songIds.push(sid);
    await fetch(api(`/api/playlists/${pl.id}`), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ songIds: pl.songIds }) });
    openPlSheet(pl); toast("已添加");
  };
}
$("plSongList").addEventListener("click", (e) => {
  const item = e.target.closest(".song-item"); if (!item || !state.currentPl) return;
  const s = state.library.find((x) => x.id === item.dataset.id); if (s) playSong(s);
});
$("plPlayBtn").addEventListener("click", () => {
  const songs = state.currentPl.songIds.map((id) => state.library.find((s) => s.id === id)).filter(Boolean);
  if (!songs.length) return toast("歌单是空的");
  state.queue = [...songs]; state.pos = 0; loadAndPlay();
  $("plSheetMask").hidden = true;
});
$("plDeleteBtn").addEventListener("click", async () => {
  if (!confirm(`删除歌单「${state.currentPl.name}」？（不影响歌曲本身）`)) return;
  await fetch(api(`/api/playlists/${state.currentPl.id}`), { method: "DELETE" });
  await loadPlaylists(); renderPlaylists(); $("plSheetMask").hidden = true;
});
$("plSheetClose").addEventListener("click", () => { $("plSheetMask").hidden = true; renderPlaylists(); });
$("plSheetMask").addEventListener("click", (e) => { if (e.target === e.currentTarget) { e.currentTarget.hidden = true; renderPlaylists(); } });

/* ---------- 保存到手机（离线） ---------- */
async function saveOffline(s) {
  try {
    toast("正在保存到手机…");
    const r = await fetch(api(`/api/audio/${s.id}`));
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    let coverBlob = null;
    try { coverBlob = await (await fetch(coverUrl(s.cover))).blob(); } catch {}
    await idb.put({
      id: s.id, blob, coverBlob, title: s.title, artist: s.artist,
      duration: s.duration || 0, platform: s.platform || "", savedAt: Date.now(),
    });
    state.offlineIds.add(s.id);
    renderLibrary();
    toast(`「${s.title}」已存到手机 ✓`);
  } catch { toast("保存失败，请检查网络"); }
}
$("cacheAllBtn").addEventListener("click", async () => {
  const todo = state.library.filter((s) => !state.offlineIds.has(s.id) && !s.offlineOnly);
  if (!todo.length) return toast("全部歌曲都已在手机上");
  toast(`开始缓存 ${todo.length} 首…`);
  for (const s of todo) await saveOffline(s);
});
$("offlineFilterBtn").addEventListener("click", () => {
  state.onlyOffline = !state.onlyOffline;
  $("offlineFilterBtn").textContent = state.onlyOffline ? "只看离线 ✓" : "只看离线";
  $("offlineFilterBtn").classList.toggle("on", state.onlyOffline);
  renderLibrary();
});

/* ---------- 播放器核心 ---------- */
const audio = new Audio();
audio.volume = 1;

function curSong() { return state.queue[state.pos] || null; }

async function songSource(s) {
  if (state.offlineIds.has(s.id)) {
    const rec = await idb.get(s.id);
    if (rec) return URL.createObjectURL(rec.blob);
  }
  return api(`/api/audio/${s.id}`);
}

async function coverFor(s) {
  if (state.offlineIds.has(s.id)) {
    const rec = await idb.get(s.id);
    if (rec && rec.coverBlob) return URL.createObjectURL(rec.coverBlob);
  }
  return coverUrl(s.cover);
}

async function loadAndPlay() {
  const s = curSong();
  if (!s) return;
  audio.src = await songSource(s);
  audio.play().catch(() => toast("播放失败"));
  $("miniTitle").textContent = s.title;
  $("miniArtist").textContent = s.artist;
  $("fpTitle").textContent = s.title;
  $("fpArtist").textContent = s.artist;
  const cover = await coverFor(s);
  $("miniCover").src = cover; $("fpCover").src = cover;
  // 有歌在播时显示迷你播放条
  const mp = $("miniPlayer");
  mp.hidden = false; mp.classList.add("show");
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title, artist: s.artist, album: "云乐",
      artwork: [{ src: cover, sizes: "512x512", type: "image/jpeg" }],
    });
  }
  renderLibrary();
}

function playSong(s) {
  const idx = state.queue.findIndex((x) => x.id === s.id && state.queue[state.pos] !== x);
  if (state.queue[state.pos] && state.queue[state.pos].id === s.id) { togglePlay(); return; }
  if (idx >= 0 && idx < state.queue.length) state.pos = idx;
  else { state.queue.splice(state.pos + 1, 0, s); state.pos++; }
  loadAndPlay();
}
function togglePlay() {
  if (!curSong()) { if (state.library.length) { state.queue = [...state.library]; state.pos = 0; loadAndPlay(); } return; }
  audio.paused ? audio.play() : audio.pause();
}
function nextSong(auto) {
  if (!state.queue.length) return;
  if (state.mode === "one" && auto) { audio.currentTime = 0; audio.play(); return; }
  if (state.mode === "random") { state.pos = Math.floor(Math.random() * state.queue.length); }
  else if (state.pos + 1 >= state.queue.length) {
    if (!auto && state.mode !== "loop") return;
    state.pos = 0;
  } else state.pos++;
  loadAndPlay();
}
function prevSong() {
  if (!state.queue.length) return;
  state.pos = state.pos > 0 ? state.pos - 1 : state.queue.length - 1;
  loadAndPlay();
}

const MODES = { order: ["🔁", "顺序播放"], loop: ["🔂", "列表循环"], one: ["1️⃣", "单曲循环"], random: ["🔀", "随机播放"] };
function setMode(m) {
  state.mode = m; localStorage.setItem("yl_mode", m);
  $("miniModeBtn").textContent = MODES[m][0];
  $("fpModeBtn").textContent = `${MODES[m][0]} ${MODES[m][1]}`;
  $("fpModeLabel").textContent = MODES[m][1];
}
$("miniModeBtn").addEventListener("click", () => cycleMode());
$("fpModeBtn").addEventListener("click", () => cycleMode());
function cycleMode() {
  const keys = Object.keys(MODES);
  setMode(keys[(keys.indexOf(state.mode) + 1) % keys.length]);
}

$("miniPlayBtn").addEventListener("click", togglePlay);
$("fpPlay").addEventListener("click", togglePlay);
$("miniNextBtn").addEventListener("click", () => nextSong(false));
$("fpNext").addEventListener("click", () => nextSong(false));
$("fpPrev").addEventListener("click", prevSong);

const ICON_PLAY = '<svg viewBox="0 0 24 24" style="width:1em;height:1em;fill:currentColor"><path d="M6.5 4.7c0-1 1.1-1.6 1.9-1.1l12 6.6c.9.5.9 1.8 0 2.3l-12 6.9c-.8.5-1.9-.1-1.9-1.1V4.7Z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" style="width:1em;height:1em;fill:currentColor"><rect x="5" y="3.5" width="5" height="17" rx="1.6"/><rect x="14" y="3.5" width="5" height="17" rx="1.6"/></svg>';
audio.addEventListener("play", () => { state.playing = true; $("miniPlayBtn").innerHTML = ICON_PAUSE; $("fpPlay").innerHTML = ICON_PAUSE; });
audio.addEventListener("pause", () => { state.playing = false; $("miniPlayBtn").innerHTML = ICON_PLAY; $("fpPlay").innerHTML = ICON_PLAY; });
audio.addEventListener("ended", () => nextSong(true));
audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  $("fpCur").textContent = fmt(audio.currentTime);
  $("fpDur").textContent = fmt(audio.duration);
  if (!$("fpSeek").matches(":active")) $("fpSeek").value = Math.round(audio.currentTime / audio.duration * 1000);
});
$("fpSeek").addEventListener("input", () => {
  if (audio.duration) audio.currentTime = $("fpSeek").value / 1000 * audio.duration;
});
$("fpVol").addEventListener("input", () => audio.volume = $("fpVol").value / 100);

$("miniPlayer").addEventListener("click", (e) => { if (!e.target.closest(".ctl")) { $("fullPlayer").hidden = false; } });
$("fpClose").addEventListener("click", () => $("fullPlayer").hidden = true);

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", prevSong);
  navigator.mediaSession.setActionHandler("nexttrack", () => nextSong(false));
}

/* ---------- 在线/离线状态 ---------- */
function setOnline(on) {
  $("netBadge").classList.toggle("off", !on);
  $("netBadge").querySelector("span").textContent = on ? "在线" : "离线模式";
}
window.addEventListener("online", () => setOnline(true));
window.addEventListener("offline", () => setOnline(false));
setOnline(navigator.onLine);

/* ---------- 搜索 ---------- */
$("searchInput").addEventListener("input", renderLibrary);

/* ---------- Service Worker ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- 初始化 ---------- */
async function refreshAll() {
  try {
    await loadLibrary(); await loadPlaylists();
    const off = (await idb.all()) || [];
    state.offlineIds = new Set(off.map((o) => o.id).filter((id) => state.library.some((s) => s.id === id)));
    renderLibrary(); renderPlaylists();
  } catch { setOnline(false); }
}
(async function init() {
  setMode(state.mode);
  // 支持 ?view=dl / view=pl 直接落到指定标签页（先切视图，避免后面步骤失败挡住导航）
  const vMap = { lib: "view-lib", dl: "view-dl", pl: "view-pl" };
  const v = vMap[new URLSearchParams(location.search).get("view")]
         || new URLSearchParams(location.search).get("view");
  if (v && ["view-lib", "view-dl", "view-pl"].includes(v)) switchView(v);
  try { await openDB(); } catch {}
  await refreshAll();
  await loadWxConfig();
  pollJobs();
})().catch((e) => {
  document.title = "INIT_ERR: " + (e && e.message || e);
  toast("初始化异常：" + (e && e.message || e));
});

/* ---------- 视频号 Cookie 设置 ---------- */
async function loadWxConfig() {
  try {
    const c = await (await fetch(api("/api/config"))).json();
    setWxBadge(c.channels_cookie_set, c.channels_cookie_preview);
  } catch {}
}
function setWxBadge(on, preview) {
  const b = $("wxBadge");
  if (!b) return;
  b.textContent = on ? "已配置 ✓" : "未配置";
  b.classList.toggle("on", !!on);
  if (on && preview) $("wxStatus").textContent = "当前：" + preview;
}
$("wxSaveBtn")?.addEventListener("click", async () => {
  const v = ($("wxCookieInput").value || "").trim();
  if (!v) return toast("请先粘贴 Cookie");
  try {
    const r = await fetch(api("/api/config"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yuanbao_cookie: v }),
    });
    const d = await r.json();
    if (d.channels_cookie_set) {
      $("wxCookieInput").value = "";
      $("wxStatus").textContent = "已保存，现在可以下载视频号了 ✓";
      $("wxStatus").className = "wx-status ok";
      setWxBadge(true, "");
      toast("视频号解析已启用");
    } else toast("保存失败");
  } catch { toast("无法连接服务器"); }
});
$("wxClearBtn")?.addEventListener("click", async () => {
  try {
    await fetch(api("/api/config"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yuanbao_cookie: "" }),
    });
    setWxBadge(false);
    $("wxStatus").textContent = "已清除";
    $("wxStatus").className = "wx-status";
  } catch {}
});

/* ---------- 上传本地视频/音频（万能兜底） ---------- */
$("uploadBtn")?.addEventListener("click", () => $("fileInput").click());
$("fileInput")?.addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const mb = (f.size / 1048576).toFixed(1);
  toast(`正在上传 ${f.name}（${mb}MB）…`);
  const fd = new FormData();
  fd.append("file", f);
  dlActive = true;
  setDlStatus(`正在上传 ${f.name}（${mb}MB）…`, "run", 5);
  $("dlStatus")?.scrollIntoView({ behavior: "smooth", block: "center" });
  try {
    const r = await fetch(api("/api/upload"), { method: "POST", body: fd });
    const d = await r.json();
    if (d.error) { dlActive = false; setDlStatus(d.error, "err"); toast(d.error); }
    else { setDlStatus("上传成功，正在转换为 MP3…", "run", 20); pollJobs(); }
  } catch {
    dlActive = false;
    setDlStatus("上传失败：请检查网络或文件大小", "err");
    toast("上传失败，检查网络或文件大小");
  }
  e.target.value = "";
});

