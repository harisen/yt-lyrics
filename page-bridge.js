// YT Lyrics - page bridge (MAIN world, document_start)
// YouTube の ytInitialPlayerResponse から captionTracks を抽出し、
// ISOLATED world の content.js に DOM属性とカスタムイベントで伝達する。
// また YouTube プレーヤー自身の timedtext fetch を傍受して字幕データを取得する。
(function () {
  // ── ① YouTube の fetch/XHR を傍受して timedtext レスポンスを取得 ──
  // YouTube プレーヤー自身がリクエストするので認証・POT 問題がない
  function interceptCaptionRequests() {
    const _origFetch = window.fetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input
        : (input instanceof Request ? input.url : String(input));
      const result = _origFetch.call(this, input, init);
      if (url.includes('/api/timedtext') && (url.includes('lang=ja') || url.includes('caps=asr'))) {
        result.then(r => r.clone().text().then(text => {
          if (!text || text.length < 20) return;
          const vidM = url.match(/[?&]v=([^&]+)/);
          const vid = vidM?.[1];
          if (!vid) return;
          const isJson = text.trim().startsWith('{');
          const isVtt = text.includes('WEBVTT');
          if (!isJson && !isVtt) return;
          const format = isJson ? 'json3' : 'vtt';
          const data = { videoId: vid, format, text, src: 'intercept' };
          try { document.documentElement.dataset.ytlCaptionsData = JSON.stringify(data); } catch (_) {}
          document.dispatchEvent(new CustomEvent('ytl-captions-data', { detail: data }));
        }).catch(() => {})).catch(() => {});
      }
      return result;
    };

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._ytlUrl = typeof url === 'string' ? url : '';
      return _origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (this._ytlUrl.includes('/api/timedtext') &&
          (this._ytlUrl.includes('lang=ja') || this._ytlUrl.includes('caps=asr'))) {
        this.addEventListener('load', () => {
          const text = this.responseText;
          if (!text || text.length < 20) return;
          const vidM = this._ytlUrl.match(/[?&]v=([^&]+)/);
          const vid = vidM?.[1];
          if (!vid) return;
          const isJson = text.trim().startsWith('{');
          const isVtt = text.includes('WEBVTT');
          if (!isJson && !isVtt) return;
          const format = isJson ? 'json3' : 'vtt';
          const data = { videoId: vid, format, text, src: 'intercept-xhr' };
          try { document.documentElement.dataset.ytlCaptionsData = JSON.stringify(data); } catch (_) {}
          document.dispatchEvent(new CustomEvent('ytl-captions-data', { detail: data }));
        });
      }
      return _origSend.call(this, ...args);
    };
  }
  interceptCaptionRequests();

  // ── ② MAIN world から直接 fetch を試みる（診断ログ付き）──
  async function fetchAndStoreCaptions(tracks, vid) {
    const jaTrack =
      tracks.find(t => t.languageCode === 'ja' && t.kind === 'asr') ||
      tracks.find(t => t.languageCode === 'ja');
    if (!jaTrack?.baseUrl) return;

    console.log(`[YTL-MAIN] fetch開始 kind=${jaTrack.kind} url=${jaTrack.baseUrl.slice(0, 100)}...`);
    for (const fmt of ['&fmt=json3', '&fmt=vtt']) {
      try {
        const r = await fetch(jaTrack.baseUrl + fmt);
        const text = await r.text();
        console.log(`[YTL-MAIN] ${fmt}: HTTP ${r.status} len=${text.length} preview="${text.slice(0, 60)}"`);
        if (!r.ok || text.length < 20) continue;
        const isJson = text.trim().startsWith('{');
        const isVtt = text.includes('WEBVTT');
        if (!isJson && !isVtt) continue;
        const format = isJson ? 'json3' : 'vtt';
        const data = { videoId: vid, format, text, src: 'main-fetch' };
        try { document.documentElement.dataset.ytlCaptionsData = JSON.stringify(data); } catch (_) {}
        document.dispatchEvent(new CustomEvent('ytl-captions-data', { detail: data }));
        return;
      } catch (e) {
        console.log(`[YTL-MAIN] ${fmt} エラー: ${e.message}`);
      }
    }
  }

  function storeAndDispatch(pr) {
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const vid = pr?.videoDetails?.videoId;
    if (!tracks || !vid) return;
    const data = {
      videoId: vid,
      tracks: tracks.map(t => ({ baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind }))
    };
    // DOM属性に保存（content.js が document_idle 時に読み取る）
    try { document.documentElement.dataset.ytlCaptionCache = JSON.stringify(data); } catch (_) {}
    // カスタムイベントでも通知（SPA遷移後にリスナー登録済みの場合）
    document.dispatchEvent(new CustomEvent('ytl-captions', { detail: data }));
    // MAIN world から字幕本文を fetch（診断ログ付き）
    fetchAndStoreCaptions(data.tracks, vid);
  }

  // ytInitialPlayerResponse の setter を横取り（SPA遷移でも捕捉）
  try {
    let _v = window.ytInitialPlayerResponse;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      get: () => _v,
      set: (v) => { _v = v; storeAndDispatch(v); },
      configurable: true,
    });
    if (_v) storeAndDispatch(_v);
  } catch (_) {}

  // YouTube のナビゲーションイベントでも再取得
  document.addEventListener('yt-page-data-updated', () => {
    try { storeAndDispatch(window.ytInitialPlayerResponse); } catch (_) {}
  });
})();
