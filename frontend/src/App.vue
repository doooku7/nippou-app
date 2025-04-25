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
  // データをクリアする前に保持するかどうか検討
  // reports.value = [];
  // storesSummaryData.value = {};
  // summaryLastUpdatedData.value = null;
  // selectedStore.value = null;

  console.log(`Workspaceing data for ${year}-${month}...`); // Workspaceing -> Fetching
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
        storesSummaryData.value = data.storesSummary || {};
        summaryLastUpdatedData.value = data.summaryLastUpdated || null;
        displayYear.value = year;
        displayMonth.value = month;
        // データ取得成功時は選択を解除する（必要に応じて）
        selectedStore.value = null;
    } else { throw new Error('API応答の形式が不正です。'); }
  } catch (error) {
    console.error('Error fetching data:', error);
    fetchError.value = `データ取得に失敗: ${error.message}`;
    // エラー時もデータをクリア
    reports.value = []; storesSummaryData.value = {}; summaryLastUpdatedData.value = null; selectedStore.value = null;
  } finally {
    isLoading.value = false;
  }
}

const sortedReports = computed(() => {
  if (!reports.value || reports.value.length === 0) { return []; }
  return [...reports.value].sort((a, b) => {
    try {
      // 日付文字列のフォーマットをより堅牢に扱う
      const dateA = new Date(String(a.report_date).replace(/\//g, '-'));
      const dateB = new Date(String(b.report_date).replace(/\//g, '-'));
      // 無効な日付の場合は比較しない
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) { return 0; }
      return dateB - dateA; // 新しい順
    } catch (e) {
      console.error("Error parsing date for sorting:", e);
      return 0; // エラー時は順序変更しない
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

async function handleLogin() {
  authError.value = null;
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email.value, password.value);
    // ログイン成功後にパスワードフィールドをクリアするのは良い習慣
    password.value = '';
    // ログイン成功時の処理（例: データ取得）は onAuthStateChanged で行う
  } catch (error) {
    authError.value = `ログイン失敗。(${error.code || error.message})`; // エラーコードまたはメッセージ表示
  }
}

async function handleLogout() {
  try {
    await signOut(auth);
    // ログアウト後の処理（データクリアなど）は onAuthStateChanged で行う
  } catch (error) {
    console.error("Logout failed:", error);
    // ログアウト失敗時のエラー表示など（必要であれば）
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
  // 未来の月は取得しない
  if (nextYear > currentYear || (nextYear === currentYear && nextMonth > currentMonth)) { return; }
  fetchApiData(nextYear, nextMonth);
}

const isNextMonthDisabled = computed(() => {
  const currentYear = now.getFullYear(); const currentMonth = now.getMonth() + 1;
  return (displayYear.value >= currentYear && displayMonth.value >= currentMonth);
});

// マウント時処理
onMounted(() => {
  // ★ Service Worker の登録を onMounted で呼び出す ★
  registerServiceWorker();

  // 認証状態の監視
  onAuthStateChanged(auth, (user) => {
    currentUser.value = user;
    isLoading.value = false; // 認証状態が決まったらローディング解除
    if (user) {
      console.log('User logged in:', user.email);
      fetchApiData(); // ログインしていたらデータを取得
    }
    else {
      console.log('User logged out or not logged in.');
      // ログアウト状態のデータクリア
      reports.value = [];
      storesSummaryData.value = {};
      summaryLastUpdatedData.value = null;
      fetchError.value = null;
      selectedStore.value = null;
      email.value = ''; // フォームクリア
      password.value = ''; // フォームクリア
      authError.value = null; // エラークリア
      subscriptionStatus.value = ''; // 通知ステータスクリア
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
            <div v-for="(summary, storeName) in storesSummaryData"
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
  /* 基本スタイル */
  body {
    font-family: sans-serif; /* フォント指定 */
    margin: 0;
    background-color: #282c34; /* 背景色 */
    color: #e0e0e0; /* 基本文字色 */
  }
  button {
    padding: 8px 16px; /* ボタンのパディング調整 */
    font-size: 0.95em; /* ボタンのフォントサイズ調整 */
    cursor: pointer;
    border-radius: 4px;
    border: 1px solid #666;
    background-color: #444;
    color: #eee;
    transition: background-color 0.2s ease, border-color 0.2s ease;
    margin: 0; /* buttonのデフォルトマージンリセット */
  }
  button:hover:not(:disabled) {
    background-color: #555;
    border-color: #777;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  hr {
    margin: 30px 0;
    border: 0;
    border-top: 1px solid #555; /* hrの色調整 */
  }
  h1, h2 {
    color: #E0E0E0;
    margin-top: 0; /* 見出し上のマージン調整 */
    margin-bottom: 0.8em; /* 見出し下のマージン調整 */
  }
  h4 {
    color: #D0D0D0;
    margin-bottom: 10px;
    text-align: center;
  }
  p {
    margin-top: 0; /* pのデフォルトマージン調整 */
    margin-bottom: 0.8em; /* p下のマージン調整 */
    line-height: 1.6; /* 行間調整 */
  }
  small {
    font-size: 0.85em;
    color: #bbb;
  }

  /* レイアウト & コンポーネント */
  .user-info-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 15px; /* パディング調整 */
    background-color: #3a3f4a; /* 背景色変更 */
    margin-bottom: 20px;
    border-radius: 4px;
    flex-wrap: wrap;
    gap: 10px;
  }
  .user-email {
    color: #eee;
    white-space: nowrap;
    flex-shrink: 0;
    font-size: 0.9em; /* フォントサイズ調整 */
  }
  .action-buttons {
    display: flex;
    align-items: center;
    gap: 10px; /* ボタン間のスペース調整 */
    flex-wrap: wrap;
    justify-content: flex-end;
    flex-grow: 1;
  }
  .action-button {
    font-size: 0.9em;
    padding: 6px 12px;
  }
  .logout-button {
    background-color: #d9534f;
    border-color: #d43f3a;
    color: white;
  }
  .logout-button:hover:not(:disabled) {
    background-color: #c9302c;
    border-color: #ac2925;
  }
  .subscription-status {
    text-align: right;
    margin-top: -15px; /* 上のバーとの間隔調整 */
    margin-bottom: 15px;
    font-size: 0.85em;
    color: #aaa;
  }
  .main-title {
    text-align: center;
    margin-bottom: 15px;
  }
  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px; /* ヘッダー下のマージン */
    flex-wrap: wrap;
    gap: 10px;
  }
  .section-header h2 {
    margin-bottom: 0; /* h2のマージンリセット */
  }
  .month-nav-buttons button {
    margin-left: 8px; /* 月移動ボタンの左マージン */
    padding: 6px 12px;
    font-size: 0.9em;
  }
  .loading-message, .no-data-message, .error-message {
    padding: 15px;
    margin-top: 15px;
    border-radius: 4px;
    text-align: center;
  }
  .loading-message {
    color: #ccc;
  }
  .no-data-message {
    color: #aaa;
    background-color: rgba(85, 85, 85, 0.2); /* 背景少しつける */
  }
  .error-message {
    color: #ff8a8a; /* エラー色調整 */
    background-color: rgba(255, 107, 107, 0.1); /* エラー背景 */
    border: 1px solid rgba(255, 107, 107, 0.3);
  }
  .overall-summary {
    margin-bottom: 20px;
    padding: 15px;
    background-color: #333842; /* 背景色 */
    border-radius: 4px;
  }
  .overall-summary p {
    margin-bottom: 6px; /* 段落間のマージン少し詰める */
  }
  .overall-summary p:last-child {
    margin-bottom: 0;
  }
  .overall-summary strong {
      color: #b8c5d6; /* 強調文字の色 */
  }

  /* --- ▼▼▼ 横スライダースタイル ▼▼▼ --- */
  .store-summary-slider {
    display: flex;
    overflow-x: auto;
    padding: 5px 5px 20px 5px; /* 左右と下にパディング追加 */
    margin: 15px -5px -5px -5px; /* ネガティブマージンで左右のpadding相殺 */
    scroll-snap-type: x mandatory;
    gap: 16px; /* flex gap を使う (margin-right の代わり) */
    -webkit-overflow-scrolling: touch; /* iOSでの慣性スクロール */

    /* スクロールバーの見た目調整 */
    &::-webkit-scrollbar {
      height: 10px;
    }
    &::-webkit-scrollbar-track {
      background: rgba(68, 68, 68, 0.5); /* 少し透明に */
      border-radius: 5px;
    }
    &::-webkit-scrollbar-thumb {
      background-color: #777;
      border-radius: 5px;
      border: 2px solid rgba(68, 68, 68, 0.5);
    }
    &::-webkit-scrollbar-thumb:hover {
      background-color: #999;
    }
     /* Firefox用スクロールバー */
    scrollbar-width: thin;
    scrollbar-color: #777 rgba(68, 68, 68, 0.5);
  }

  .store-summary-card {
    flex: 0 0 280px; /* 幅固定 */
    scroll-snap-align: start; /* スナップ位置 */
    border: 1px solid #5a5a5a; /* ボーダー色調整 */
    border-radius: 8px;
    padding: 15px 20px; /* パディング調整 */
    background-color: #3c414d; /* カード背景色 */
    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
    cursor: pointer;
  }
  .store-summary-card h3 {
    margin-top: 0;
    margin-bottom: 12px;
    font-size: 1.15em; /* 少し大きく */
    color: #a6c0fe; /* 店舗名の文字色 */
    border-bottom: 1px solid #555;
    padding-bottom: 8px;
  }
  .store-summary-card p {
    margin: 6px 0; /* pの間隔調整 */
    font-size: 0.9em;
    color: #c0c0c0; /* カード内テキスト色 */
  }
  .store-summary-card p strong {
    margin-right: 5px;
    color: #dcdcdc; /* 強調テキスト色 */
    font-weight: 600;
  }
  .store-summary-card.selected-card {
    border-color: #41B883;
    box-shadow: 0 4px 10px rgba(65, 184, 131, 0.4);
    border-width: 2px;
    transform: translateY(-3px);
  }
  /* --- ▲▲▲ 横スライダースタイル ▲▲▲ --- */

  .chart-container {
    margin-top: 30px;
    max-width: 800px; /* グラフの最大幅調整 */
    margin-left: auto;
    margin-right: auto;
    position: relative;
    height: 380px; /* グラフの高さ調整 */
    background-color: #333842; /* グラフ背景 */
    padding: 20px;
    border-radius: 4px;
  }
  .chart-title {
      color: #d0d0d0;
      margin-bottom: 15px;
      font-size: 1.1em;
  }
  .filter-reset-button {
    margin-left: 10px;
    font-size: 0.8em;
    padding: 4px 8px;
    background-color: #555;
    border: none;
  }
  .filter-reset-button:hover {
    background-color: #666;
  }
  .report-list {
    display: flex;
    flex-direction: column;
    gap: 16px; /* カード間のスペース */
    margin-top: 15px;
  }
  .report-card {
    border: 1px solid #5a5a5a;
    border-radius: 8px;
    padding: 16px;
    background-color: #3c414d; /* レポートカード背景色 */
    box-shadow: 0 2px 5px rgba(0,0,0,0.15);
    word-wrap: break-word;
  }
  .report-card h3 {
    margin-top: 0;
    margin-bottom: 12px;
    font-size: 1.1em;
    border-bottom: 1px solid #555;
    padding-bottom: 8px;
    color: #a6c0fe; /* レポートカードタイトル色 */
  }
  .report-card p {
    margin: 6px 0;
    font-size: 0.95em;
    line-height: 1.5;
    color: #c0c0c0;
  }
  .report-card p strong {
    color: #dcdcdc;
    margin-right: 5px;
    font-weight: 600;
  }
  .report-card .comment-text {
    display: block;
    margin-top: 6px; /* コメント上マージン */
    white-space: pre-wrap; /* 改行を反映 */
    color: #b0b0b0; /* コメント文字色 */
    max-height: 120px; /* コメント最大高さ */
    overflow-y: auto;
    background-color: #333842; /* コメント背景 */
    padding: 8px 10px; /* コメント内パディング */
    border-radius: 4px;
    font-size: 0.9em;
    /* コメントスクロールバー */
    &::-webkit-scrollbar { width: 6px; }
    &::-webkit-scrollbar-thumb { background-color: #666; border-radius: 3px; }
    &::-webkit-scrollbar-track { background: #333842; border-radius: 3px; }
    scrollbar-width: thin;
    scrollbar-color: #666 #333842;
  }
  .report-card .report-meta {
    display: block;
    margin-top: 12px;
    font-size: 0.8em;
    color: #888;
    text-align: right;
  }

  /* ログイン画面 */
  .login-container {
    padding: 30px 20px; /* パディング調整 */
    max-width: 450px; /* 最大幅調整 */
    margin: 60px auto; /* 上下マージン調整 */
    background-color: #333842; /* 背景色 */
    border-radius: 8px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.2);
  }
  .login-title {
    text-align: center;
    color: #eee;
    margin-bottom: 25px; /* タイトル下マージン */
  }
  .login-form {
    max-width: 400px;
    margin: 0 auto; /* 中央寄せ */
  }
  .form-group {
    margin-bottom: 20px; /* グループ間マージン */
  }
  .form-group label {
    display: block;
    margin-bottom: 8px; /* ラベル下マージン */
    color: #ccc; /* ラベル色 */
    font-weight: bold;
    font-size: 0.9em;
  }
  .form-group input {
    width: 100%;
    padding: 12px 15px; /* inputパディング */
    box-sizing: border-box;
    border: 1px solid #555;
    background-color: #444954; /* input背景色 */
    color: #eee;
    border-radius: 4px;
    font-size: 1em;
    transition: border-color 0.2s ease, background-color 0.2s ease;
  }
  .form-group input:focus {
      outline: none;
      border-color: #41B883; /* フォーカス時のボーダー色 */
      background-color: #4a505c;
  }
  .login-button {
    width: 100%;
    padding: 12px 20px; /* ボタンパディング調整 */
    font-size: 1.1em; /* フォントサイズ調整 */
    margin-top: 10px; /* ボタン上マージン */
    background-color: #41B883; /* ログインボタン色 */
    border: none;
    color: white;
  }
  .login-button:hover:not(:disabled) {
      background-color: #36a476;
  }
  .login-error {
    margin-top: 15px; /* エラーメッセージ上マージン */
    text-align: center;
    font-weight: bold;
  }
  .loading-container {
    text-align: center;
    padding: 60px 20px;
    color: #ccc;
    font-size: 1.1em;
  }

  /* レスポンシブ */
  @media (max-width: 768px) {
    .chart-container {
        height: 320px; /* スマホでのグラフ高さ */
    }
  }
  @media (max-width: 600px) {
    .user-info-bar {
      flex-direction: column;
      align-items: flex-end; /* 右寄せに */
    }
    .user-email {
        width: 100%; /* Emailを幅いっぱいに */
        text-align: left; /* 左寄せに */
        margin-bottom: 8px; /* 下に少しマージン */
    }
    .action-buttons {
      width: 100%;
      justify-content: flex-end; /* ボタンを右寄せ */
      gap: 8px; /* ボタン間隔少し詰める */
    }
    .section-header {
      flex-direction: column;
      align-items: flex-start; /* 左寄せに */
    }
    .month-nav-buttons {
      margin-top: 10px; /* 月移動ボタン上にマージン */
      width: 100%;
      display: flex;
      justify-content: space-between; /* 前月・次月ボタンを左右に配置 */
    }
    .month-nav-buttons button {
        margin-left: 0; /* 左マージンリセット */
        flex-grow: 1; /* ボタン幅を均等に */
        margin: 0 4px; /* ボタン左右に少しマージン */
    }
    .store-summary-card {
      flex-basis: calc(85vw - 32px); /* スナップしやすいように画面幅基準で */
      /* flex-basis: 260px; */ /* または固定幅を少し小さく */
    }
    .report-card {
      border-radius: 4px;
      padding: 12px;
    }
    .report-card h3 {
      font-size: 1em;
      margin-bottom: 8px;
      padding-bottom: 6px;
    }
    .report-card p {
      font-size: 0.9em;
    }
    .report-card .comment-text {
      max-height: 100px; /* コメント高さ少し小さく */
    }
    .login-container {
        margin: 40px 15px; /* 左右マージン少し減らす */
    }
  }
</style>