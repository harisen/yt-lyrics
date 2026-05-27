// YT Lyrics - background service worker
// Ctrl+Shift+U で拡張機能をリロードし、その後タブをリロードする
// （拡張機能を先にリロードしないとタブが旧コードで動く）

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'dev-reload') return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId) {
      // タブIDを保存してから拡張機能をリロード
      // 次回起動時に onInstalled でタブをリロードする
      chrome.storage.local.set({ pendingReloadTab: tabId }, () => {
        chrome.runtime.reload();
      });
    } else {
      chrome.runtime.reload();
    }
  });
});

// 拡張機能リロード後の初回起動時: 保存したタブをリロード
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('pendingReloadTab', ({ pendingReloadTab }) => {
    if (pendingReloadTab) {
      chrome.storage.local.remove('pendingReloadTab');
      chrome.tabs.reload(pendingReloadTab);
    }
  });
});
