<script setup>
import { ref, onMounted, computed } from 'vue'; // computed を追加

// --- Notification Subscription Logic ---
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref('');
function urlBase64ToUint8Array(base64String) { /* ... (内容は省略) ... */
  const padding = '='.repeat((4 - base64String.length % 4) % 4); const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); const rawData = window.atob(base64); const outputArray = new Uint8Array(rawData.length); for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); } return outputArray;
}
async function subscribeToNotifications() { /* ... (内容は省略) ... */
  subscriptionStatus.value = '処理中...'; if (!('serviceWorker' in navigator) || !('PushManager' in window)) { subscriptionStatus.value = 'エラー: プッシュ通知はこのブラウザではサポートされていません。'; console.error('Push messaging is not supported'); return; } try { console.log('Registering service worker...'); const registration = await navigator.serviceWorker.register('/sw.js'); console.log('Service Worker registered:', registration); await navigator.serviceWorker.ready; console.log('Service Worker ready.'); console.log('Requesting notification permission...'); const permission = await Notification.requestPermission(); if (permission !== 'granted') { subscriptionStatus.value = '通知の許可が得られませんでした。'; console.error('Permission not granted for Notification'); return; } console.log('Notification permission granted.'); console.log('Subscribing to push manager...'); if (!vapidPublicKey) { subscriptionStatus.value = 'エラー: VAPID公開鍵が設定されていません(env)。'; console.error('VAPID public key is not defined. Check VITE_VAPID_PUBLIC_KEY env var.'); return; } console.log('VAPID Public Key from env for subscribe:', vapidPublicKey); let subscription; try { const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey); console.log('Converted applicationServerKey (first 5 bytes):', applicationServerKey ? applicationServerKey.slice(0, 5) : 'null or undefined'); subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey }); console.log('User is subscribed:', subscription); } catch (subscribeError) { console.error('Error during pushManager.subscribe:', subscribeError); subscriptionStatus.value = `購読中にエラーが発生しました: ${subscribeError.message}`; return; } console.log('Sending subscription to server...'); const response = await fetch('/api/v1/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', }, body: JSON.stringify({ subscription: subscription }), }); if (!response.ok) { const errorData = await response.json(); throw new Error(`サーバーエラー: ${response.status} ${response.statusText} - ${errorData.error || '不明なエラー'}`); } const result = await response.json(); console.log('Server response:', result); subscriptionStatus.value = `購読に成功しました！ (${result.message})`; } catch (error) { if (!subscriptionStatus.value.includes('購読中にエラー')) { subscriptionStatus.value = `エラーが発生しました: ${error.message}`; } console.error('Error during subscription process:', error); }
}
// --- End Notification Subscription Logic ---

// --- Report Display Logic ---
const reports = ref([]); // data.recentReports を格納
const monthlySummary = ref(null); // ★ このバージョンでは monthlySummary は使わない
const isLoading = ref(false);
const fetchError = ref(null);

// ref 定義の後など、<script setup> 内の適切な場所に追加:

const sortedReports = computed(() => {
  // reports データがまだ読み込まれていない場合は空の配列を返す
  if (!reports.value || reports.value.length === 0) {
    return [];
  }
  // 元の reports 配列を直接変更しないように、コピー([...])してからソートする
  return [...reports.value].sort((a, b) => {
    try {
      // report_date (例: "2025/04/22") を Date オブジェクトに変換して比較する
      // スラッシュ区切りをハイフン区切りに置換してから Date に渡すと、より確実に解釈される
      const dateA = new Date(a.report_date.replace(/\//g, '-'));
      const dateB = new Date(b.report_date.replace(/\//g, '-'));

      // 無効な日付オブジェクトが生成された場合 (例: report_date が不正な形式) は
      // ソート順を変えない (エラー回避)
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
         console.warn('Invalid date found during sort:', a.report_date, b.report_date);
         return 0;
      }

      // 降順 (新しい日付が先) でソート
      return dateB - dateA;
      // ※もし降順 (新しい日付が先) にしたい場合は return dateB - dateA; に変更
    } catch (e) {
      // 予期せぬエラーが発生した場合もソート順を変えない
      console.error("Error during report sorting:", a?.report_date, b?.report_date, e);
      return 0;
    }
  });
});



function formatDateTime(isoString) { /* ... (内容は省略) ... */
  if (!isoString) return 'N/A'; try { const date = new Date(isoString); return date.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { console.error("Error formatting date:", e); return isoString; }
}

// fetchReports function (API応答形式に対応しつつ、reportsだけを使う)
async function fetchReports() {
  isLoading.value = true;
  fetchError.value = null;
  reports.value = [];
  monthlySummary.value = null; // ★ 開始時にリセット

  console.log('Fetching reports and summary from /api/v1/reports...'); // メッセージを少し変更
  try {
    const response = await fetch('/api/v1/reports');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }
    const data = await response.json(); // { recentReports: [], monthlySummary: {} } を期待

    if (data && data.recentReports) { // recentReports があればOK
        reports.value = data.recentReports; // リストデータだけを保存

        // ★ monthlySummary も ref に保存する ★
        if (data.monthlySummary) {
             monthlySummary.value = data.monthlySummary;
             console.log('Fetched monthly summary:', monthlySummary.value); // 保存した値をログ表示
        } else {
             console.warn('API response missing monthlySummary');
             monthlySummary.value = null; // 見つからない場合もリセット
        }
        console.log('Fetched reports successfully:', reports.value.length);

    } else {
        console.error('Unexpected response structure (missing recentReports):', data);
        throw new Error('APIからレポートリストが含まれない応答がありました。');
    }

  } catch (error) {
    console.error('Error fetching data:', error); // メッセージを少し変更
    fetchError.value = `データ取得に失敗: ${error.message}`; // メッセージを少し変更
    reports.value = [];
    monthlySummary.value = null; // ★ エラー時もリセット
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  fetchReports();
});
// --- End Report Display Logic ---
</script>

<template>
  <div>
    <h1>日報アプリ - 通知設定</h1>
    <p>日報が届いたときにプッシュ通知を受け取るには、以下のボタンを押して通知を許可してください。</p>
    <button @click="subscribeToNotifications">通知を購読する</button>
    <p v-if="subscriptionStatus">{{ subscriptionStatus }}</p>
  </div>
  <hr> <div>
        <h2>月次集計</h2>
        <div v-if="isLoading">集計データを読み込み中...</div>
        <div v-else-if="fetchError" style="color: red;">集計データの読み込みエラー: {{ fetchError }}</div>
        <div v-else-if="monthlySummary">
          <p><strong>総売上:</strong> {{ monthlySummary.totalSales?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>月間目標:</strong> {{ monthlySummary.target?.toLocaleString() ?? 'N/A' }} 円</p>
          <p v-if="monthlySummary.target > 0">
            <strong>達成率:</strong> {{ ((monthlySummary.totalSales / monthlySummary.target) * 100).toFixed(1) }} %
          </p>
          <p><strong>総客数:</strong> {{ monthlySummary.totalVisitors ?? 'N/A' }} 人</p>
          <p><strong>新規客数:</strong> {{ monthlySummary.totalNewCustomers ?? 'N/A' }} 人</p>
          <p><strong>染客数:</strong> {{ monthlySummary.totalDyeCustomers ?? 'N/A' }} 人</p>
          <p><strong>レポート数:</strong> {{ monthlySummary.reportCount ?? 'N/A' }} 件</p>
          <p v-if="monthlySummary.lastUpdated">
            <small>最終集計日時: {{ formatDateTime(monthlySummary.lastUpdated) }}</small>
            </p>
        </div>
        <p v-else-if="!isLoading && !fetchError">月次集計データがありません。</p>
      </div>
      <hr> ```


  <hr>

  <div>
    <h2>最近の日報一覧</h2>
    <button @click="fetchReports" :disabled="isLoading">
      {{ isLoading ? '読み込み中...' : '最新情報に更新' }}
    </button>
     <p v-if="fetchError" style="color: red;">{{ fetchError }}</p>

    <div v-if="isLoading">レポートリストを読み込んでいます...</div>

    <div v-else-if="reports.length > 0" class="report-list-cards">
      <div v-for="report in sortedReports" :key="report.id" class="report-card">
         <h3>{{ report.report_date }} - {{ report.store_name }}</h3>
         <p><strong>売上:</strong> {{ report.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>日次目標:</strong> {{ report.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>月間目標:</strong> {{ report.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>来店:</strong> {{ report.visitor_count ?? 'N/A' }} 人 (新規: {{ report.new_customer_count ?? 'N/A' }}, 染め: {{ report.dye_customer_count ?? 'N/A' }})</p>
         <p v-if="report.comment"><strong>コメント:</strong><br><span class="comment-text">{{ report.comment }}</span></p>
         <small class="report-meta">登録日時: {{ formatDateTime(report.createdAt) }} (ID: {{ report.id }})</small>
      </div>
    </div>
    <p v-else-if="!fetchError && !isLoading">表示できる最近の日報データがありません。</p>
  </div>
</template>

<style scoped>
  /* Card layout styles (from #165 / #172) */
   button { padding: 10px 20px; font-size: 16px; cursor: pointer; margin-right: 10px; }
   p { margin-top: 15px; }
   hr { margin: 30px 0; border: 0; border-top: 1px solid #eee; }
   h1, h2 { color: #333; } h3 { color: #2c3e50; }
   .report-list-cards { display: flex; flex-direction: column; gap: 16px; margin-top: 15px; }
   .report-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; background-color: #ffffff; box-shadow: 0 2px 5px rgba(0,0,0,0.08); word-wrap: break-word; }
   .report-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.1em; border-bottom: 1px solid #eee; padding-bottom: 8px; }
   .report-card p { margin: 6px 0; font-size: 0.95em; line-height: 1.5; color: #333; }
   .report-card p strong { color: #555; margin-right: 5px; font-weight: 600; }
   .report-card .comment-text { display: block; margin-top: 4px; white-space: pre-wrap; color: #555; max-height: 100px; overflow-y: auto; background-color: #f9f9f9; padding: 5px; border-radius: 4px; font-size: 0.9em; }
   .report-card .report-meta { display: block; margin-top: 12px; font-size: 0.8em; color: #888; }
   @media (max-width: 600px) { .report-card { border-radius: 4px; padding: 12px; } .report-card h3 { font-size: 1em; margin-bottom: 8px; padding-bottom: 6px; } .report-card p { font-size: 0.9em; } .report-card .comment-text { max-height: 80px; } }
   /* サマリー用のスタイルは不要 */
</style>