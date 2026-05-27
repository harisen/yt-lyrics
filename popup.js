// popup.js - 現在のタブの状態を確認して表示

async function updateStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageStatus = document.getElementById('page-status');
  const panelStatus = document.getElementById('panel-status');

  const isYouTubeWatch = tab?.url?.includes('youtube.com/watch');

  if (isYouTubeWatch) {
    pageStatus.innerHTML = '<span class="status-chip ok">YouTube動画</span>';

    // content script にパネルの存在を確認
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => !!document.getElementById('yt-lyrics-panel'),
      });
      const panelExists = res?.[0]?.result;
      panelStatus.innerHTML = panelExists
        ? '<span class="status-chip ok">表示中</span>'
        : '<span class="status-chip ng">非表示</span>';
    } catch (_) {
      panelStatus.innerHTML = '<span class="status-chip ng">確認失敗</span>';
    }
  } else {
    pageStatus.innerHTML = '<span class="status-chip ng">YouTube外</span>';
    panelStatus.innerHTML = '<span class="status-chip ng">—</span>';
  }
}

updateStatus();
