/* 云乐 - 前端逻辑 */
"use strict";

/* ---------- IndexedDB：手机本地曲库 ---------- */
const DB_NAME = "yunle", DB_STORE = "songs";
let db = null;
function openDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE, { keyPath: "id" });
    rq.onsuccess = () => { db = rq.result; res(db); };
    rq.onerror = () => rej(rq.error);
  });
}
const idb = {
  put: (o) => new Promise((res, rej) => {
    const t = db.transaction(DB_STORE, "readwrite");
    t.objectStore(DB_STORE).put(o);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  }),
  get: (id) => new Promise((res) => {
    const rq = db.transaction(DB_STORE).objectStore(DB_STORE).get(id);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
  }),
  del: (id) => new Promise((res) => {
    const t = db.transaction(DB_STORE, "readwrite");
    t.objectStore(DB_STORE).delete(id);
    t.oncomplete = res; t.onerror = res;
  }),
  all: () => new Promise((res) => {
    const rq = db.transaction(DB_STORE).objectStore(DB_STORE).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
  }),
};

/* ---------- 状态 ---------- */
const state = {
  library: [], playlists: [], offlineIds: new Set(),
  queue: [], pos: -1, playing: false,
  mode: localStorage.getItem("yl_mode") || "order", // order | loop | one | random
  currentJobSong: null, currentPl: null,
};
const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200);
}
const serverUrl = location.origin;
const coverUrl = (c) => `${serverUrl}/api/cover/${encodeURIComponent(c)}`;

/* ---------- 数据加载 ---------- */
async function loadLibrary() { state.library = await (await fetch("/api/library")).json(); }
async function loadPlaylists() { state.playlists = await (await fetch("/api/playlists")).json(); }

/* ---------- 曲库渲染 ---------- */
function songItemHtml(s, opts = {}) {
  const off = state.offlineIds.has(s.id);
  const playing = state.queue[state.pos] && state.queue[state.pos].id === s.id;
  return `<li class="song-item ${playing ? "playing" : ""}" data-id="${s.id}">
    <img class="song-cover" src="${coverUrl(s.cover)}" loading="lazy"
         onerror="this.src='static/default-cover.svg'">
    <div class="song-info">
      <div class="song-title">${esc(s.title)}</div>
      <div class="song-artist">${off ? '<span class="badge-offline">已存手机</span>' : ""}${esc(s.artist)} · ${fmt(s.duration)}</div>
    </div>
    <span class="song-dur">${fmt(s.duration)}</span>
    <button class="song-more" data-more="${s.id}">⋯</button>
  </li>`;
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function renderLibrary() {
  const q = $("searchInput").value.trim().toLowerCase();
  let list = state.library;
  if (q) list = list.filter((s) => (s.title + s.artist).toLowerCase().includes(q));
  $("songList").innerHTML = list.map((s) => songItemHtml(s)).join("");
  $("libEmpty").style.display = state.library.length ? "none" : "block";
  if (q && !list.length) $("libEmpty").innerHTML = `<div class="empty-icon">🔍</div><p>没有匹配「${esc(q)}」的歌曲</p>`;
  else $("libEmpty").innerHTML = `<div class="empty-icon">🎵</div><p>曲库还是空的</p><p class="sub">去「下载」页粘贴一个链接试试</p>`;
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
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  ["view-lib", "view-dl", "view-pl"].forEach((v) => $(v).hidden = v !== t.dataset.view);
}));

/* ---------- 下载 ---------- */
let jobTimer = null;
function pollJobs() {
  fetch("/api/jobs").then((r) => r.json()).then((jobs) => {
    const active = jobs.filter((j) => j.status !== "done" || Date.now() - 0 < 1e12);
    const recent = jobs.slice(-8);
    $("jobList").innerHTML = recent.map((j) => {
      let st = "", cls = "";
      if (j.status === "error") { st = `失败：${esc(j.error || "")}`; cls = "err"; }
      else if (j.status === "done") { st = "✓ 已加入曲库"; cls = "ok"; }
      else st = `${j.status === "queued" ? "排队中" : j.status === "processing" ? "转换音频中" : "下载中"} ${j.progress}%${j.speed ? " · " + fmtSpeed(j.speed) : ""}`;
      return `<li class="job-item"><div class="job-title">${esc(j.title)}</div>
        <div class="job-status ${cls}">${st}</div>
        ${j.status !== "done" && j.status !== "error" ? `<div class="progress"><i style="width:${j.progress}%"></i></div>` : ""}</li>`;
    }).join("");
    const busy = jobs.some((j) => ["queued", "downloading", "processing"].includes(j.status));
    if (busy) {
      if (!jobTimer) jobTimer = setInterval(pollJobs, 1500);
    } else { clearInterval(jobTimer); jobTimer = null; refreshAll(); }
  }).catch(() => {});
}
function fmtSpeed(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + "MB/s" : Math.round(b / 1024) + "KB/s"; }

$("downloadBtn").addEventListener("click", async () => {
  const url = $("urlInput").value.trim();
  if (!url) return toast("请先粘贴链接");
  $("downloadBtn").disabled = true;
  try {
    const r = await fetch("/api/download", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, cookies: $("cookieChk").checked }),
    });
    const data = await r.json();
    if (data.error) toast(data.error); else { toast("已开始下载"); $("urlInput").value = ""; pollJobs(); }
  } catch { toast("无法连接服务器"); }
  $("downloadBtn").disabled = false;
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
  await fetch(`/api/song/${sheetSong.id}`, { method: "DELETE" });
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
    await fetch(`/api/playlists/${pid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ songIds: pl.songIds }) });
    toast(`已添加到「${pl.name}」`); $("plSheetMask").hidden = true;
  };
});

/* ---------- 歌单 ---------- */
$("plCreateBtn").addEventListener("click", async () => {
  const name = $("plNameInput").value.trim(); if (!name) return toast("请输入歌单名");
  await fetch("/api/playlists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
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
    await fetch(`/api/playlists/${pl.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ songIds: pl.songIds }) });
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
  await fetch(`/api/playlists/${state.currentPl.id}`, { method: "DELETE" });
  await loadPlaylists(); renderPlaylists(); $("plSheetMask").hidden = true;
});
$("plSheetClose").addEventListener("click", () => { $("plSheetMask").hidden = true; renderPlaylists(); });
$("plSheetMask").addEventListener("click", (e) => { if (e.target === e.currentTarget) { e.currentTarget.hidden = true; renderPlaylists(); } });

/* ---------- 保存到手机（离线） ---------- */
async function saveOffline(s) {
  try {
    toast("正在保存到手机…");
    const r = await fetch(`/api/audio/${s.id}`);
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    let coverBlob = null;
    try { coverBlob = await (await fetch(coverUrl(s.cover))).blob(); } catch {}
    await idb.put({ id: s.id, blob, coverBlob, title: s.title, artist: s.artist, savedAt: Date.now() });
    state.offlineIds.add(s.id);
    renderLibrary();
    toast(`「${s.title}」已存到手机 ✓`);
  } catch { toast("保存失败，请检查网络"); }
}
$("cacheAllBtn").addEventListener("click", async () => {
  const todo = state.library.filter((s) => !state.offlineIds.has(s.id));
  if (!todo.length) return toast("全部歌曲都已在手机上");
  toast(`开始缓存 ${todo.length} 首…`);
  for (const s of todo) await saveOffline(s);
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
  return `${serverUrl}/api/audio/${s.id}`;
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
  const cover = state.offlineIds.has(s.id)
    ? (await idb.get(s.id))?.coverBlob && URL.createObjectURL((await idb.get(s.id)).coverBlob) || coverUrl(s.cover)
    : coverUrl(s.cover);
  $("miniCover").src = cover; $("fpCover").src = cover;
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

audio.addEventListener("play", () => { state.playing = true; $("miniPlayBtn").textContent = "⏸"; $("fpPlay").textContent = "⏸"; });
audio.addEventListener("pause", () => { state.playing = false; $("miniPlayBtn").textContent = "▶"; $("fpPlay").textContent = "▶"; });
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
    const off = await idb.all();
    state.offlineIds = new Set(off.map((o) => o.id).filter((id) => state.library.some((s) => s.id === id)));
    renderLibrary(); renderPlaylists();
  } catch { setOnline(false); }
}
(async function init() {
  setMode(state.mode);
  await openDB();
  await refreshAll();
  pollJobs();
})();
