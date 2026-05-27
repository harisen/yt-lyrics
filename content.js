// YT Lyrics - content script

const PANEL_ID = 'yt-lyrics-panel';
const LRCLIB_BASE = 'https://lrclib.net/api';

let currentVideoId = null;
let lrcLines = [];
let syncTimer = null;
let focusMode = false;
let tapSyncMode = false;
window.__ytlOffset = 0;

// page-bridge.js (MAIN world) が ytInitialPlayerResponse から抽出した
// captionTracks を DOM属性またはカスタムイベント経由で受信する
let capturedCaptionTracks = null;
// 初回ロード時: page-bridge.js が document_start で保存済みの DOM属性を読む
try {
  const stored = document.documentElement.dataset.ytlCaptionCache;
  if (stored) capturedCaptionTracks = JSON.parse(stored);
} catch (_) {}
// SPA遷移後: カスタムイベントで受信（リスナーが登録済みの場合）
document.addEventListener('ytl-captions', (e) => {
  try { if (e.detail?.videoId && e.detail?.tracks) capturedCaptionTracks = e.detail; } catch (_) {}
});

// page-bridge.js が MAIN world から fetch した字幕本文（クッキー付きで取得済み）
let capturedCaptionsData = null;
try {
  const stored = document.documentElement.dataset.ytlCaptionsData;
  if (stored) capturedCaptionsData = JSON.parse(stored);
} catch (_) {}
document.addEventListener('ytl-captions-data', (e) => {
  try { if (e.detail?.videoId && e.detail?.text) capturedCaptionsData = e.detail; } catch (_) {}
});

// ── ユーティリティ ────────────────────────────────────────────
function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ── LRC パーサー ──────────────────────────────────────────────
function parseLrc(lrcText) {
  const lines = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
  let match;
  while ((match = regex.exec(lrcText)) !== null) {
    const min = parseInt(match[1]);
    const sec = parseInt(match[2]);
    const ms = parseInt(match[3].padEnd(3, '0'));
    const time = min * 60 + sec + ms / 1000;
    const text = match[4].trim();
    if (text) lines.push({ time, text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

// ── 動画情報の取得 ─────────────────────────────────────────────
function getVideoDescription() {
  // 概要欄を可能な範囲で取得（クレジット表記抽出に使う）
  const selectors = [
    '#description-inline-expander yt-attributed-string',
    'ytd-text-inline-expander yt-attributed-string',
    '#description yt-formatted-string',
    '#description-inline-expander',
    '#description',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim() || '';
    if (text.length >= 20) return text.slice(0, 2000);
  }
  return '';
}

function getVideoInfo() {
  const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.style-scope.ytd-watch-metadata');
  const channelEl = document.querySelector('ytd-channel-name yt-formatted-string a, #channel-name a');
  const videoEl = document.querySelector('video.html5-main-video');
  return {
    title: titleEl?.textContent?.trim() || '',
    artist: channelEl?.textContent?.trim() || '',
    duration: videoEl?.duration || 0,
    description: getVideoDescription(),
  };
}

// ── タイトル/概要欄から検索候補を生成（信頼度スコア付き）──────
// 戻り値: [{ trackName, artistName, confidence: 1-5 }, ...]
//   5 = 確信（説明欄明示クレジット）
//   4 = 高（「」鉤括弧 or 区切り+チャンネル名一致）
//   3 = 中高（区切りで一方向のみチャンネル一致）
//   2 = 中（区切りあり・方向不明）
//   1 = 低（フォールバック）
function buildSearchCandidates(rawTitle, channelArtist, description = '') {
  // ── チャンネル名の正規化（公式/Records/Music 等を除去 + 区切り分割）──
  const ch = channelArtist.replace(/\s*[-–—]\s*Topic$/i, '').trim();

  const stripChSuffix = (s) => s
    .replace(/\s*[【\(\[]?\s*(?:公式|オフィシャル|Official|OFFICIAL)(?:\s+(?:Channel|チャンネル))?\s*[】\)\]]?\s*$/i, '')
    .replace(/\s+(?:Music|Records|Channel|Ch\.?)\s*$/i, '')
    .trim();

  const chClean = stripChSuffix(ch);
  // "なとり / natori" → ["なとり", "natori"] のように分割
  const chParts = ch.split(/[\/／\|｜　・]+/).map(s => stripChSuffix(s.trim())).filter(Boolean);
  const allChNames = [...new Set([ch, chClean, ...chParts])].filter(s => s.length >= 2);

  // ── ノイズ除去 ──
  const clean = (s) => s
    .replace(/\s*[(\[（【〔〈《「『][^)\]）】〕〉》」』]*[)\]）】〕〉》」』]\s*/g, ' ')
    .replace(/\s*[-–—]\s*(?:official\s+(?:music\s+video|lyric\s+video|mv|pv|audio|video)|music\s+video|lyric\s+video|mv|pv|audio|video)(?:\s|$)/gi, ' ')
    .replace(/\s+(?:official\s+(?:music\s+video|lyric\s+video|mv|pv|audio|video)|music\s+video|lyric\s+video|official|mv|pv)\s*/gi, ' ')
    .replace(/^[A-Z]?\d+[.\s]+/, '')
    .replace(/\s*[-–—|｜\/／]\s*$/, '')
    .replace(/\s+/g, ' ').trim();

  const stripFeat = (s) => s.replace(/\s+(?:feat\.?|ft\.?|with)\s+.+$/i, '').trim();

  // 文字列が任意のチャンネル名バリエーションと一致 or 前方一致
  const matchesCh = (s) => {
    const sl = (s || '').toLowerCase().trim();
    if (!sl || sl.length < 2) return false;
    return allChNames.some(c => {
      const cl = c.toLowerCase();
      return sl === cl ||
             cl.startsWith(sl + ' ') || cl.startsWith(sl + '/') || cl.startsWith(sl + '　') || cl.startsWith(sl + '・') ||
             sl.startsWith(cl + ' ') || sl.startsWith(cl + '/');
    });
  };

  // ── 候補リスト（信頼度マップ）──
  const candidates = [];
  const seen = new Map();
  const add = (track, artist, conf = 2) => {
    track = (track || '').trim();
    artist = (artist || '').trim();
    if (!track || track === artist) return;
    if (/^(?:mv|pv|music\s*video|official|audio|lyric\s*video)$/i.test(track)) return;
    const key = `${track.toLowerCase()}|${artist.toLowerCase()}`;
    if (seen.has(key)) {
      const existing = seen.get(key);
      if (conf > existing.confidence) existing.confidence = conf;
      return;
    }
    const entry = { trackName: track, artistName: artist, confidence: conf };
    seen.set(key, entry);
    candidates.push(entry);
  };

  const tryBothDirs = (left, right, baseConf = 2) => {
    if (!left || !right) return;
    const cl = clean(left);
    const cr = clean(right);
    const leftMatchesCh = matchesCh(cl);
    const rightMatchesCh = matchesCh(cr);
    if (leftMatchesCh && !rightMatchesCh) {
      // left=artist 確定 → right=track 高信頼
      add(cr, left, baseConf + 2);
      add(cr, ch, baseConf + 2);
      add(stripFeat(cr), left, baseConf + 2);
    } else if (rightMatchesCh && !leftMatchesCh) {
      // right=artist 確定 → left=track 高信頼
      add(cl, right, baseConf + 2);
      add(cl, ch, baseConf + 2);
      add(stripFeat(cl), right, baseConf + 2);
    } else {
      // 方向不明 → 両方向で中信頼
      add(cl, cr, baseConf);
      add(stripFeat(cl), cr, baseConf);
      add(cl, ch, baseConf);
      add(cr, cl, baseConf);
      add(cr, ch, baseConf);
    }
  };

  const base = clean(rawTitle);
  const baseNoFeat = stripFeat(base);

  // ── A: 鉤括弧「」『』 = 高信頼度 track ──
  const bracketM = rawTitle.match(/[「『](.+?)[」』]/);
  if (bracketM) {
    const track = bracketM[1].trim();
    const idx = rawTitle.indexOf(bracketM[0]);
    const rawBefore = rawTitle.slice(0, idx).replace(/\s*[-–—\/｜|]\s*$/, '').trim();
    const rawAfter = rawTitle.slice(idx + bracketM[0].length).replace(/^\s*[-–—\/｜|]\s*/, '').trim();
    const artistBefore = rawBefore ? clean(rawBefore) : '';
    const artistAfter = rawAfter ? clean(rawAfter) : '';
    const bestArtist = artistBefore || artistAfter || ch;
    // チャンネル名一致 → 最高確信度4
    const conf = (matchesCh(bestArtist) || matchesCh(artistBefore) || matchesCh(artistAfter)) ? 4 : 4;
    add(track, bestArtist, conf);
    add(track, ch, conf);
    add(stripFeat(track), bestArtist, conf);
  }

  // ── B: ダッシュ [-–—] 区切り ──
  const dashParts = base.split(/\s[-–—]\s/).map(s => s.trim()).filter(Boolean);
  if (dashParts.length >= 2) {
    tryBothDirs(dashParts[0], dashParts[dashParts.length - 1], 2);
    if (dashParts.length >= 3) {
      add(dashParts[1], dashParts[0], 2);
      add(dashParts[1], dashParts[dashParts.length - 1], 2);
      add(dashParts[1], ch, 2);
    }
  }

  // ── C: スラッシュ [/／] 区切り ──
  const slashParts = base.split(/\s*[\/／]\s*/).map(s => s.trim()).filter(Boolean);
  if (slashParts.length === 2) tryBothDirs(slashParts[0], slashParts[1], 2);

  // ── D: パイプ [|｜] 区切り ──
  const pipeParts = base.split(/\s*[|｜]\s*/).map(s => s.trim()).filter(Boolean);
  if (pipeParts.length === 2) tryBothDirs(pipeParts[0], pipeParts[1], 2);

  // ── E: 全角コロン [：] 区切り ──
  const colonParts = base.split(/\s*：\s*/).map(s => s.trim()).filter(Boolean);
  if (colonParts.length === 2) tryBothDirs(colonParts[0], colonParts[1], 2);

  // ── F: フォールバック（タイトル全体）──
  add(base, ch, 1);
  if (baseNoFeat !== base) add(baseNoFeat, ch, 1);

  // ── G: 動画概要欄の明示クレジット（最高信頼度5）──
  if (description) {
    const grabLine = (labels) => {
      const re = new RegExp(`(?:^|\\n)\\s*[【\\[]?(?:${labels})[】\\]]?\\s*[:：]\\s*([^\\n]+)`, 'i');
      const m = description.match(re);
      if (!m) return '';
      return m[1]
        .replace(/[（(].*?[）)]/g, '')
        .replace(/\s+\/\s+.+$/, '')
        .trim()
        .slice(0, 50);
    };
    const descArtist = grabLine('歌|Vocal|Vo\\.?|Singer|Artist|アーティスト|歌唱');
    const descTrack = grabLine('曲名|曲|Track|Title|タイトル|楽曲');
    if (descArtist && descTrack) {
      add(descTrack, descArtist, 5);
    } else if (descArtist) {
      // 説明欄アーティストを既存 trackName 候補に組み合わせて高信頼度化
      const existingTracks = [...new Set(candidates.map(c => c.trackName))];
      for (const t of existingTracks.slice(0, 3)) add(t, descArtist, 4);
      add(base, descArtist, 3);
    } else if (descTrack) {
      add(descTrack, ch, 4);
    }
    // 概要欄の『曲名』『楽曲名』パターン（クレジット表記なしバージョン）
    const descBracketM = description.match(/[『「]([^」』\n]{2,40})[』」]/);
    if (descBracketM && !descTrack) {
      add(descBracketM[1].trim(), descArtist || ch, descArtist ? 4 : 3);
    }
  }

  // ── 信頼度順にソート ──
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

// ── lrclib.net API ─────────────────────────────────────────────
//
// 検索ステージ設計:
//   Stage 0: /search 並列先行 — 上位候補で「曲名 アーティスト」「曲名のみ」を同時発射
//            /get より部分一致に強く、feat. 表記ゆれ等をカバー
//   Stage 1: /get 完全一致 — duration あり/なし並列。ヒットすれば最速
//   Stage 2: /search 追加候補 — Stage 0 で未試行の候補を順次検索
//   Stage 3: /get 曲名のみ — アーティスト名なしで一致を試みる
//   Stage 4: 生タイトル /search — ノイズ込みでも拾える最終手段
//
async function fetchLyrics(title, artist, duration, description = '') {
  function extract(data) {
    if (!data) return null;
    const meta = { lrclibTrack: data.trackName || '', lrclibArtist: data.artistName || '', lrclibDuration: data.duration };
    if (data.syncedLyrics) return { lrc: data.syncedLyrics, source: 'synced', ...meta };
    if (data.plainLyrics) return { plain: data.plainLyrics, source: 'plain', ...meta };
    return null;
  }

  // ── マッチング度スコア（track + artist + duration を統合評価）──
  // 5+ = 確信(即決) / 3+ = 採用 / 0+ = 弱マッチ(救済) / 負 = 不一致
  function scoreHit(hit, exp) {
    if (!hit) return -100;
    let score = 0;
    const n = s => (s || '').toLowerCase().replace(/[\s\-_]/g, '');

    // Track 一致度
    const eT = n(exp.trackName), hT = n(hit.lrclibTrack);
    if (eT && hT) {
      if (eT === hT) score += 5;
      else if (eT.length <= 2) score -= 3;
      else if (eT.length <= 4) {
        if (hT.includes(eT) && hT.length <= eT.length * 2) score += 2;
        else score -= 3;
      } else {
        if (hT.includes(eT) && eT.length >= hT.length * 0.4) score += 3;
        else if (eT.includes(hT) && hT.length >= eT.length * 0.4) score += 3;
        else score -= 3;
      }
    }

    // Artist 一致度（チャンネル名分割含めて多角的に照合）
    const ch = (artist || '').replace(/\s*[-–—]\s*Topic$/i, '').trim();
    const cnNorm = n(ch);
    const chParts = cnNorm.split(/[\/／\|｜　]+/).filter(Boolean);
    const eA = n(exp.artistName);
    const hA = n(hit.lrclibArtist);
    if (hA) {
      let best = -1.5; // アーティスト不一致デフォルトでペナルティ
      for (const c of [eA, cnNorm, ...chParts].filter(Boolean)) {
        if (hA === c) { best = Math.max(best, 3); continue; }
        if (c.length >= 3) {
          if (hA.includes(c) && c.length >= hA.length * 0.4) best = Math.max(best, 2);
          else if (hA.length >= 3 && c.includes(hA) && hA.length >= c.length * 0.4) best = Math.max(best, 2);
        }
      }
      score += best;
    }

    // Duration 照合（version 違いの検出）
    if (hit.lrclibDuration && duration > 0) {
      const diff = Math.abs(hit.lrclibDuration - duration);
      if (diff < 5) score += 1.5;
      else if (diff < 15) score += 0.5;
      else if (diff > 60) score -= 1;
      else if (diff > 30) score -= 0.3;
    }

    // synced 優先
    if (hit.source === 'synced') score += 0.5;
    return score;
  }

  const candidates = buildSearchCandidates(title, artist, description);
  console.log('[YTL] 検索候補:', candidates.map((c, i) => `${i+1}. [c${c.confidence}] "${c.trackName}" / "${c.artistName}"`).join('\n'));
  if (!candidates.length) return null;

  // ── API呼び出しを最小化する仕組み ──
  const triedGet = new Set();
  const triedSearch = new Set();
  let apiCalls = 0;
  const pool = [];

  const callGet = async (track, art, useDur) => {
    const params = new URLSearchParams({ track_name: track, artist_name: art });
    if (useDur && duration > 0) params.set('duration', Math.round(duration));
    const key = params.toString();
    if (triedGet.has(key)) return null;
    triedGet.add(key);
    apiCalls++;
    try {
      const r = await fetch(`${LRCLIB_BASE}/get?${params}`).catch(() => null);
      if (r?.ok) return extract(await r.json().catch(() => null));
    } catch (_) {}
    return null;
  };

  const callSearch = async (q) => {
    if (!q || triedSearch.has(q)) return [];
    triedSearch.add(q);
    apiCalls++;
    try {
      const r = await fetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(q)}`).catch(() => null);
      if (r?.ok) {
        const results = await r.json().catch(() => []);
        return results.slice(0, 5).map(extract).filter(Boolean);
      }
    } catch (_) {}
    return [];
  };

  const primary = candidates[0];
  const isHighConf = primary.confidence >= 4;

  // ── Stage 1: /search 曲名のみ（最も命中率が高い・1呼び出し）──
  // ユーザー洞察: lrclib の /search は曲名単体の方がヒットしやすい
  // 候補のアーティスト名は scoreHit で検証だけして、クエリには含めない
  let hits = await callSearch(primary.trackName);
  let scored = hits.map(h => ({ hit: h, score: scoreHit(h, primary), src: `s(${primary.trackName})` }));
  scored.sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score >= 4) {
    console.log(`[YTL] Stage1 即決 score=${scored[0].score.toFixed(1)} → ${scored[0].hit.lrclibTrack} / ${scored[0].hit.lrclibArtist} (calls=${apiCalls})`);
    return scored[0].hit;
  }
  scored.forEach(s => pool.push(s));

  // ── Stage 2: 高信頼度時は /get で精密一致を試す（1-2呼び出し）──
  if (isHighConf && primary.artistName) {
    let hit = await callGet(primary.trackName, primary.artistName, true);
    if (hit) {
      const s = scoreHit(hit, primary);
      if (s >= 4) {
        console.log(`[YTL] Stage2 即決 score=${s.toFixed(1)} (calls=${apiCalls})`);
        return hit;
      }
      pool.push({ hit, src: 'get+dur', score: s });
    }
    if (duration > 0) {
      hit = await callGet(primary.trackName, primary.artistName, false);
      if (hit) {
        const s = scoreHit(hit, primary);
        if (s >= 4) {
          console.log(`[YTL] Stage2b 即決 score=${s.toFixed(1)} (calls=${apiCalls})`);
          return hit;
        }
        pool.push({ hit, src: 'get', score: s });
      }
    }
  }

  // ── Stage 3: 別 trackName 候補で /search（最大2つ）──
  const otherTracks = [...new Set(
    candidates.slice(1).map(c => c.trackName)
  )].filter(t => t && t !== primary.trackName).slice(0, 2);
  for (const trackName of otherTracks) {
    hits = await callSearch(trackName);
    const cand = candidates.find(c => c.trackName === trackName) || primary;
    scored = hits.map(h => ({ hit: h, score: scoreHit(h, cand), src: `s(${trackName})` }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 5) {
      console.log(`[YTL] Stage3 即決 score=${scored[0].score.toFixed(1)} "${trackName}" (calls=${apiCalls})`);
      return scored[0].hit;
    }
    // primary 視点でも再評価してプールへ
    scored.forEach(s => pool.push({ ...s, score: scoreHit(s.hit, primary) }));
  }

  // ── Stage 4: low-confidence なら "track artist" 結合検索 ──
  if (!isHighConf && primary.artistName) {
    const q = `${primary.trackName} ${primary.artistName}`;
    hits = await callSearch(q);
    scored = hits.map(h => ({ hit: h, score: scoreHit(h, primary), src: `s(${q})` }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 4) {
      console.log(`[YTL] Stage4 即決 score=${scored[0].score.toFixed(1)} q="${q}" (calls=${apiCalls})`);
      return scored[0].hit;
    }
    scored.forEach(s => pool.push(s));
  }

  // ── Stage 5: 累積プールから最良採用（API呼び出しなし）──
  pool.sort((a, b) => b.score - a.score);
  if (pool[0] && pool[0].score >= 3) {
    console.log(`[YTL] Stage5 累積ベスト score=${pool[0].score.toFixed(1)} src=${pool[0].src} → ${pool[0].hit.lrclibTrack} / ${pool[0].hit.lrclibArtist} (calls=${apiCalls})`);
    return pool[0].hit;
  }

  // ── Stage 6: 低スコアでも採用（最後の救済）──
  if (pool[0] && pool[0].score >= 1) {
    console.log(`[YTL] 低スコア採用 score=${pool[0].score.toFixed(1)} (calls=${apiCalls})`);
    return pool[0].hit;
  }

  console.log(`[YTL] 該当なし (calls=${apiCalls})`);
  return null;
}

// ── 歌詞キャッシュ（先読み + sessionStorage 永続化） ──────────
const lyricsCache = new Map(); // videoId → result | null（フェッチ中）
const CACHE_KEY = 'ytl_lyrics_cache';
const CACHE_VER_KEY = 'ytl_cache_ver';
const CACHE_VERSION = '8'; // 検索ロジック変更時に上げるとキャッシュ自動クリア

function saveCache() {
  try {
    const obj = {};
    lyricsCache.forEach((v, k) => { if (v) obj[k] = v; });
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(obj));
  } catch (_) {}
}

function loadCache() {
  try {
    if (sessionStorage.getItem(CACHE_VER_KEY) !== CACHE_VERSION) {
      sessionStorage.removeItem(CACHE_KEY);
      sessionStorage.setItem(CACHE_VER_KEY, CACHE_VERSION);
      return;
    }
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    Object.entries(obj).forEach(([k, v]) => lyricsCache.set(k, v));
  } catch (_) {}
}

loadCache(); // 起動時に復元（page-bridge.js は manifest で MAIN world から別途実行済み）

// ── 動画オフセット永続化（localStorage）─────────────────────────
const OFFSET_KEY_PREFIX = 'ytl_off_';
function saveVideoOffset(videoId, offset) {
  try { localStorage.setItem(OFFSET_KEY_PREFIX + videoId, offset.toFixed(1)); } catch (_) {}
}
function loadVideoOffset(videoId) {
  try {
    const v = localStorage.getItem(OFFSET_KEY_PREFIX + videoId);
    return v !== null ? parseFloat(v) : null;
  } catch (_) { return null; }
}

// プレイリストから次の動画情報を取得
function getNextVideoFromPlaylist() {
  const currentId = new URLSearchParams(location.search).get('v');
  const items = [...document.querySelectorAll('ytd-playlist-panel-video-renderer')];
  if (items.length === 0) return null;

  let foundCurrent = false;
  for (const item of items) {
    const href = item.querySelector('a[href*="watch"]')?.href || '';
    const videoId = href ? new URL(href).searchParams.get('v') : null;
    if (foundCurrent && videoId) {
      const title = item.querySelector('#video-title')?.textContent?.trim() || '';
      const artist = item.querySelector('#channel-name, .ytd-playlist-panel-video-renderer #byline-text a')?.textContent?.trim() || '';
      return { videoId, title, artist };
    }
    if (videoId === currentId) foundCurrent = true;
  }
  return null;
}

// 次の曲の歌詞を非同期先読み
async function prefetchNextLyrics() {
  const next = getNextVideoFromPlaylist();
  if (!next || !next.videoId || !next.title) return;
  if (lyricsCache.has(next.videoId)) return;
  lyricsCache.set(next.videoId, null); // 重複フェッチ防止プレースホルダー
  const result = await fetchLyrics(next.title, next.artist, 0);
  lyricsCache.set(next.videoId, result);
  if (result) saveCache();
  console.log(`🎵 先読み完了: ${next.title} → ${result ? result.source : 'なし'}`);
}

// ── フリガナ（kuromoji） ───────────────────────────────────────
let tokenizer = null;
let rubyEnabled = true;

function initKuromoji() {
  if (tokenizer !== null) return Promise.resolve(tokenizer);
  if (typeof kuromoji === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const dicPath = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
      ? chrome.runtime.getURL('dict/')
      : 'dict/';
    kuromoji.builder({ dicPath }).build((err, t) => {
      tokenizer = err ? false : t;
      resolve(tokenizer);
    });
  });
}

function katakanaToHiragana(str) {
  return str.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

// ── 辞書フォールバック（kanji-dict.js から読み込み）──
const KANJI_FALLBACK = (typeof window !== 'undefined' && window.YTL_KANJI_FALLBACK) || {};
const READING_FIXES = (typeof window !== 'undefined' && window.YTL_READING_FIXES) || [];
const COMPOUND_OVERRIDES = (typeof window !== 'undefined' && window.YTL_COMPOUND_OVERRIDES) || {};

function hiraganaToKatakana(str) {
  return str.replace(/[ぁ-ん]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

// 連続するトークンを結合して COMPOUND_OVERRIDES と照合
// マッチしたら virtual token (1個) に置き換え
function applyCompoundOverrides(tokens) {
  if (!Object.keys(COMPOUND_OVERRIDES).length) return tokens;
  const result = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (let len = Math.min(5, tokens.length - i); len >= 2; len--) {
      const combined = tokens.slice(i, i + len).map(t => t.surface_form).join('');
      const override = COMPOUND_OVERRIDES[combined];
      if (override) {
        result.push({ surface_form: combined, reading: hiraganaToKatakana(override) });
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) { result.push(tokens[i]); i++; }
  }
  return result;
}

// 漢字の読みが「自分自身を含む」誤読を検出（例: 失=シツ → カナ化失敗時の保険）
function readingLooksWrong(surface, reading) {
  if (!reading || reading === '*') return true;
  if (reading === surface) return true;
  if (/[一-鿿㐀-䶿]/.test(reading)) return true; // 読みに漢字が含まれている
  return false;
}

// UNK surface を文字単位で分解し、漢字には fallback 読みを割り当てる
function splitForFallback(surface) {
  const segments = [];
  for (const c of surface) {
    const isKanji = /[一-鿿㐀-䶿]/.test(c);
    if (isKanji) {
      segments.push({ text: c, reading: KANJI_FALLBACK[c] || null });
    } else {
      const last = segments[segments.length - 1];
      if (last && !last.reading && !/[一-鿿㐀-䶿]/.test(last.text)) {
        last.text += c;
      } else {
        segments.push({ text: c, reading: null });
      }
    }
  }
  return segments;
}

function makeRubyNode(surface, reading) {
  const ruby = document.createElement('ruby');
  ruby.appendChild(document.createTextNode(surface));
  const rt = document.createElement('rt');
  rt.textContent = reading;
  ruby.appendChild(rt);
  return ruby;
}

function buildRubyNode(text) {
  if (!tokenizer || !rubyEnabled) return document.createTextNode(text);
  // 1) kuromoji 形態素解析
  // 2) 連語オーバーライド適用（熟字訓: 黄昏→たそがれ 等）
  const tokens = applyCompoundOverrides(tokenizer.tokenize(text));
  const span = document.createElement('span');

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const surface = token.surface_form;
    let reading = token.reading;
    const hasKanji = /[一-鿿㐀-䶿]/.test(surface);

    if (!hasKanji) {
      span.appendChild(document.createTextNode(surface));
      continue;
    }

    // ── 文脈依存の読み補正 ──
    const next = tokens[i + 1];
    for (const fix of READING_FIXES) {
      if (surface === fix.kanji && next?.surface_form && fix.nextRegex.test(next.surface_form)) {
        reading = fix.reading;
        break;
      }
    }

    // ── kuromojiが正しい読みを返した場合 ──
    if (!readingLooksWrong(surface, reading)) {
      span.appendChild(makeRubyNode(surface, katakanaToHiragana(reading)));
      continue;
    }

    // ── 読みが無効 → 文字単位でフォールバック ──
    const segments = splitForFallback(surface);
    for (const seg of segments) {
      if (seg.reading) span.appendChild(makeRubyNode(seg.text, seg.reading));
      else span.appendChild(document.createTextNode(seg.text));
    }
  }
  return span;
}

function refreshRuby(panel) {
  if (!lrcLines.length) return;
  panel.querySelectorAll('.ytl-line[data-index]').forEach(el => {
    const idx = parseInt(el.dataset.index);
    if (isNaN(idx) || !lrcLines[idx]) return;
    el.textContent = '';
    el.appendChild(buildRubyNode(lrcLines[idx].text));
  });
}

// ── フォーカスモード ───────────────────────────────────────────
function toggleFocusMode(btn) {
  focusMode = !focusMode;
  document.querySelector('ytd-watch-flexy')?.classList.toggle('ytl-focus', focusMode);
  document.getElementById(PANEL_ID)?.classList.toggle('ytl-focus', focusMode);
  btn.textContent = focusMode ? '⊡' : '⤢';
  btn.title = focusMode ? '通常モード' : '歌詞フォーカスモード';
}

// ── パネルの作成 ───────────────────────────────────────────────
function createPanel() {
  const existing = document.getElementById(PANEL_ID);
  if (existing) return existing;

  const panel = mk('div');
  panel.id = PANEL_ID;

  // ヘッダー
  const header = mk('div', 'ytl-header');
  const focusBtn = mk('button', 'ytl-focus-btn', '⤢');
  focusBtn.title = '歌詞フォーカスモード';
  focusBtn.addEventListener('click', () => toggleFocusMode(focusBtn));
  const reloadBtn = mk('button', 'ytl-reload-btn', '↻');
  reloadBtn.title = '手動で再読み込み';
  reloadBtn.addEventListener('click', () => {
    const vid = new URLSearchParams(location.search).get('v');
    if (vid) {
      lyricsCache.delete(vid);
      try { localStorage.removeItem(OFFSET_KEY_PREFIX + vid); } catch (_) {}
    }
    currentVideoId = null;
    loadLyrics();
  });
  const rubyBtn = mk('button', 'ytl-ruby-btn', 'ふ');
  rubyBtn.title = 'フリガナ ON/OFF';
  rubyBtn.classList.add('active');
  rubyBtn.addEventListener('click', () => {
    rubyEnabled = !rubyEnabled;
    rubyBtn.classList.toggle('active', rubyEnabled);
    refreshRuby(panel);
  });
  let fontSize = 15;
  function applyFontSize() {
    panel.style.setProperty('--ytl-font-size', `${fontSize}px`);
  }
  const fontDecBtn = mk('button', 'ytl-font-btn', '小');
  fontDecBtn.title = '文字を小さく';
  fontDecBtn.addEventListener('click', () => { fontSize = Math.max(10, fontSize - 10); applyFontSize(); });
  const fontIncBtn = mk('button', 'ytl-font-btn', '大');
  fontIncBtn.title = '文字を大きく';
  fontIncBtn.addEventListener('click', () => { fontSize = Math.min(60, fontSize + 10); applyFontSize(); });
  const closeBtn = mk('button', 'ytl-close', '✕');
  closeBtn.title = '閉じる';
  closeBtn.addEventListener('click', () => {
    panel.remove();
    clearInterval(syncTimer);
    tapSyncMode = false;
    if (focusMode) { focusMode = false; document.querySelector('ytd-watch-flexy')?.classList.remove('ytl-focus'); }
  });
  const searchBtn = mk('button', 'ytl-search-btn', '🔍');
  searchBtn.title = '手動で曲を検索';
  header.append(mk('span', 'ytl-icon', '♪'), mk('span', 'ytl-title', '歌詞'), mk('span', 'ytl-source', ''), focusBtn, reloadBtn, rubyBtn, fontDecBtn, fontIncBtn, searchBtn, closeBtn);

  // オフセットバー（タップ同期 + 微調整 0.1）
  const offsetBar = mk('div', 'ytl-offset-bar');

  // タップ同期ボタン（メインアクション・大きく目立つ）
  const tapSyncBtn = mk('button', 'ytl-tapsync-btn', '');
  const tapSyncIcon = mk('span', 'ytl-tapsync-icon', '🎯');
  const tapSyncLabel = mk('span', 'ytl-tapsync-label', 'タップして歌詞を合わせる');
  tapSyncBtn.append(tapSyncIcon, tapSyncLabel);
  tapSyncBtn.title = '動画を合わせてから歌詞行をクリック';
  tapSyncBtn.addEventListener('click', () => {
    tapSyncMode = !tapSyncMode;
    tapSyncBtn.classList.toggle('active', tapSyncMode);
    panel.classList.toggle('ytl-tapsync', tapSyncMode);
    tapSyncLabel.textContent = tapSyncMode ? '動画を歌い出しに合わせて歌詞行をクリック…' : 'タップして歌詞を合わせる';
  });

  // オフセット表示 + 微調整 0.1
  const offsetMicroRow = mk('div', 'ytl-offset-micro-row');
  const offsetLabel = mk('span', 'ytl-offset-label', 'オフセット: 0.0s');
  offsetLabel.id = 'ytl-offset-label';
  function updateOffsetLabel() {
    const v = window.__ytlOffset ?? 0;
    offsetLabel.textContent = `オフセット: ${v > 0 ? '+' : ''}${v.toFixed(1)}s`;
  }
  function makeOffBtn(text, delta) {
    const btn = mk('button', 'ytl-off-btn', text);
    btn.addEventListener('click', () => {
      window.__ytlOffset = Math.round(((window.__ytlOffset ?? 0) + delta) * 10) / 10;
      updateOffsetLabel();
      const vid = new URLSearchParams(location.search).get('v');
      if (vid) saveVideoOffset(vid, window.__ytlOffset);
    });
    return btn;
  }
  offsetMicroRow.append(offsetLabel, makeOffBtn('－0.1', -0.1), makeOffBtn('＋0.1', 0.1));

  offsetBar.append(tapSyncBtn, offsetMicroRow);

  // ボディ
  const body = mk('div', 'ytl-body');
  body.append(mk('div', 'ytl-status', '歌詞を読み込み中...'), mk('div', 'ytl-lines', ''));

  // 手動検索バー（折りたたみ式）
  const searchBar = mk('div', 'ytl-search-bar');
  searchBar.style.display = 'none';
  const searchRow = mk('div', 'ytl-search-row');
  const searchInput = document.createElement('input');
  searchInput.className = 'ytl-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = '曲名 アーティスト名で検索...';
  const searchGoBtn = mk('button', 'ytl-search-go', '検索');
  searchRow.append(searchInput, searchGoBtn);
  const searchResultsEl = mk('div', 'ytl-search-results');
  searchBar.append(searchRow, searchResultsEl);

  searchBtn.addEventListener('click', () => {
    const visible = searchBar.style.display !== 'none';
    searchBar.style.display = visible ? 'none' : '';
    if (!visible) setTimeout(() => searchInput.focus(), 50);
  });

  const doSearch = () => performManualSearch(panel, searchInput.value.trim());
  searchGoBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  panel.append(header, searchBar, offsetBar, body);
  return panel;
}

function injectPanel(panel) {
  const secondary = document.querySelector('#secondary, #secondary-inner');
  if (secondary) { secondary.insertBefore(panel, secondary.firstChild); return true; }
  return false;
}

// ── 状態表示 ───────────────────────────────────────────────────
function setStatus(panel, msg) {
  const s = panel.querySelector('.ytl-status');
  s.textContent = msg; s.style.display = 'block';
  panel.querySelector('.ytl-lines').textContent = '';
}

function setSource(panel, source) {
  const el = panel.querySelector('.ytl-source');
  if (source === 'synced') { el.textContent = '同期あり'; el.className = 'ytl-source synced'; }
  else if (source === 'plain') { el.textContent = '時刻なし'; el.className = 'ytl-source plain'; }
  else { el.textContent = ''; el.className = 'ytl-source'; }
}

// ── 歌詞レンダリング ───────────────────────────────────────────
function renderSyncedLyrics(panel, lines) {
  const linesEl = panel.querySelector('.ytl-lines');
  panel.querySelector('.ytl-status').style.display = 'none';
  linesEl.textContent = '';
  lines.forEach((line, i) => {
    const el = mk('div', 'ytl-line');
    el.dataset.index = i; el.dataset.time = line.time;
    el.appendChild(buildRubyNode(line.text));
    el.addEventListener('click', () => {
      if (tapSyncMode) {
        const video = document.querySelector('video.html5-main-video');
        if (!video) return;
        const newOffset = Math.round((video.currentTime - line.time) * 10) / 10;
        window.__ytlOffset = newOffset;
        const lbl = panel.querySelector('.ytl-offset-label');
        if (lbl) lbl.textContent = `オフセット: ${newOffset > 0 ? '+' : ''}${newOffset.toFixed(1)}s（タップ同期）`;
        const vid = new URLSearchParams(location.search).get('v');
        if (vid) saveVideoOffset(vid, newOffset);
        tapSyncMode = false;
        panel.classList.remove('ytl-tapsync');
        panel.querySelector('.ytl-tapsync-btn')?.classList.remove('active');
        const tsLbl = panel.querySelector('.ytl-tapsync-label');
        if (tsLbl) tsLbl.textContent = 'タップして歌詞を合わせる';
        return;
      }
      const video = document.querySelector('video.html5-main-video');
      if (video) video.currentTime = line.time + (window.__ytlOffset ?? 0);
    });
    linesEl.appendChild(el);
  });
  lrcLines = lines;
  startSync(panel);
}

function renderPlainLyrics(panel, text) {
  const linesEl = panel.querySelector('.ytl-lines');
  panel.querySelector('.ytl-status').style.display = 'none';
  linesEl.textContent = '';
  text.split('\n').forEach(line => linesEl.appendChild(mk('div', 'ytl-line plain', line || ' ')));
}

// ── 歌詞同期ループ ─────────────────────────────────────────────
function startSync(panel) {
  clearInterval(syncTimer);
  const video = document.querySelector('video.html5-main-video');
  if (!video || lrcLines.length === 0) return;
  let lastIndex = -1;
  syncTimer = setInterval(() => {
    // オフセット分を引いて lrclib の時刻軸に変換 (+0.3s 先読み)
    const t = video.currentTime - (window.__ytlOffset ?? 0) + 0.3;
    let current = -1;
    for (let i = 0; i < lrcLines.length; i++) {
      if (lrcLines[i].time <= t) current = i;
      else break;
    }
    if (current === lastIndex) return;
    lastIndex = current;
    const allLines = panel.querySelectorAll('.ytl-line');
    allLines.forEach((el, i) => {
      el.classList.toggle('active', i === current);
      el.classList.toggle('past', i < current);
    });
    if (current >= 0 && allLines[current]) {
      // パネル本体（.ytl-body）内だけをスクロール（ページスクロールしない）
      const body = panel.querySelector('.ytl-body');
      const targetEl = allLines[current];
      if (body && targetEl) {
        const target = targetEl.offsetTop - body.clientHeight / 2 + targetEl.clientHeight / 2;
        body.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      }
    }
  }, 200);
}

// ── メイン処理 ─────────────────────────────────────────────────
async function loadLyrics() {
  const videoId = new URLSearchParams(location.search).get('v');
  if (!videoId || videoId === currentVideoId) return;
  currentVideoId = videoId;

  clearInterval(syncTimer);
  lrcLines = [];
  window.__ytlOffset = 0;
  tapSyncMode = false;

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = createPanel();
    if (!injectPanel(panel)) { setTimeout(loadLyrics, 1500); currentVideoId = null; return; }
  } else {
    // 既存パネルのオフセットラベルとモード状態をリセット
    const lbl = panel.querySelector('.ytl-offset-label');
    if (lbl) lbl.textContent = 'オフセット: 0.0s';
    panel.classList.remove('ytl-tapsync');
    panel.querySelector('.ytl-tapsync-btn')?.classList.remove('active');
    const tsLbl = panel.querySelector('.ytl-tapsync-label');
    if (tsLbl) tsLbl.textContent = 'タップして歌詞を合わせる';
  }

  setStatus(panel, '歌詞を読み込み中...');
  setSource(panel, null);
  panel.querySelector('.ytl-title').textContent = '読み込み中...';

  // タイトル確定 & kuromoji 初期化を並列実行
  await Promise.all([waitForTitle(), initKuromoji()]);

  const { title, artist, duration, description } = getVideoInfo();
  if (!title) { setStatus(panel, '動画情報を取得できませんでした'); return; }
  panel.querySelector('.ytl-title').textContent = title.length > 30 ? title.slice(0, 28) + '…' : title;

  // キャッシュ確認（先読みで取得済みならそのまま使用）
  let result = lyricsCache.get(videoId);
  if (result === undefined) {
    result = await fetchLyrics(title, artist, duration, description);
  }
  lyricsCache.set(videoId, result);
  saveCache();
  if (!result) { setStatus(panel, '歌詞が見つかりませんでした\n（lrclib.net未収録）'); return; }

  // 保存済みオフセットを確認（手動調整値が最優先）
  const savedOffset = loadVideoOffset(videoId);
  const skipAutoOffset = savedOffset !== null;
  if (skipAutoOffset) {
    window.__ytlOffset = savedOffset;
    const lbl = panel.querySelector('.ytl-offset-label');
    if (lbl) lbl.textContent = `オフセット: ${savedOffset > 0 ? '+' : ''}${savedOffset.toFixed(1)}s（保存済み）`;
  }

  // lrclib の収録長と動画長の差を自動オフセットに設定
  let durationMatches = false;
  if (!skipAutoOffset && result.source === 'synced' && result.lrclibDuration && duration > 0) {
    const diff = Math.round((duration - result.lrclibDuration) * 10) / 10;
    console.log(`[YTL] duration: video=${duration.toFixed(1)}s lrclib=${result.lrclibDuration}s diff=${diff}s`);
    if (Math.abs(diff) >= 2 && Math.abs(diff) < 60) {
      window.__ytlOffset = diff;
      const lbl = panel.querySelector('.ytl-offset-label');
      if (lbl) lbl.textContent = `オフセット: ${diff > 0 ? '+' : ''}${diff.toFixed(1)}s（自動補正）`;
    } else if (Math.abs(diff) < 1.5) {
      durationMatches = true;
    }
  }

  setSource(panel, result.source);
  if (result.lrc) {
    const parsed = parseLrc(result.lrc);
    if (parsed.length > 0) {
      renderSyncedLyrics(panel, parsed);
      // 保存済みなし・durationほぼ一致でない場合に字幕マッチ実行（duration補正後も精密化のため実行）
      if (!skipAutoOffset && !durationMatches) setTimeout(() => detectOffsetFromSubtitleText(panel), 2000);
    } else {
      renderPlainLyrics(panel, result.lrc);
    }
  } else if (result.plain) {
    renderPlainLyrics(panel, result.plain);
  }

  // 先読み: 読み込み完了直後 + 残り30秒で次の曲をフェッチ
  setTimeout(prefetchNextLyrics, 800);
  const videoEl2 = document.querySelector('video.html5-main-video');
  if (videoEl2) {
    let prefetchDone = false;
    const onTime = () => {
      if (!prefetchDone && videoEl2.duration > 0 && (videoEl2.duration - videoEl2.currentTime) < 30) {
        prefetchDone = true;
        prefetchNextLyrics();
        videoEl2.removeEventListener('timeupdate', onTime);
      }
    };
    videoEl2.addEventListener('timeupdate', onTime);
  }
}

// タイトルが DOM に反映されるまで MutationObserver で待つ（ポーリング不要）
function waitForTitle() {
  return new Promise(resolve => {
    const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
    if (el?.textContent?.trim()) { resolve(); return; }
    const obs = new MutationObserver(() => {
      const el2 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      if (el2?.textContent?.trim()) { obs.disconnect(); resolve(); }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { obs.disconnect(); resolve(); }, 3000);
  });
}

// ── YouTube 字幕取得ヘルパー ──────────────────────────────────────
// 取得優先順位:
//   ⓪ page-bridge.js (MAIN world) が事前 fetch したデータ（クッキー付き・最優先）
//   ① playerResponse の baseUrl（content script fetch・クッキーなし）
//   ② timedtext API 直叩き（SPA遷移後 / playerResponse が古い場合）
//   ③ textTracks DOM API（最終手段：再生済み範囲のキューのみ）

async function fetchYouTubeCaptions(videoId) {
  // ⓪ MAIN world 事前 fetch / 傍受データ（最優先 – YouTube クッキー付きで取得済み）
  // fetch完了を最大1.5秒待つ（detectOffsetFromSubtitleText の 2s 遅延内に収まる）
  for (let i = 0; i < 15; i++) {
    if (capturedCaptionsData?.videoId === videoId) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (capturedCaptionsData?.videoId === videoId) {
    const { format, text, src } = capturedCaptionsData;
    let cues = null;
    if (format === 'json3') {
      try { cues = parseJson3Caption(JSON.parse(text)); } catch (_) {}
    } else if (format === 'vtt') {
      cues = parseVttCaption(text);
    }
    if (cues?.length) {
      console.log(`[YTL] 字幕(MAIN world/${src}): ${cues.length}件 format=${format}`);
      return cues;
    }
  }

  // ① playerResponse から baseUrl を取得
  const captionTracks = getPlayerCaptionTracks(videoId);
  console.log(`[YTL] playerResponse字幕トラック: ${captionTracks ? captionTracks.length + '件' : 'なし'}`);
  if (captionTracks) {
    console.log('[YTL] 利用可能トラック:', captionTracks.map(t => `${t.languageCode}(${t.kind || 'manual'})`).join(', '));
    const jaTrack =
      captionTracks.find(t => t.languageCode === 'ja' && t.kind === 'asr') ||
      captionTracks.find(t => t.languageCode === 'ja');
    if (jaTrack?.baseUrl) {
      console.log(`[YTL] baseUrl: ${jaTrack.baseUrl.slice(0, 120)}...`);
      // baseUrl そのまま → &fmt=json3 → &fmt=vtt の順で試す
      for (const suffix of ['&fmt=json3', '&fmt=vtt', '']) {
        try {
          const url = jaTrack.baseUrl + suffix;
          const r = await fetch(url).catch(() => null);
          const text = r?.ok ? await r.text().catch(() => '') : '';
          console.log(`[YTL] baseUrl${suffix||'(raw)'}: HTTP ${r?.status} len=${text.length} preview="${text.slice(0, 80)}"`);
          if (!r?.ok || !text) continue;
          // JSON3 試行
          let data = null; try { data = JSON.parse(text); } catch (_) {}
          const jsonCues = parseJson3Caption(data);
          if (jsonCues?.length) {
            console.log(`[YTL] 字幕(playerResponse/json3): ${jsonCues.length}件 kind=${jaTrack.kind || 'manual'}`);
            return jsonCues;
          }
          // VTT 試行
          if (text.includes('WEBVTT')) {
            const vttCues = parseVttCaption(text);
            if (vttCues?.length) {
              console.log(`[YTL] 字幕(playerResponse/vtt): ${vttCues.length}件 kind=${jaTrack.kind || 'manual'}`);
              return vttCues;
            }
          }
        } catch (e) { console.log(`[YTL] baseUrl${suffix} エラー: ${e.message}`); }
      }
    } else {
      console.log('[YTL] 日本語字幕トラックなし');
    }
  }

  // ② timedtext API 直叩き（ASR → 手動字幕の順）
  for (const suffix of ['&kind=asr', '']) {
    try {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ja${suffix}&fmt=json3`;
      const r = await fetch(url).catch(() => null);
      if (r?.ok) {
        const text = await r.text().catch(() => '');
        let data = null;
        try { data = JSON.parse(text); } catch (_) {}
        const cues = parseJson3Caption(data);
        if (cues?.length) {
          console.log(`[YTL] 字幕(timedtext${suffix}): ${cues.length}件`);
          return cues;
        }
        console.log(`[YTL] timedtext${suffix} レスポンスあり(${r.status})・キューなし, preview="${text.slice(0, 80)}"`);
      } else {
        console.log(`[YTL] timedtext${suffix} HTTP ${r?.status}`);
      }
    } catch (e) {
      console.log(`[YTL] timedtext${suffix} エラー: ${e.message}`);
    }
  }

  // ③ textTracks DOM API（再生済み範囲のみ取得できる最終手段）
  const video = document.querySelector('video.html5-main-video');
  if (!video) return null;
  const tracks = [...video.textTracks].filter(t =>
    t.kind === 'subtitles' || t.kind === 'captions'
  );
  if (!tracks.length) {
    console.log('[YTL] 字幕トラックなし（全手段失敗）');
    return null;
  }
  const prevModes = tracks.map(t => t.mode);
  tracks.forEach(t => { if (t.mode === 'disabled') t.mode = 'hidden'; });
  await new Promise(r => setTimeout(r, 1500));
  const domCues = [];
  tracks.forEach((t, i) => {
    if (t.cues) for (const c of t.cues) {
      const text = (c.text || '').replace(/<[^>]+>/g, '').trim();
      if (text) domCues.push({ time: c.startTime, text });
    }
    t.mode = prevModes[i];
  });
  if (domCues.length) {
    console.log(`[YTL] 字幕(textTracks): ${domCues.length}件`);
    return domCues;
  }
  console.log('[YTL] 字幕取得失敗（全手段）');
  return null;
}

function parseJson3Caption(data) {
  if (!data?.events) return null;
  const cues = [];
  for (const ev of data.events) {
    if (!ev.segs) continue;
    const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\n/g, '').trim();
    if (text) cues.push({ time: ev.tStartMs / 1000, text });
  }
  return cues.length ? cues : null;
}

function parseVttCaption(text) {
  if (!text?.includes('WEBVTT')) return null;
  const cues = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const tLine = lines.find(l => l.includes('-->'));
    if (!tLine) continue;
    const timeStr = tLine.split('-->')[0].trim();
    const parts = timeStr.split(':');
    let seconds;
    if (parts.length === 3) {
      seconds = +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      seconds = +parts[0] * 60 + parseFloat(parts[1]);
    } else {
      continue;
    }
    const tIdx = lines.indexOf(tLine);
    const rawText = lines.slice(tIdx + 1).join(' ')
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (rawText) cues.push({ time: seconds, text: rawText });
  }
  return cues.length ? cues : null;
}

function getPlayerCaptionTracks(videoId) {
  // ① ページ注入スクリプト経由でキャプチャした tracks（SPA遷移後も有効・最優先）
  try { if (capturedCaptionTracks?.videoId === videoId) return capturedCaptionTracks.tracks; } catch (_) {}
  // ② ytInitialPlayerResponse 直読み（初回ロード時）
  const extract = (resp) => {
    if (!resp || resp.videoDetails?.videoId !== videoId) return null;
    return resp.captions?.playerCaptionsTracklistRenderer?.captionTracks || null;
  };
  try { const t = extract(window.ytInitialPlayerResponse); if (t) return t; } catch (_) {}
  // ③ ytd-watch-flexy の Polymer プロパティ（まれに有効）
  try {
    const flexy = document.querySelector('ytd-watch-flexy');
    for (const key of ['playerData', 'playerResponse', 'data', '__data']) {
      try { const t = extract(flexy?.[key]); if (t) return t; } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// 字幕テキストマッチによる自動オフセット検出（スライド相関法）
// LRC 行を各オフセット値でシフトし、時刻が近い字幕キューとの類似度合計が最大になるオフセットを採用。
// 個別ラインのマッチが弱くても集約信号で正確に検出できる。
async function detectOffsetFromSubtitleText(panel) {
  if (lrcLines.length === 0) return;
  const videoId = new URLSearchParams(location.search).get('v');
  if (!videoId) return;

  const rawCues = await fetchYouTubeCaptions(videoId);
  if (!rawCues?.length) return;

  // 正規化: カタカナ→ひらがな・零幅スペース・記号・空白除去
  const norm = (s) => s
    .replace(/<[^>]+>/g, '')
    .replace(/[​-‍﻿­]/g, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　。、！？「」『』・…―〜♪～ー]/g, '')
    .toLowerCase();

  // ASR は累積表示するため: 各 2.5s ウィンドウ内で最長テキストのキューを選択
  // 時刻はウィンドウ先頭（フレーズ開始時刻）を使う
  const phraseCues = [];
  let i = 0;
  while (i < rawCues.length) {
    const startTime = rawCues[i].time;
    let best = rawCues[i];
    let bestLen = norm(best.text).length;
    let j = i + 1;
    while (j < rawCues.length && rawCues[j].time - startTime < 2.5) {
      const nlen = norm(rawCues[j].text).length;
      if (nlen > bestLen) { best = rawCues[j]; bestLen = nlen; }
      j++;
    }
    if (bestLen >= 2) phraseCues.push({ time: startTime, text: best.text });
    i = j;
  }
  if (!phraseCues.length) return;
  console.log(`[YTL] フレーズキュー: ${rawCues.length}件→${phraseCues.length}件`);

  // 文字バイグラム Dice 係数
  const dice = (a, b) => {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const bg = (s) => { const set = new Set(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
    const A = bg(a), B = bg(b);
    let common = 0; A.forEach(g => { if (B.has(g)) common++; });
    return (2 * common) / (A.size + B.size);
  };

  const anchors = lrcLines.filter(l => l.text.replace(/\s/g, '').length >= 4).slice(0, 15);
  if (!anchors.length) return;
  const nAnchors = anchors.map(l => norm(l.text));

  // スライド相関: 各オフセットで LRC アンカーと時刻近傍フレーズキューの類似度合計を計算
  function corrAt(off) {
    let total = 0;
    for (let k = 0; k < anchors.length; k++) {
      const tgt = anchors[k].time + off;
      let nearest = null, nd = Infinity;
      for (const c of phraseCues) {
        const d = Math.abs(c.time - tgt);
        if (d < nd) { nd = d; nearest = c; }
      }
      if (nearest && nd < 3) total += dice(nAnchors[k], norm(nearest.text));
    }
    return total;
  }

  // 粗い探索: 1-70s を 0.5s 刻み
  let coarseOff = 1, coarseCorr = 0;
  for (let off = 1; off <= 70; off += 0.5) {
    const c = corrAt(off);
    if (c > coarseCorr) { coarseCorr = c; coarseOff = off; }
  }

  // 細い探索: 最良付近 ±2s を 0.1s 刻み
  let fineOff = coarseOff, fineCorr = coarseCorr;
  for (let off = coarseOff - 2; off <= coarseOff + 2; off += 0.1) {
    const c = corrAt(Math.round(off * 10) / 10);
    if (c > fineCorr) { fineCorr = c; fineOff = off; }
  }

  // 信頼度チェック: アンカー1行あたり平均 Dice > 0.06 以上
  const threshold = 0.06 * anchors.length;
  if (fineCorr < threshold) {
    console.log(`[YTL] 字幕相関不足: corr=${fineCorr.toFixed(2)} threshold=${threshold.toFixed(2)}`);
    return;
  }

  const offset = Math.round(fineOff * 10) / 10;
  if (Math.abs(offset) < 0.1 || Math.abs(offset) > 120) return;

  window.__ytlOffset = offset;
  const lbl = panel.querySelector('.ytl-offset-label');
  if (lbl) lbl.textContent = `オフセット: ${offset > 0 ? '+' : ''}${offset.toFixed(1)}s（字幕マッチ）`;
  console.log(`[YTL] 字幕相関 offset 確定: ${offset}s (corr=${fineCorr.toFixed(2)}/${anchors.length} phrases=${phraseCues.length})`);
}

// ── 手動検索 ───────────────────────────────────────────────────
async function performManualSearch(panel, query) {
  if (!query) return;
  const resultsEl = panel.querySelector('.ytl-search-results');
  resultsEl.textContent = '検索中...';
  try {
    const r = await fetch(`${LRCLIB_BASE}/search?q=${encodeURIComponent(query)}`).catch(() => null);
    if (!r?.ok) { resultsEl.textContent = '検索に失敗しました'; return; }
    const items = await r.json().catch(() => []);
    if (!items.length) { resultsEl.textContent = '見つかりませんでした'; return; }
    resultsEl.textContent = '';
    items.slice(0, 6).forEach(item => {
      const row = mk('div', 'ytl-search-result');
      const hasSynced = !!item.syncedLyrics;
      const badge = mk('span', `ytl-search-badge ${hasSynced ? 'synced' : 'plain'}`, hasSynced ? '同期' : '歌詞');
      const display = [item.trackName, item.artistName].filter(Boolean).join(' — ');
      const name = mk('span', 'ytl-search-name', display || '(タイトル不明)');
      row.append(badge, name);
      row.addEventListener('click', () => loadManualResult(panel, item));
      resultsEl.appendChild(row);
    });
  } catch (_) {
    resultsEl.textContent = '検索エラー';
  }
}

function loadManualResult(panel, item) {
  const videoId = new URLSearchParams(location.search).get('v');

  const searchBar = panel.querySelector('.ytl-search-bar');
  if (searchBar) searchBar.style.display = 'none';

  clearInterval(syncTimer);
  lrcLines = [];

  // 別曲を手動選択した場合は前曲の自動補正値を破棄
  window.__ytlOffset = 0;
  if (videoId) { try { localStorage.removeItem(OFFSET_KEY_PREFIX + videoId); } catch (_) {} }
  const lbl = panel.querySelector('.ytl-offset-label');
  if (lbl) lbl.textContent = 'オフセット: 0.0s';

  const hit = {
    lrc: item.syncedLyrics || null,
    plain: item.plainLyrics || null,
    source: item.syncedLyrics ? 'synced' : (item.plainLyrics ? 'plain' : null),
    lrclibTrack: item.trackName || '',
    lrclibArtist: item.artistName || '',
    lrclibDuration: item.duration,
  };

  if (videoId) { lyricsCache.set(videoId, hit); saveCache(); }

  const label = [hit.lrclibTrack, hit.lrclibArtist].filter(Boolean).join(' / ');
  const titleEl = panel.querySelector('.ytl-title');
  if (titleEl && label) titleEl.textContent = label.length > 30 ? label.slice(0, 28) + '…' : label;

  setSource(panel, hit.source);

  if (hit.lrc) {
    const parsed = parseLrc(hit.lrc);
    if (parsed.length > 0) { renderSyncedLyrics(panel, parsed); return; }
  }
  if (hit.plain) { renderPlainLyrics(panel, hit.plain); return; }
  setStatus(panel, '歌詞データなし');
}

// ── YouTube SPA のナビゲーション監視（MutationObserver で即時検知）──
function setupNavigationObserver() {
  const flexy = document.querySelector('ytd-watch-flexy');
  if (!flexy) { setTimeout(setupNavigationObserver, 500); return; }

  let lastVideoId = flexy.getAttribute('video-id') || '';

  const obs = new MutationObserver(() => {
    const newId = flexy.getAttribute('video-id') || '';
    if (newId && newId !== lastVideoId) {
      lastVideoId = newId;
      if (location.pathname === '/watch') {
        loadLyrics();
      } else {
        clearInterval(syncTimer);
        lrcLines = []; currentVideoId = null; focusMode = false; tapSyncMode = false; window.__ytlOffset = 0;
        flexy.classList.remove('ytl-focus');
        document.getElementById(PANEL_ID)?.remove();
      }
    }
  });

  obs.observe(flexy, { attributes: true, attributeFilter: ['video-id'] });

  // 初回ロード
  if (location.pathname === '/watch') loadLyrics();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupNavigationObserver);
} else {
  setupNavigationObserver();
}
