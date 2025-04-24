<script setup>
import { ref, onMounted, computed } from 'vue';
// グラフコンポーネントをインポート
import StoreSalesChart from './components/StoreSalesChart.vue'; // パスを確認

// --- Notification Subscription Logic (変更なし) ---
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref('');
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4); const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); const rawData = window.atob(base64); const outputArray = new Uint8Array(rawData.length); for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); } return outputArray;
}
async function subscribeToNotifications() {
  subscriptionStatus.value = '処理中...'; if (!('serviceWorker' in navigator) || !('PushManager' in window)) { subscriptionStatus.value = 'エラー: プッシュ通知はこのブラウザではサポートされていません。'; console.error('Push messaging is not supported'); return; } try { console.log('Registering service worker...'); const registration = await navigator.serviceWorker.register('/sw.js'); console.log('Service Worker registered:', registration); await navigator.serviceWorker.ready; console.log('Service Worker ready.'); console.log('Requesting notification permission...'); const permission = await Notification.requestPermission(); if (permission !== 'granted') { subscriptionStatus.value = '通知の許可が得られませんでした。'; console.error('Permission not granted for Notification'); return; } console.log('Notification permission granted.'); console.log('Subscribing to push manager...'); if (!vapidPublicKey) { subscriptionStatus.value = 'エラー: VAPID公開鍵が設定されていません(env)。'; console.error('VAPID public key is not defined. Check VITE_VAPID_PUBLIC_KEY env var.'); return; } console.log('VAPID Public Key from env for subscribe:', vapidPublicKey); let subscription; try { const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey); console.log('Converted applicationServerKey (first 5 bytes):', applicationServerKey ? applicationServerKey.slice(0, 5) : 'null or undefined'); subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey }); console.log('User is subscribed:', subscription); } catch (subscribeError) { console.error('Error during pushManager.subscribe:', subscribeError); subscriptionStatus.value = `購読中にエラーが発生しました: ${subscribeError.message}`; return; } console.log('Sending subscription to server...'); const response = await fetch('/api/v1/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', }, body: JSON.stringify({ subscription: subscription }), }); if (!response.ok) { const errorData = await response.json(); throw new Error(`サーバーエラー: ${response.status} ${response.statusText} - ${errorData.error || '不明なエラー'}`); } const result = await response.json(); console.log('Server response:', result); subscriptionStatus.value = `購読に成功しました！ (${result.message})`; } catch (error) { if (!subscriptionStatus.value.includes('購読中にエラー')) { subscriptionStatus.value = `エラーが発生しました: ${error.message}`; } console.error('Error during subscription process:', error); }
}
// --- End Notification Subscription Logic ---

// --- Report Display Logic ---
const reports = ref([]); // 元のレポートリスト
const storesSummaryData = ref({});
const overallTargetData = ref(0);
const summaryLastUpdatedData = ref(null);
const isLoading = ref(true);
const fetchError = ref(null);

// ★★★ フィルター用に追加 ★★★
const selectedStore = ref(null); // 選択中の店舗名を保持 (nullなら全表示)

// 日付フォーマット関数 (変更なし)
function formatDateTime(isoString) {
  if (!isoString) return 'N/A'; try { const date = new Date(isoString); return date.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { console.error("Error formatting date:", e); return isoString; }
}

// API呼び出し関数 (変更なし)
async function fetchApiData() {
  isLoading.value = true;
  fetchError.value = null;
  reports.value = [];
  storesSummaryData.value = {};
  overallTargetData.value = 0;
  summaryLastUpdatedData.value = null;
  selectedStore.value = null; // ★ データ再取得時はフィルターも解除する

  console.log('Fetching reports and summaries from /api/v1/reports...');
  try {
    const response = await fetch('/api/v1/reports');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();

    if (data) {
        reports.value = data.recentReports || [];
        storesSummaryData.value = data.storesSummary || {};
        overallTargetData.value = data.overallTarget || 0;
        summaryLastUpdatedData.value = data.summaryLastUpdated || null;
        console.log('Fetched reports:', reports.value.length);
        console.log('Fetched stores summary:', storesSummaryData.value);
    } else {
        console.error('API response data is missing or invalid:', data);
        throw new Error('API応答の形式が不正です。');
    }
  } catch (error) {
    console.error('Error fetching data:', error);
    fetchError.value = `データ取得に失敗: ${error.message}`;
    reports.value = [];
    storesSummaryData.value = {};
    overallTargetData.value = 0;
    summaryLastUpdatedData.value = null;
  } finally {
    isLoading.value = false;
  }
}

// 日付順ソート用 computed (変更なし、降順のまま)
const sortedReports = computed(() => {
  if (!reports.value || reports.value.length === 0) {
    return [];
  }
  return [...reports.value].sort((a, b) => {
    try {
      const dateA = new Date(a.report_date.replace(/\//g, '-'));
      const dateB = new Date(b.report_date.replace(/\//g, '-'));
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
         console.warn('Invalid date found during sort:', a.report_date, b.report_date);
         return 0;
      }
      return dateB - dateA; // 降順
    } catch (e) {
      console.error("Error during report sorting:", a?.report_date, b?.report_date, e);
      return 0;
    }
  });
});

// ★★★ フィルター用関数を追加 ★★★
function filterByStore(storeName) {
  if (selectedStore.value === storeName) {
    // すでに選択されているカードを再度クリックしたらフィルター解除
    selectedStore.value = null;
  } else {
    // 新しい店舗名でフィルターを設定
    selectedStore.value = storeName;
  }
  console.log("Filtering by store:", selectedStore.value); // 動作確認用ログ
}

// ★★★ フィルターされたレポートリスト用 computed を追加 ★★★
const filteredAndSortedReports = computed(() => {
  // selectedStore.value が null または空文字なら、フィルターせずにソート済みの全件を返す
  if (!selectedStore.value) {
    return sortedReports.value;
  }
  // selectedStore.value と同じ store_name を持つレポートだけを抽出
  return sortedReports.value.filter(report => report.store_name === selectedStore.value);
});


// マウント時にデータを取得 (変更なし)
onMounted(() => {
  fetchApiData();
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

  <hr>
  <div>
    <h2>月次集計 (店舗別)</h2>
    <div v-if="isLoading">集計データを読み込み中...</div>
    <div v-else-if="fetchError" style="color: red;">集計データの読み込みエラー: {{ fetchError }}</div>
    <div v-else-if="Object.keys(storesSummaryData).length > 0">
      <p><strong>全体の月間目標:</strong> {{ overallTargetData?.toLocaleString() ?? 'N/A' }} 円</p>
      <p v-if="summaryLastUpdatedData">
        <small>最終集計日時: {{ formatDateTime(summaryLastUpdatedData) }}</small>
      </p>
      <div class="store-summary-cards">
        <div v-for="(summary, storeName) in storesSummaryData"
             :key="storeName"
             class="store-summary-card"
             @click="filterByStore(storeName)"
             style="cursor: pointer;"
             :class="{ 'selected-card': selectedStore === storeName }"> <h3>{{ storeName }}</h3>
          <p><strong>売上:</strong> {{ summary.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
           <p>
              <strong>売上差額<small>(対 日次目標計)</small>:</strong>
              <span v-if="typeof summary.sales_amount === 'number' && typeof summary.daily_target_amount === 'number'">
                {{ (summary.sales_amount - summary.daily_target_amount).toLocaleString() }} 円
              </span>
              <span v-else>計算不可</span>
            </p>
          <p><strong>客数:</strong> {{ summary.visitor_count ?? 'N/A' }} 人 (新規: {{ summary.new_customer_count ?? 'N/A' }}, 染め: {{ summary.dye_customer_count ?? 'N/A' }})</p>
          <p><strong>値引計:</strong> {{ summary.discount_amount?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>月間目標:</strong> {{ summary.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>日次目標計:</strong> {{ summary.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
          <p><strong>レポート数:</strong> {{ summary.reportCount ?? 'N/A' }} 件</p>
        </div>
      </div>

      <div style="margin-top: 30px; max-width: 700px; margin-left: auto; margin-right: auto; position: relative; height: 350px;">
        <h4 style="text-align: center;">店舗別 売上グラフ</h4>
        <StoreSalesChart :chart-data="storesSummaryData" />
      </div>

    </div>
    <p v-else>表示できる月次集計データがありません。</p>
  </div>
  <hr>

  <div>
    <h2>最近の日報一覧
      <button v-if="selectedStore" @click="filterByStore(null)" style="margin-left: 10px; font-size: 0.8em; padding: 4px 8px;">
         ({{ selectedStore }} のフィルター解除)
      </button>
    </h2>
    <button @click="fetchApiData" :disabled="isLoading">
      {{ isLoading ? '読み込み中...' : '最新情報に更新' }}
    </button>
     <div v-if="isLoading && reports.length === 0">レポートリストを読み込んでいます...</div>

    <div v-else-if="filteredAndSortedReports.length > 0" class="report-list-cards">
      <div v-for="report in filteredAndSortedReports" :key="report.id" class="report-card">
         <h3>{{ report.report_date }} - {{ report.store_name }}</h3>
         <p><strong>売上:</strong> {{ report.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>日次目標:</strong> {{ report.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>月間目標:</strong> {{ report.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
         <p><strong>来店:</strong> {{ report.visitor_count ?? 'N/A' }} 人 (新規: {{ report.new_customer_count ?? 'N/A' }}, 染め: {{ report.dye_customer_count ?? 'N/A' }})</p>
         <p v-if="report.comment"><strong>コメント:</strong><br><span class="comment-text">{{ report.comment }}</span></p>
         <small class="report-meta">登録日時: {{ formatDateTime(report.createdAt) }} (ID: {{ report.id }})</small>
      </div>
    </div>
 
    <p v-else-if="!isLoading && !fetchError">
      <span v-if="selectedStore" style="font-weight: bold;">{{ selectedStore }} の</span> 表示できる最近の日報データがありません。 </p>
 

  </div>
</template>

<style scoped>
  /* store-summary-cards 用のスタイル */
  .store-summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 16px;
    margin-top: 15px;
    margin-bottom: 15px;
  }
  .store-summary-card {
    border: 1px solid #d0d0d0;
    border-radius: 8px;
    padding: 12px 16px;
    background-color: #f9f9f9;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out; /* スムーズな変化 */
  }
   /* ★★★ 選択中カードのスタイル (任意) ★★★ */
  .store-summary-card.selected-card {
      border-color: #41B883; /* Vue Green */
      box-shadow: 0 3px 8px rgba(65, 184, 131, 0.5);
      border-width: 2px; /* 少し太くする */
  }
  .store-summary-card h3 {
    margin-top: 0;
    margin-bottom: 10px;
    font-size: 1.1em;
    color: #1a4a7a;
    border-bottom: 1px solid #ddd;
    padding-bottom: 6px;
  }
   .store-summary-card p {
    margin: 4px 0;
    font-size: 0.9em;
    color: #222222; /* 濃い灰色 */
  }
   .store-summary-card p strong {
    margin-right: 4px;
   }

   /* --- 既存のスタイル --- */
   button { padding: 10px 20px; font-size: 16px; cursor: pointer; margin-right: 10px; margin-bottom: 10px;}
   p { margin-top: 15px; }
   hr { margin: 30px 0; border: 0; border-top: 1px solid #eee; }
   /* 表題の文字色 */
   h1, h2 {
     color: #E0E0E0;
   }
   h4 {
      color: #D0D0D0;
      margin-bottom: 10px;
   }
   .report-list-cards { display: flex; flex-direction: column; gap: 16px; margin-top: 15px; }
   .report-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; background-color: #ffffff; box-shadow: 0 2px 5px rgba(0,0,0,0.08); word-wrap: break-word; }
   .report-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.1em; border-bottom: 1px solid #eee; padding-bottom: 8px; color: #2c3e50; }
   .report-card p { margin: 6px 0; font-size: 0.95em; line-height: 1.5; color: #333; }
   .report-card p strong { color: #555; margin-right: 5px; font-weight: 600; }
   .report-card .comment-text { display: block; margin-top: 4px; white-space: pre-wrap; color: #555; max-height: 100px; overflow-y: auto; background-color: #f9f9f9; padding: 5px; border-radius: 4px; font-size: 0.9em; }
   .report-card .report-meta { display: block; margin-top: 12px; font-size: 0.8em; color: #888; }
   @media (max-width: 600px) { .report-card { border-radius: 4px; padding: 12px; } .report-card h3 { font-size: 1em; margin-bottom: 8px; padding-bottom: 6px; } .report-card p { font-size: 0.9em; } .report-card .comment-text { max-height: 80px; } .store-summary-cards { grid-template-columns: 1fr; } }
</style>