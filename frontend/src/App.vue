<script setup>
import { ref, onMounted, computed } from 'vue';
import StoreSalesChart from './components/StoreSalesChart.vue'; // グラフコンポーネントのパスを確認
import { auth } from './firebaseConfig'; // Firebase設定ファイルのパスを確認
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

// --- Notification Subscription Logic ---
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref('');
// const isSubscribed = ref(false); // 必要ならコメント解除

// Service Worker を登録する関数
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Worker is not supported.');
    return null;
  }
  try {
    console.log('Registering service worker...');
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    console.log('Service Worker registered:', registration);
    await navigator.serviceWorker.ready;
    console.log('Service Worker ready.');
    return registration;
  } catch (error) {
    console.error('Service Worker registration failed:', error);
    subscriptionStatus.value = 'Service Workerの登録に失敗しました。';
    return null;
  }
}

// プッシュ通知の購読を開始する関数
async function subscribeToNotifications() {
  subscriptionStatus.value = '処理中...';

  if (!('PushManager' in window)) {
    subscriptionStatus.value = 'エラー: プッシュ通知はこのブラウザではサポートされていません。';
    console.error('Push messaging is not supported');
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  if (!registration) {
      subscriptionStatus.value = 'エラー: Service Workerが有効ではありません。';
      console.error('Service Worker not ready for push subscription.');
      return;
  }

  try {
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
    console.log('VAPID Public Key from env for subscribe:', vapidPublicKey);

    const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey
    });
    console.log('User is subscribed:', subscription);

    console.log('Sending subscription to server...');
    // ★ サーバーへの送信先APIエンドポイントを確認してください ★
    const response = await fetch('/api/v1/subscribe', { // ←★ エンドポイント確認！
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 'Authorization': `Bearer ${await currentUser.value?.getIdToken()}` // 認証が必要な場合
      },
      body: JSON.stringify({ subscription: subscription }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '不明なサーバーエラー' }));
      throw new Error(`サーバーエラー: ${response.status} ${response.statusText} - ${errorData.error}`);
    }
    const result = await response.json();
    console.log('Server response:', result);
    subscriptionStatus.value = `購読に成功しました！ (${result.message || '完了'})`;

  } catch (error) {
    console.error('Error during subscription process:', error);
    if (!subscriptionStatus.value.startsWith('エラー') && !subscriptionStatus.value.startsWith('購読中にエラー')) {
        subscriptionStatus.value = `エラーが発生しました: ${error.message}`;
    } else if (!subscriptionStatus.value.includes(error.message)) {
        // Optionally add more details: subscriptionStatus.value += ` ${error.message}`;
    }
    if (error.name === 'AbortError' || error.message.includes('subscribe')) {
        subscriptionStatus.value = `購読中にエラーが発生しました: ${error.message}`;
    }
  }
}

// Base64をUint8Arrayに変換する関数
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4); const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); const rawData = window.atob(base64); const outputArray = new Uint8Array(rawData.length); for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); } return outputArray;
}

// --- Report Display Logic ---
const reports = ref([]);
const storesSummaryData = ref({});
const summaryLastUpdatedData = ref(null);
const isLoading = ref(true);
const fetchError = ref(null);
const selectedStore = ref(null);

const email = ref('');
const password = ref('');
const authError = ref(null);
const currentUser = ref(null);

const now = new Date();
const displayYear = ref(now.getFullYear());
const displayMonth = ref(now.getMonth() + 1);

function formatDateTime(isoString) {
  if (!isoString) return 'N/A'; try { const date = new Date(isoString); return date.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { console.error("Error formatting date:", e); return isoString; }
}

async function fetchApiData(year = displayYear.value, month = displayMonth.value) {
  isLoading.value = true;
  fetchError.value = null;

  console.log(`Workspaceing data for ${year}-${month}...`);
  try {
    if (!currentUser.value) { throw new Error('ユーザーがログインしていません。'); }
    const idToken = await currentUser.value.getIdToken();
    const headers = { 'Authorization': `Bearer ${idToken}` };
    const apiUrl = `/api/v1/reports?year=${year}&month=${month}`; // ★ APIエンドポイント確認
    const response = await fetch(apiUrl, { headers: headers });

    if (!response.ok) {
      let errorMsg = `HTTP error! status: ${response.status}`;
      try { const errorData = await response.json(); errorMsg = errorData.error || errorMsg; } catch(e) { /* ignore */ }
      if (response.status === 401 || response.status === 403) { errorMsg = `アクセス権エラー: ${errorMsg}`; handleLogout(); }
      throw new Error(errorMsg);
    }
    const data = await response.json();

    if (data) {
        reports.value = data.recentReports || [];
        // storesSummaryData を更新
        storesSummaryData.value = data.storesSummary || {};
        summaryLastUpdatedData.value = data.summaryLastUpdated || null;
        displayYear.value = year;
        displayMonth.value = month;
        selectedStore.value = null; // データ取得成功時は選択を解除
    } else { throw new Error('API応答の形式が不正です。'); }
  } catch (error) {
    console.error('Error fetching data:', error);
    fetchError.value = `データ取得に失敗: ${error.message}`;
    reports.value = []; storesSummaryData.value = {}; summaryLastUpdatedData.value = null; selectedStore.value = null;
  } finally {
    isLoading.value = false;
  }
}

const sortedReports = computed(() => {
  if (!reports.value || reports.value.length === 0) { return []; }
  return [...reports.value].sort((a, b) => {
    try {
      const dateA = new Date(String(a.report_date).replace(/\//g, '-'));
      const dateB = new Date(String(b.report_date).replace(/\//g, '-'));
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) { return 0; }
      return dateB - dateA;
    } catch (e) {
      console.error("Error parsing date for sorting:", e);
      return 0;
    }
  });
});

function filterByStore(storeName) {
  selectedStore.value = (selectedStore.value === storeName) ? null : storeName;
}

const filteredAndSortedReports = computed(() => {
  if (!selectedStore.value) { return sortedReports.value; }
  return sortedReports.value.filter(report => report.store_name === selectedStore.value);
});

const calculatedOverallTarget = computed(() => {
  if (storesSummaryData.value && typeof storesSummaryData.value === 'object' && Object.keys(storesSummaryData.value).length > 0) {
    return Object.values(storesSummaryData.value).reduce((total, storeSummary) => {
      const target = (storeSummary && typeof storeSummary.monthly_target_amount === 'number') ? storeSummary.monthly_target_amount : 0;
      return total + target;
    }, 0);
  }
  return 0;
});

const calculatedOverallSales = computed(() => {
  if (storesSummaryData.value && typeof storesSummaryData.value === 'object' && Object.keys(storesSummaryData.value).length > 0) {
    return Object.values(storesSummaryData.value).reduce((total, storeSummary) => {
      const sales = (storeSummary && typeof storeSummary.sales_amount === 'number') ? storeSummary.sales_amount : 0;
      return total + sales;
    }, 0);
  }
  return 0;
});

// --- ▼▼▼ 追加: 売上順にソートされた店舗集計データの算出プロパティ ▼▼▼ ---
const sortedStoresSummary = computed(() => {
  if (!storesSummaryData.value || typeof storesSummaryData.value !== 'object') {
    return [];
  }
  // オブジェクトを [店名, 集計データ] の配列に変換
  return Object.entries(storesSummaryData.value)
    // sales_amount (売上) で降順ソート (売上が数値でない場合は 0 として扱う)
    .sort(([, summaryA], [, summaryB]) => {
      const salesA = (summaryA && typeof summaryA.sales_amount === 'number') ? summaryA.sales_amount : 0;
      const salesB = (summaryB && typeof summaryB.sales_amount === 'number') ? summaryB.sales_amount : 0;
      return salesB - salesA; // 降順 (多い順)
    });
});
// --- ▲▲▲ 追加 ▲▲▲ ---


async function handleLogin() {
  authError.value = null;
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email.value, password.value);
    password.value = '';
  } catch (error) {
    authError.value = `ログイン失敗。(${error.code || error.message})`;
  }
}

async function handleLogout() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Logout failed:", error);
  }
}

function fetchPreviousMonth() {
  let prevYear = displayYear.value; let prevMonth = displayMonth.value - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  fetchApiData(prevYear, prevMonth);
}

function fetchNextMonth() {
  let nextYear = displayYear.value; let nextMonth = displayMonth.value + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear++; }
  const currentYear = now.getFullYear(); const currentMonth = now.getMonth() + 1;
  if (nextYear > currentYear || (nextYear === currentYear && nextMonth > currentMonth)) { return; }
  fetchApiData(nextYear, nextMonth);
}

const isNextMonthDisabled = computed(() => {
  const currentYear = now.getFullYear(); const currentMonth = now.getMonth() + 1;
  return (displayYear.value >= currentYear && displayMonth.value >= currentMonth);
});

onMounted(() => {
  registerServiceWorker();
  onAuthStateChanged(auth, (user) => {
    currentUser.value = user;
    isLoading.value = false;
    if (user) {
      console.log('User logged in:', user.email);
      fetchApiData();
    } else {
      console.log('User logged out or not logged in.');
      reports.value = [];
      storesSummaryData.value = {}; // storesSummaryData もクリア
      summaryLastUpdatedData.value = null;
      fetchError.value = null;
      selectedStore.value = null;
      email.value = '';
      password.value = '';
      authError.value = null;
      subscriptionStatus.value = '';
    }
  });
});
</script>

<template>
  <div v-if="currentUser">
    <header class="user-info-bar">
      <span class="user-email">ログイン中: {{ currentUser.email }}</span>
      <div class="action-buttons">
        <button @click="fetchApiData()" :disabled="isLoading" class="action-button">{{ isLoading ? '読み込み中...' : '更新' }}</button>
        <button @click="subscribeToNotifications" class="action-button" :disabled="isLoading">通知購読</button>
        <button @click="handleLogout" class="action-button logout-button">ログアウト</button>
      </div>
    </header>
    <p v-if="subscriptionStatus" class="subscription-status">{{ subscriptionStatus }}</p>

    <main>
      <h1 class="main-title">カルソル日報</h1>
      <hr>

      <section class="monthly-summary-section">
        <div class="section-header">
          <h2>月次集計 (店舗別) - {{ displayYear }}年{{ displayMonth }}月</h2>
          <div class="month-nav-buttons">
            <button @click="fetchPreviousMonth" :disabled="isLoading" class="nav-button">＜ 前月</button>
            <button @click="fetchNextMonth" :disabled="isLoading || isNextMonthDisabled" class="nav-button">次月 ＞</button>
          </div>
        </div>

        <div v-if="isLoading && currentUser" class="loading-message">集計データを読み込み中...</div>
        <div v-else-if="fetchError" class="error-message">集計データの読み込みエラー: {{ fetchError }}</div>
        <div v-else-if="Object.keys(storesSummaryData).length > 0">
          <div class="overall-summary">
            <p><strong>全体の月間目標 (合計):</strong> {{ calculatedOverallTarget?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>全体の月間売上 (合計):</strong> {{ calculatedOverallSales?.toLocaleString() ?? 'N/A' }} 円</p>
            <p v-if="calculatedOverallTarget > 0">
              <strong>全体の達成率:</strong> {{ ((calculatedOverallSales / calculatedOverallTarget) * 100).toFixed(1) }} %
            </p>
            <p v-if="summaryLastUpdatedData"><small>最終集計日時: {{ formatDateTime(summaryLastUpdatedData) }}</small></p>
          </div>

          <div class="store-summary-slider">
             <div v-for="([storeName, summary]) in sortedStoresSummary"
                 :key="storeName"
                 class="store-summary-card"
                 @click="filterByStore(storeName)"
                 :class="{ 'selected-card': selectedStore === storeName }">
              <h3>{{ storeName }}</h3>
              <p><strong>売上:</strong> {{ summary.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
              <p><strong>日次目標計:</strong> {{ summary.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
              <p><strong>売上差額<small>(対 日次目標計)</small>:</strong>
                <span v-if="typeof summary.sales_amount === 'number' && typeof summary.daily_target_amount === 'number'">
                  <span :style="{ color: (summary.sales_amount - summary.daily_target_amount) >= 0 ? 'blue' : 'red', fontWeight: 'bold' }">
                    {{ (summary.sales_amount - summary.daily_target_amount) >= 0 ? '+' : '' }}{{ (summary.sales_amount - summary.daily_target_amount).toLocaleString() }} 円
                  </span>
                </span>
                <span v-else>計算不可</span>
              </p>
              <p><strong>客数:</strong> {{ summary.visitor_count ?? 'N/A' }} 人 (新規: {{ summary.new_customer_count ?? 'N/A' }}, 染め: {{ summary.dye_customer_count ?? 'N/A' }})</p>
              <p><strong>値引計:</strong> {{ summary.discount_amount?.toLocaleString() ?? 'N/A' }} 円</p>
              <p><strong>月間目標:</strong> {{ summary.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
              <p><strong>レポート数:</strong> {{ summary.reportCount ?? 'N/A' }} 件</p>
            </div>
             </div>
          <div class="chart-container">
            <h4 class="chart-title">店舗別 売上グラフ</h4>
            <StoreSalesChart :chart-data="storesSummaryData" />
          </div>
          </div>
        <p v-else class="no-data-message">表示できる月次集計データがありません。</p>
      </section>

      <hr>

      <section class="recent-reports-section">
        <div class="section-header">
           <h2>最近の日報一覧</h2>
           <button v-if="selectedStore" @click="filterByStore(null)" class="filter-reset-button">({{ selectedStore }} のフィルター解除)</button>
        </div>
        <div v-if="isLoading" class="loading-message">レポートリストを読み込んでいます...</div>
        <div v-else-if="filteredAndSortedReports.length > 0" class="report-list">
          <div v-for="report in filteredAndSortedReports" :key="report.id" class="report-card">
             <h3>{{ report.report_date }} - {{ report.store_name }}</h3>
             <p><strong>売上:</strong> {{ report.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
             <p><strong>日次目標:</strong> {{ report.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
             <p><strong>月間目標:</strong> {{ report.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
             <p><strong>来店:</strong> {{ report.visitor_count ?? 'N/A' }} 人 (新規: {{ report.new_customer_count ?? 'N/A' }}, 染め: {{ report.dye_customer_count ?? 'N/A' }})</p>
             <p><strong>値引:</strong> {{ report.discount_amount?.toLocaleString() ?? 'N/A' }} 円</p>
             <p v-if="report.comment"><strong>コメント:</strong><br><span class="comment-text">{{ report.comment }}</span></p>
             <small class="report-meta">登録日時: {{ formatDateTime(report.createdAt) }} (ID: {{ report.id }})</small>
          </div>
        </div>
        <p v-else-if="!isLoading && !fetchError" class="no-data-message">
          <span v-if="selectedStore" style="font-weight: bold;">{{ selectedStore }} の</span>表示できる最近の日報データがありません。
        </p>
        <p v-else-if="fetchError && !isLoading" class="error-message">レポートの読み込みに失敗しました。</p>
      </section>
    </main>
  </div>

  <div v-else-if="!isLoading" class="login-container">
    <h2 class="login-title">ログイン</h2>
    <form @submit.prevent="handleLogin" class="login-form">
      <div class="form-group">
        <label for="email">メールアドレス:</label>
        <input type="email" id="email" v-model="email" required>
      </div>
      <div class="form-group">
        <label for="password">パスワード:</label>
        <input type="password" id="password" v-model="password" required>
      </div>
      <button type="submit" class="login-button" :disabled="isLoading">ログイン</button>
      <p v-if="authError" class="error-message login-error">{{ authError }}</p>
    </form>
  </div>

  <div v-else class="loading-container">
     <p>認証状態を確認中...</p>
  </div>
</template>

<style scoped>
<style scoped>
  /* 基本スタイル (変更なし) */
  body { font-family: sans-serif; margin: 0; background-color: #282c34; color: #e0e0e0; }
  button { padding: 8px 16px; font-size: 0.95em; cursor: pointer; border-radius: 4px; border: 1px solid #666; background-color: #444; color: #eee; transition: background-color 0.2s ease, border-color 0.2s ease; margin: 0; }
  button:hover:not(:disabled) { background-color: #555; border-color: #777; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  hr { margin: 30px 0; border: 0; border-top: 1px solid #555; }
  h1, h2 { color: #E0E0E0; margin-top: 0; margin-bottom: 0.8em; }
  h4 { color: #D0D0D0; margin-bottom: 10px; text-align: center; }
  p { margin-top: 0; margin-bottom: 0.8em; line-height: 1.6; }
  small { font-size: 0.85em; color: #bbb; }

  /* レイアウト & コンポーネント (変更なし) */
  .user-info-bar { display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background-color: #3a3f4a; margin-bottom: 20px; border-radius: 4px; flex-wrap: wrap; gap: 10px; }
  .user-email { color: #eee; white-space: nowrap; flex-shrink: 0; font-size: 0.9em; }
  .action-buttons { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; flex-grow: 1; }
  .action-button { font-size: 0.9em; padding: 6px 12px; }
  .logout-button { background-color: #d9534f; border-color: #d43f3a; color: white; }
  .logout-button:hover:not(:disabled) { background-color: #c9302c; border-color: #ac2925; }
  .subscription-status { text-align: right; margin-top: -15px; margin-bottom: 15px; font-size: 0.85em; color: #aaa; }
  .main-title { text-align: center; margin-bottom: 15px; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
  .section-header h2 { margin-bottom: 0; }
  .month-nav-buttons button { margin-left: 8px; padding: 6px 12px; font-size: 0.9em; }
  .loading-message, .no-data-message, .error-message { padding: 15px; margin-top: 15px; border-radius: 4px; text-align: center; }
  .loading-message { color: #ccc; }
  .no-data-message { color: #aaa; background-color: rgba(85, 85, 85, 0.2); }
  .error-message { color: #ff8a8a; background-color: rgba(255, 107, 107, 0.1); border: 1px solid rgba(255, 107, 107, 0.3); }
  .overall-summary { margin-bottom: 20px; padding: 15px; background-color: #333842; border-radius: 4px; }
  .overall-summary p { margin-bottom: 6px; }
  .overall-summary p:last-child { margin-bottom: 0; }
  .overall-summary strong { color: #b8c5d6; }

  /* --- ▼▼▼ 横スライダースタイル変更 ▼▼▼ --- */
  .store-summary-slider {
    display: flex;
    overflow-x: auto;
    /* ↓↓↓ 左右にpaddingを追加して見切れを作る ↓↓↓ */
    padding: 5px 20px 20px 20px; /* 上:5px, 左右:20px, 下:20px */
    /* ↓↓↓ ネガティブマージンは削除し、通常のmarginに */
    margin: 15px 0; /* 上下:15px, 左右:0 */

    scroll-snap-type: x mandatory;
    gap: 16px; /* カード間の隙間 */
    -webkit-overflow-scrolling: touch; /* iOSでの慣性スクロール */

    /* ↓↓↓ スナップ位置を左右のpaddingに合わせて調整 (任意) ↓↓↓ */
    scroll-padding-left: 20px;
    scroll-padding-right: 20px;

    /* スクロールバーの見た目調整 (変更なし) */
    &::-webkit-scrollbar { height: 10px; }
    &::-webkit-scrollbar-track { background: rgba(68, 68, 68, 0.5); border-radius: 5px; }
    &::-webkit-scrollbar-thumb { background-color: #777; border-radius: 5px; border: 2px solid rgba(68, 68, 68, 0.5); }
    &::-webkit-scrollbar-thumb:hover { background-color: #999; }
    scrollbar-width: thin;
    scrollbar-color: #777 rgba(68, 68, 68, 0.5);
  }

  .store-summary-card {
    /* ↓↓↓ カード幅を少し狭くする (例: 280px -> 260px) ↓↓↓ */
    flex: 0 0 260px;

    scroll-snap-align: start; /* または center など、好みに合わせて */
    border: 1px solid #5a5a5a;
    border-radius: 8px;
    padding: 15px 20px; /* カード内のパディングは維持 */
    background-color: #3c414d;
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
    cursor: pointer;
  }
  /* --- ▲▲▲ 横スライダースタイル変更 ▲▲▲ --- */

  .store-summary-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.15em; color: #a6c0fe; border-bottom: 1px solid #555; padding-bottom: 8px; }
  .store-summary-card p { margin: 6px 0; font-size: 0.9em; color: #c0c0c0; }
  .store-summary-card p strong { margin-right: 5px; color: #dcdcdc; font-weight: 600; }
  .store-summary-card.selected-card { border-color: #41B883; box-shadow: 0 4px 10px rgba(65, 184, 131, 0.4); border-width: 2px; transform: translateY(-3px); }

  /* グラフコンテナのスタイル (変更なし) */
  .chart-container { margin-top: 30px; max-width: 800px; margin-left: auto; margin-right: auto; position: relative; height: auto; min-height: 350px; background-color: #333842; padding: 20px 20px 10px 20px; border-radius: 4px; display: flex; flex-direction: column; }
  .chart-title { color: #d0d0d0; margin-bottom: 15px; font-size: 1.1em; text-align: center; flex-shrink: 0; }
  .chart-container > :deep(div), .chart-container > *:last-child { flex-grow: 1; min-height: 300px; display: flex; align-items: stretch; }

  /* レポートリスト関連のスタイル (変更なし) */
  .filter-reset-button { margin-left: 10px; font-size: 0.8em; padding: 4px 8px; background-color: #555; border: none; }
  .filter-reset-button:hover { background-color: #666; }
  .report-list { display: flex; flex-direction: column; gap: 16px; margin-top: 15px; }
  .report-card { border: 1px solid #5a5a5a; border-radius: 8px; padding: 16px; background-color: #3c414d; box-shadow: 0 2px 5px rgba(0,0,0,0.15); word-wrap: break-word; }
  .report-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.1em; border-bottom: 1px solid #555; padding-bottom: 8px; color: #a6c0fe; }
  .report-card p { margin: 6px 0; font-size: 0.95em; line-height: 1.5; color: #c0c0c0; }
  .report-card p strong { color: #dcdcdc; margin-right: 5px; font-weight: 600; }
  .report-card .comment-text { display: block; margin-top: 6px; white-space: pre-wrap; color: #b0b0b0; max-height: 120px; overflow-y: auto; background-color: #333842; padding: 8px 10px; border-radius: 4px; font-size: 0.9em; }
  .report-card .comment-text::-webkit-scrollbar { width: 6px; }
  .report-card .comment-text::-webkit-scrollbar-thumb { background-color: #666; border-radius: 3px; }
  .report-card .comment-text::-webkit-scrollbar-track { background: #333842; border-radius: 3px; }
  .report-card .comment-text { scrollbar-width: thin; scrollbar-color: #666 #333842; }
  .report-card .report-meta { display: block; margin-top: 12px; font-size: 0.8em; color: #888; text-align: right; }

  /* ログイン画面 (変更なし) */
  .login-container { padding: 30px 20px; max-width: 450px; margin: 60px auto; background-color: #333842; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); }
  .login-title { text-align: center; color: #eee; margin-bottom: 25px; }
  .login-form { max-width: 400px; margin: 0 auto; }
  .form-group { margin-bottom: 20px; }
  .form-group label { display: block; margin-bottom: 8px; color: #ccc; font-weight: bold; font-size: 0.9em; }
  .form-group input { width: 100%; padding: 12px 15px; box-sizing: border-box; border: 1px solid #555; background-color: #444954; color: #eee; border-radius: 4px; font-size: 1em; transition: border-color 0.2s ease, background-color 0.2s ease; }
  .form-group input:focus { outline: none; border-color: #41B883; background-color: #4a505c; }
  .login-button { width: 100%; padding: 12px 20px; font-size: 1.1em; margin-top: 10px; background-color: #41B883; border: none; color: white; }
  .login-button:hover:not(:disabled) { background-color: #36a476; }
  .login-error { margin-top: 15px; text-align: center; font-weight: bold; }
  .loading-container { text-align: center; padding: 60px 20px; color: #ccc; font-size: 1.1em; }

  /* レスポンシブ (一部変更あり) */
  @media (max-width: 768px) {
    /* スマホでのグラフコンテナ最低高さ (変更なし) */
    .chart-container { min-height: 300px; }
    .chart-container > :deep(div), .chart-container > *:last-child { min-height: 250px; }
  }
  @media (max-width: 600px) {
    /* その他のスマホ向けスタイル (変更なし) */
    .user-info-bar { flex-direction: column; align-items: flex-end; }
    .user-email { width: 100%; text-align: left; margin-bottom: 8px; }
    .action-buttons { width: 100%; justify-content: flex-end; gap: 8px; }
    .section-header { flex-direction: column; align-items: flex-start; }
    .month-nav-buttons { margin-top: 10px; width: 100%; display: flex; justify-content: space-between; }
    .month-nav-buttons button { margin-left: 0; flex-grow: 1; margin: 0 4px; }

    /* --- ▼▼▼ スマホでのスライダーとカード幅調整 ▼▼▼ --- */
    .store-summary-slider {
      /* ↓↓↓ スマホでは左右paddingを少し減らす (任意) ↓↓↓ */
      padding-left: 15px;
      padding-right: 15px;
      scroll-padding-left: 15px;
      scroll-padding-right: 15px;
      gap: 12px; /* スマホではカード間隔も少し詰める */
    }
    .store-summary-card {
      /* ↓↓↓ スマホでのカード幅調整 (左右が見えるように) ↓↓↓ */
      flex-basis: calc(80vw - 30px); /* 例: 画面幅80% - 左右padding分 */
      /* または固定値 */
      /* flex-basis: 240px; */
      padding: 12px 15px; /* スマホではカード内パディングも少し減らす */
    }
    /* --- ▲▲▲ スマホでのスライダーとカード幅調整 ▲▲▲ --- */

    .report-card { border-radius: 4px; padding: 12px; }
    .report-card h3 { font-size: 1em; margin-bottom: 8px; padding-bottom: 6px; }
    .report-card p { font-size: 0.9em; }
    .report-card .comment-text { max-height: 100px; }
    .login-container { margin: 40px 15px; }
  }
</style>