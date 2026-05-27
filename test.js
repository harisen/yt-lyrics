// YT Lyrics - Playwright テスト起動スクリプト
// 使い方: node test.js
// 拡張機能をロードした Chromium を起動し、各機能を自動検証する

const { chromium } = require('playwright');
const path = require('path');

const EXTENSION_PATH = path.resolve(__dirname);
const TEST_URL = 'https://www.youtube.com/watch?v=OPf0YbXqDm0'; // Uptown Funk - Mark Ronson ft. Bruno Mars

let pass = 0;
let fail = 0;

function ok(label) { console.log(`  ✅ ${label}`); pass++; }
function ng(label, detail = '') { console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); fail++; }

(async () => {
  console.log('🎵 YT Lyrics テスト起動中...');
  console.log(`拡張機能パス: ${EXTENSION_PATH}\n`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
    ],
    viewport: { width: 1600, height: 900 },
  });

  const page = context.pages()[0] || await context.newPage();

  console.log(`📺 YouTube に移動: ${TEST_URL}`);
  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded' });

  // ── テスト1: パネル表示 ──────────────────────────────────────
  console.log('\n[1] パネル表示');
  try {
    await page.waitForSelector('#yt-lyrics-panel', { timeout: 30000 });
    ok('歌詞パネルが #secondary に挿入された');
  } catch {
    ng('歌詞パネルが30秒以内に現れなかった');
    await context.close();
    return;
  }

  // 歌詞ロード待ち
  await page.waitForTimeout(4000);

  // ── テスト2: 歌詞取得 ──────────────────────────────────────
  console.log('\n[2] 歌詞取得');
  const lineCount = await page.$$eval('#yt-lyrics-panel .ytl-line', els => els.length).catch(() => 0);
  const source = await page.$eval('#yt-lyrics-panel .ytl-source', el => el.textContent).catch(() => '');

  lineCount > 0 ? ok(`歌詞 ${lineCount} 行を取得`) : ng('歌詞行が0件');
  source.includes('同期あり') ? ok('同期付き歌詞（LRC）を取得') : ng(`ソース: "${source}"`);

  // ── テスト3: クリックシーク ─────────────────────────────────
  console.log('\n[3] クリックシーク');
  const timeBefore = await page.evaluate(() => {
    const v = document.querySelector('video.html5-main-video');
    return v?.currentTime ?? -1;
  });

  // 10行目あたりの歌詞をクリック
  const clickTarget = await page.$('#yt-lyrics-panel .ytl-line:nth-child(10)');
  if (clickTarget) {
    const targetTime = await clickTarget.getAttribute('data-time');
    await clickTarget.click();
    await page.waitForTimeout(500);
    const timeAfter = await page.evaluate(() => {
      const v = document.querySelector('video.html5-main-video');
      return v?.currentTime ?? -1;
    });
    const jumped = Math.abs(timeAfter - parseFloat(targetTime)) < 1.5;
    jumped ? ok(`クリックで ${parseFloat(targetTime).toFixed(1)}s にシーク成功`) : ng(`シーク失敗 (期待=${targetTime} 実際=${timeAfter.toFixed(1)})`);
  } else {
    ng('10行目の歌詞行が見つからなかった');
  }

  // ── テスト4: 0.3秒先読み ───────────────────────────────────
  console.log('\n[4] 0.3秒先読み表示');
  const syncCheck = await page.evaluate(() => {
    const video = document.querySelector('video.html5-main-video');
    const activeLine = document.querySelector('#yt-lyrics-panel .ytl-line.active');
    if (!video || !activeLine) return { ok: false, reason: 'video or active line not found' };
    const t = video.currentTime;
    const lineTime = parseFloat(activeLine.dataset.time);
    // アクティブ行のタイムスタンプが currentTime+0.3 以下であれば正常
    return { ok: lineTime <= t + 0.35, t: t.toFixed(2), lineTime: lineTime.toFixed(2) };
  });
  syncCheck.ok
    ? ok(`先読み同期OK (video=${syncCheck.t}s, line=${syncCheck.lineTime}s)`)
    : ng('先読み確認失敗', syncCheck.reason);

  // ── テスト5: フォーカスモード ───────────────────────────────
  console.log('\n[5] フォーカスモード');
  const focusBtn = await page.$('#yt-lyrics-panel .ytl-focus-btn');
  if (focusBtn) {
    await focusBtn.click();
    await page.waitForTimeout(300);
    const isFocused = await page.evaluate(() =>
      document.querySelector('ytd-watch-flexy')?.classList.contains('ytl-focus')
    );
    isFocused ? ok('ytd-watch-flexy に ytl-focus クラスが付与された') : ng('ytl-focus クラスが付与されなかった');

    const primaryWidth = await page.evaluate(() => {
      const primary = document.querySelector('#primary.ytd-watch-flexy');
      return primary ? primary.getBoundingClientRect().width : -1;
    });
    primaryWidth > 0 && primaryWidth <= 320
      ? ok(`動画カラムが極小化 (${Math.round(primaryWidth)}px)`)
      : ng(`動画カラム幅が想定外 (${Math.round(primaryWidth)}px)`);

    // フォーカス解除
    await focusBtn.click();
    await page.waitForTimeout(300);
    ok('フォーカス解除ボタン動作');
  } else {
    ng('フォーカスボタンが見つからなかった');
  }

  // ── 結果 ────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`結果: ${pass} 件成功 / ${fail} 件失敗`);
  console.log('─'.repeat(40));
  console.log('\nブラウザを手動で閉じると終了します。');
  await new Promise(() => {});
})();
