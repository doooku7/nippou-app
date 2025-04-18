<script setup>
import { ref } from 'vue'

// VAPID公開鍵を環境変数から取得 (Viteの機能)
// Vercelの環境変数には VITE_VAPID_PUBLIC_KEY という名前で設定する必要がある
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref(''); // ユーザーへのメッセージ表示用

// Base64エンコードされた文字列をUint8Arrayに変換するヘルパー関数
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// 通知購読処理 (デバッグ用 console.log 追加・try/catch強化版)
async function subscribeToNotifications() {
  subscriptionStatus.value = '処理中...';

  // 1. Service Worker と Push API が使えるかチェック
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    subscriptionStatus.value = 'エラー: プッシュ通知はこのブラウザではサポートされていません。';
    console.error('Push messaging is not supported');
    return;
  }

  try { // Service Worker登録から全体をtryで囲む
    // 2. Service Worker を登録
    console.log('Registering service worker...');
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered:', registration);

    // Service Worker が有効になるのを待つ
    await navigator.serviceWorker.ready;
    console.log('Service Worker ready.');

    // 3. 通知の許可をユーザーに求める
    console.log('Requesting notification permission...');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      subscriptionStatus.value = '通知の許可が得られませんでした。';
      console.error('Permission not granted for Notification');
      return;
    }
    console.log('Notification permission granted.');

    // 4. Push Manager を使って購読情報を取得
    console.log('Subscribing to push manager...');
    if (!vapidPublicKey) {
       subscriptionStatus.value = 'エラー: VAPID公開鍵が設定されていません(env)。';
       console.error('VAPID public key is not defined. Check VITE_VAPID_PUBLIC_KEY env var.');
       return;
    }

    // ★★★ デバッグ用ログを追加 ★★★
    console.log('VAPID Public Key from env for subscribe:', vapidPublicKey);
    console.log('Type:', typeof vapidPublicKey);
    console.log('Length:', vapidPublicKey ? vapidPublicKey.length : 0);
    // ★★★ ここまで追加 ★★★

    let subscription; // subscription を try の外でアクセスできるように宣言

    try { // subscribe呼び出し自体をtry...catchで囲む
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey); // 変換
      // 変換後も少しログ出力 (最初の5バイトだけ表示)
      console.log('Converted applicationServerKey (first 5 bytes):', applicationServerKey ? applicationServerKey.slice(0, 5) : 'null or undefined');

      // subscribeを呼び出す
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey // 変換後のキーを使う
      });
      console.log('User is subscribed:', subscription);

    } catch (subscribeError) {
       // ここで "The string did not match..." エラーが捕まるはず
       console.error('Error during pushManager.subscribe:', subscribeError);
       subscriptionStatus.value = `購読中にエラーが発生しました: ${subscribeError.message}`;
       return; // エラーがあったらここで中断
    }

    // 5. 購読情報をバックエンドに送信 (subscribeが成功した場合のみ実行)
    console.log('Sending subscription to server...');
    const response = await fetch('/api/v1/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ subscription: subscription }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`サーバーエラー: ${response.status} ${response.statusText} - ${errorData.error || '不明なエラー'}`);
    }

    const result = await response.json();
    console.log('Server response:', result);
    subscriptionStatus.value = `購読に成功しました！ (${result.message})`;

  } catch (error) {
    // 全体のエラーハンドリング
    // subscribeエラーは上で処理したので、それ以外のエラーを処理
    if (!subscriptionStatus.value.includes('購読中にエラー')) {
         subscriptionStatus.value = `エラーが発生しました: ${error.message}`;
    }
    console.error('Error during subscription process:', error);
  }
}
</script>

<template>
  <div>
    <h1>日報アプリ - 通知設定</h1>
    <p>日報が届いたときにプッシュ通知を受け取るには、以下のボタンを押して通知を許可してください。</p>
    <button @click="subscribeToNotifications">通知を購読する</button>
    <p v-if="subscriptionStatus">{{ subscriptionStatus }}</p>
  </div>
</template>

<style scoped>
/* 必要ならスタイルを追加 */
button {
  padding: 10px 20px;
  font-size: 16px;
  cursor: pointer;
}
p {
  margin-top: 15px;
  font-style: italic;
}
</style>