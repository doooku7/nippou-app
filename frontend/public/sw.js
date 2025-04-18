// frontend/public/sw.js

// Service Worker がプッシュ通知を受け取ったときの処理
self.addEventListener('push', event => {
    console.log('[Service Worker] Push Received.');
  
    // 通知で送られてくるデータを取得しようと試みる (JSON形式を想定)
    let data = {};
    if (event.data) {
      try {
        data = event.data.json(); // JSONとして解析
      } catch (e) {
        console.error('Push event data parse error:', e);
        // 解析失敗した場合やテキストデータの場合
        data = { title: '新しい通知', body: event.data.text() || '通知が届きました。' };
      }
    } else {
      // データがない場合のデフォルト
       data = { title: '新しい通知', body: '通知が届きました。' };
    }
  
    const title = data.title || '日報アプリ通知'; // タイトルがない場合のデフォルト
    const options = {
      body: data.body || '新しい情報があります。', // 本文がない場合のデフォルト
      icon: '/favicon.ico', // TODO: publicフォルダに適切なアイコンを配置し、パスを指定する
      // badge: '/badge-icon.png', // TODO: 必要ならバッジアイコンも用意
      // data: data.data // 通知クリック時に使いたいデータがあれば設定
    };
  
    // 通知を表示する処理 (waitUntilでService Workerが終了しないようにする)
    event.waitUntil(self.registration.showNotification(title, options));
  });
  
  // Service Worker インストール時のイベント (今は特に何もしない)
  self.addEventListener('install', event => {
    console.log('[Service Worker] Install');
    // self.skipWaiting(); // 必要に応じて古いSWを待たずに新しいSWを有効化
  });
  
  // Service Worker アクティブ化時のイベント (今は特に何もしない)
  self.addEventListener('activate', event => {
    console.log('[Service Worker] Activate');
    // event.waitUntil(clients.claim()); // 必要に応じて即座に制御を開始
  });