<script setup>
import { ref, onMounted } from 'vue'; // onMounted をインポート

// --- 既存の通知購読関連 ---
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref('');
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
async function subscribeToNotifications() {
  subscriptionStatus.value = '処理中...';
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    subscriptionStatus.value = 'エラー: プッシュ通知はこのブラウザではサポートされていません。';
    console.error('Push messaging is not supported');
    return;
  }
  try {
    console.log('Registering service worker...');
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('Service Worker registered:', registration);
    await navigator.serviceWorker.ready;
    console.log('Service Worker ready.');
    console.log('Requesting notification permission...');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      subscriptionStatus.value = '通知の許可が得られませんでした。';
      console.error('Permission not granted for Notification');
      return;
    }
    console.log('Notification permission granted.');
    console.log('Subscribing to push manager...');
    if (!vapidPublicKey) {
       subscriptionStatus.value = 'エラー: VAPID公開鍵が設定されていません(env)。';
       console.error('VAPID public key is not defined. Check VITE_VAPID_PUBLIC_KEY env var.');
       return;
    }
    console.log('VAPID Public Key from env for subscribe:', vapidPublicKey); // デバッグログ
    let subscription;
    try {
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
      console.log('Converted applicationServerKey (first 5 bytes):', applicationServerKey ? applicationServerKey.slice(0, 5) : 'null or undefined');
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });
      console.log('User is subscribed:', subscription);
    } catch (subscribeError) {
       console.error('Error during pushManager.subscribe:', subscribeError);
       subscriptionStatus.value = `購読中にエラーが発生しました: ${subscribeError.message}`;
       return;
    }
    console.log('Sending subscription to server...');
    const response = await fetch('/api/v1/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', },
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
    if (!subscriptionStatus.value.includes('購読中にエラー')) {
         subscriptionStatus.value = `エラーが発生しました: ${error.message}`;
    }
    console.error('Error during subscription process:', error);
  }
}
// --- ここまで既存の通知購読関連 ---

// --- レポート表示用のコード ---
const reports = ref([]); // Holds data.recentReports
const monthlySummary = ref(null); // ★ New ref for summary data
const isLoading = ref(false);
const fetchError = ref(null);

function formatDateTime(isoString) {
  if (!isoString) return 'N/A';
  try {
    const date = new Date(isoString);
    return date.toLocaleString('ja-JP', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  } catch (e) {
    console.error("Error formatting date:", e);
    return isoString; // フォーマット失敗時は元の文字列を返す
  }
}

// Modified fetchReports function
async function fetchReports() {
  isLoading.value = true;
  fetchError.value = null;
  reports.value = []; // Clear previous data on refresh
  monthlySummary.value = null; // Clear previous summary
  console.log('Fetching reports and summary from /api/v1/reports...');
  try {
    const response = await fetch('/api/v1/reports');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }
    // ★ 応答の構造が変わったので、data.recentReports と data.monthlySummary を使う
    const data = await response.json();

    if (data && data.recentReports && data.monthlySummary) {
        reports.value = data.recentReports;
        monthlySummary.value = data.monthlySummary; // ★ サマリーデータを保存
        console.log('Fetched reports successfully:', reports.value.length);
        console.log('Fetched monthly summary:', monthlySummary.value);
    } else {
        // APIからの応答が期待する形式でなかった場合の処理
        console.error('Unexpected response structure:', data);
        throw new Error('APIから予期しない形式の応答がありました。');
    }

  } catch (error) {
    console.error('Error fetching reports/summary:', error);
    fetchError.value = `レポート/集計の取得に失敗しました: ${error.message}`;
    reports.value = [];
    monthlySummary.value = null;
  } finally {
    isLoading.value = false;
  }
}

// コンポーネントがマウントされた（画面に表示された）ときにレポートを取得
onMounted(() => {
  fetchReports();
});
// --- ここまでレポート表示用のコード ---

</script>

<template>
  <div>
    <h1>日報アプリ - 通知設定</h1>
    <p>日報が届いたときにプッシュ通知を受け取るには、以下のボタンを押して通知を許可してください。</p>
    <button @click="subscribeToNotifications">通知を購読する</button>
    <p v-if="subscriptionStatus">{{ subscriptionStatus }}</p>
  </div>

  <hr>

  <div>
    <h2>レポート状況</h2>
    <button @click="fetchReports" :disabled="isLoading">
      {{ isLoading ? '読み込み中...' : '最新情報に更新' }}
    </button>
     <p v-if="fetchError" style="color: red;">{{ fetchError }}</p>

    <div v-if="!isLoading && monthlySummary" class="summary-section">
      <h3>今月の集計 ({{ monthlySummary.reportCount }} 件のレポートに基づく)</h3>
      <div class="summary-grid">
          <p><strong>総売上:</strong> {{ monthlySummary.totalSales?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>月間目標:</strong> {{ monthlySummary.target?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>目標差額:</strong> {{ (monthlySummary.totalSales - monthlySummary.target)?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>総来店数:</strong> {{ monthlySummary.totalVisitors?.toLocaleString() ?? 'N/A' }} 人</p>
          <p><strong>総新規数:</strong> {{ monthlySummary.totalNewCustomers?.toLocaleString() ?? 'N/A' }} 人</p>
          <p><strong>総染め数:</strong> {{ monthlySummary.totalDyeCustomers?.toLocaleString() ?? 'N/A' }} 人</p>
      </div>
    </div>
    <div v-else-if="!isLoading && !fetchError">
        <p>今月の集計データはありません。</p>
    </div>
    <hr style="margin-top: 25px;"> <h3>最近の日報リスト</h3>
    <div v-if="isLoading">レポートリストを読み込んでいます...</div>

    <div v-else-if="reports.length > 0" class="report-list-cards">
      <div v-for="report in reports" :key="report.id" class="report-card">
         <h3>{{ report.report_date }} - {{ report.store_name }}</h3>
         <p><strong>売上:</strong> {{ report.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>日次目標:</strong> {{ report.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>月間目標:</strong> {{ report.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p> <p><strong>来店:</strong> {{ report.visitor_count ?? 'N/A' }} 人 (新規: {{ report.new_customer_count ?? 'N/A' }}, 染め: {{ report.dye_customer_count ?? 'N/A' }})</p>
         <p v-if="report.comment"><strong>コメント:</strong><br><span class="comment-text">{{ report.comment }}</span></p>
         <small class="report-meta">登録日時: {{ formatDateTime(report.createdAt) }} (ID: {{ report.id }})</small>
      </div>
    </div>
    <p v-else-if="!fetchError && !isLoading">表示できる最近の日報データがありません。</p>
  </div>
</template>

<style scoped>
  /* ... (以前定義したスタイル: button, p, hr, h1, h2, カード関連, サマリー関連) ... */
   button { padding: 10px 20px; font-size: 16px; cursor: pointer; margin-right: 10px; }
   p { margin-top: 15px; }
   hr { margin: 30px 0; border: 0; border-top: 1px solid #eee; }
   h1, h2 { color: #333; } h3 { color: #2c3e50; }

   /* カードリストとカード用のスタイル */
   .report-list-cards { display: flex; flex-direction: column; gap: 16px; margin-top: 15px; }
   .report-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; background-color: #ffffff; box-shadow: 0 2px 5px rgba(0,0,0,0.08); word-wrap: break-word; }
   .report-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.1em; border-bottom: 1px solid #eee; padding-bottom: 8px; }
   .report-card p { margin: 6px 0; font-size: 0.95em; line-height: 1.5; color: #333; }
   .report-card p strong { color: #555; margin-right: 5px; font-weight: 600; }
   .report-card .comment-text { display: block; margin-top: 4px; white-space: pre-wrap; color: #555; max-height: 100px; overflow-y: auto; background-color: #f9f9f9; padding: 5px; border-radius: 4px; font-size: 0.9em; }
   .report-card .report-meta { display: block; margin-top: 12px; font-size: 0.8em; color: #888; }
   @media (max-width: 600px) { .report-card { border-radius: 4px; padding: 12px; } .report-card h3 { font-size: 1em; margin-bottom: 8px; padding-bottom: 6px; } .report-card p { font-size: 0.9em; } .report-card .comment-text { max-height: 80px; } }

   /* サマリーセクションのスタイル */
   .summary-section { background-color: #f0f9ff; border: 1px solid #c3e1f7; border-radius: 8px; padding: 20px; margin-top: 25px; margin-bottom: 25px; }
   .summary-section h3 { margin-top: 0; margin-bottom: 15px; color: #005a9e; border-bottom: 1px solid #aed6f1; padding-bottom: 10px; }
   .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
   .summary-grid p { margin: 0; padding: 8px 10px; background-color: #e2f1ff; border-radius: 4px; font-size: 0.95em; color: #333; }
   .summary-grid p strong { color: #004c8c; margin-right: 5px; }
</style>