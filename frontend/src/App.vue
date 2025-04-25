<script setup>
import { ref, onMounted, computed } from 'vue';
import StoreSalesChart from './components/StoreSalesChart.vue';
import { auth } from './firebaseConfig';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

// --- Notification Subscription Logic ---
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref('');
// const isSubscribed = ref(false); // 必要ならコメント解除

// --- ここから修正・追加 ---

// Service Worker を登録する関数
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Worker is not supported.');
    return null; // Service Worker がサポートされていない場合は何もしない
  }
  try {
    console.log('Registering service worker...');
    // ★ アプリ起動時に Service Worker を登録 ★
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); // scope を明示的に指定すると良い場合がある
    console.log('Service Worker registered:', registration);

    // Service Worker が有効になるのを待つ (ready プロパティを使用)
    await navigator.serviceWorker.ready;
    console.log('Service Worker ready.');
    return registration; // 登録オブジェクトを返す

  } catch (error) {
    console.error('Service Worker registration failed:', error);
    subscriptionStatus.value = 'Service Workerの登録に失敗しました。';
    return null;
  }
}

// プッシュ通知の購読を開始する関数 (ボタンクリック時に呼ばれる)
async function subscribeToNotifications() {
  subscriptionStatus.value = '処理中...';

  if (!('PushManager' in window)) {
    subscriptionStatus.value = 'エラー: プッシュ通知はこのブラウザではサポートされていません。';
    console.error('Push messaging is not supported');
    return;
  }

  // Service Worker が有効になるのを待つ
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
    //    以前は `/api/v1/subscribe` でしたが、Firebase等を使う場合は
    //    Firebase Cloud Functions などのエンドポイントになる可能性があります。
    const response = await fetch('/api/v1/subscribe', { // ←★ エンドポイント確認！
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ★ 認証が必要な場合はトークンもヘッダーに追加 ★
        // 'Authorization': `Bearer ${await currentUser.value?.getIdToken()}`
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
    // エラーメッセージの重複を避ける
    if (!subscriptionStatus.value.startsWith('エラー') && !subscriptionStatus.value.startsWith('購読中にエラー')) {
        subscriptionStatus.value = `エラーが発生しました: ${error.message}`;
    } else if (!subscriptionStatus.value.includes(error.message)) {
        // 既存のエラーメッセージに追加する場合 (長くなる可能性あり)
        // subscriptionStatus.value += ` ${error.message}`;
    }
    // 具体的な購読エラーの場合
    if (error.name === 'AbortError' || error.message.includes('subscribe')) {
        subscriptionStatus.value = `購読中にエラーが発生しました: ${error.message}`;
    }
  }
}

// Base64をUint8Arrayに変換する関数 (変更なし)
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4); const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); const rawData = window.atob(base64); const outputArray = new Uint8Array(rawData.length); for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); } return outputArray;
}

// --- ここまで修正・追加 ---


// --- Report Display Logic (変更なし) ---
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
  // ... (fetchApiData 関数の内容は変更なし) ...
  isLoading.value = true;
  fetchError.value = null;
  reports.value = [];
  storesSummaryData.value = {};
  summaryLastUpdatedData.value = null;
  selectedStore.value = null;

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
        storesSummaryData.value = data.storesSummary || {};
        summaryLastUpdatedData.value = data.summaryLastUpdated || null;
        displayYear.value = year;
        displayMonth.value = month;
    } else { throw new Error('API応答の形式が不正です。'); }
  } catch (error) {
    console.error('Error fetching data:', error);
    fetchError.value = `データ取得に失敗: ${error.message}`;
    reports.value = []; storesSummaryData.value = {}; summaryLastUpdatedData.value = null;
  } finally {
    isLoading.value = false;
  }
}

const sortedReports = computed(() => {
  // ... (変更なし) ...
  if (!reports.value || reports.value.length === 0) { return []; }
  return [...reports.value].sort((a, b) => {
    try {
      const dateA = new Date(a.report_date.replace(/\//g, '-'));
      const dateB = new Date(b.report_date.replace(/\//g, '-'));
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) { return 0; }
      return dateB - dateA;
    } catch (e) { return 0; }
  });
});

function filterByStore(storeName) {
  selectedStore.value = (selectedStore.value === storeName) ? null : storeName;
}

const filteredAndSortedReports = computed(() => {
  // ... (変更なし) ...
  if (!selectedStore.value) { return sortedReports.value; }
  return sortedReports.value.filter(report => report.store_name === selectedStore.value);
});

const calculatedOverallTarget = computed(() => {
  // ... (変更なし) ...
  if (storesSummaryData.value && typeof storesSummaryData.value === 'object' && Object.keys(storesSummaryData.value).length > 0) {
    return Object.values(storesSummaryData.value).reduce((total, storeSummary) => {
      const target = (storeSummary && typeof storeSummary.monthly_target_amount === 'number') ? storeSummary.monthly_target_amount : 0;
      return total + target;
    }, 0);
  }
  return 0;
});

const calculatedOverallSales = computed(() => {
  // ... (変更なし) ...
  if (storesSummaryData.value && typeof storesSummaryData.value === 'object' && Object.keys(storesSummaryData.value).length > 0) {
    return Object.values(storesSummaryData.value).reduce((total, storeSummary) => {
      const sales = (storeSummary && typeof storeSummary.sales_amount === 'number') ? storeSummary.sales_amount : 0;
      return total + sales;
    }, 0);
  }
  return 0;
});

async function handleLogin() {
  // ... (変更なし) ...
  authError.value = null;
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email.value, password.value);
    password.value = '';
  } catch (error) { authError.value = `ログイン失敗。(${error.code})`; }
}

async function handleLogout() {
  // ... (変更なし) ...
  try { await signOut(auth); } catch (error) { console.error("Logout failed:", error); }
}

function fetchPreviousMonth() {
  // ... (変更なし) ...
  let prevYear = displayYear.value; let prevMonth = displayMonth.value - 1;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  fetchApiData(prevYear, prevMonth);
}
function fetchNextMonth() {
  // ... (変更なし) ...
  let nextYear = displayYear.value; let nextMonth = displayMonth.value + 1;
  if (nextMonth > 12) { nextMonth = 1; nextYear++; }
  const currentYear = now.getFullYear(); const currentMonth = now.getMonth() + 1;
  if (nextYear > currentYear || (nextYear === currentYear && nextMonth > currentMonth)) { return; }
  fetchApiData(nextYear, nextMonth);
}
const isNextMonthDisabled = computed(() => {
  // ... (変更なし) ...
  const currentYear = now.getFullYear(); const currentMonth = now.getMonth() + 1;
  return (displayYear.value >= currentYear && displayMonth.value >= currentMonth);
});


// マウント時処理
onMounted(() => {
  // ★ Service Worker の登録を onMounted で呼び出す ★
  registerServiceWorker();

  // 認証状態の監視 (変更なし)
  onAuthStateChanged(auth, (user) => {
    currentUser.value = user;
    isLoading.value = false; // 認証状態が決まったらローディング解除
    if (user) {
      fetchApiData(); // ログインしていたらデータを取得
    }
    else {
      // ログアウト状態の処理
      reports.value = [];
      storesSummaryData.value = {};
      summaryLastUpdatedData.value = null;
      fetchError.value = null;
      selectedStore.value = null;
      email.value = ''; // ログインフォームの入力値をクリア (任意)
      // password.value = ''; // パスワードはセキュリティ上クリアしない方が良い場合も
      authError.value = null; // ログインエラー表示をクリア
      subscriptionStatus.value = ''; // 通知ステータスもクリア
    }
  });
});
// --- End Report Display Logic ---
</script>

<template>
  <div v-if="currentUser">
    <div class="user-info-bar">
      <span class="user-email">ログイン中: {{ currentUser.email }}</span>
      <div class="action-buttons">
        <button @click="fetchApiData()" :disabled="isLoading" class="action-button">{{ isLoading ? '読み込み中...' : '更新' }}</button>
        <button @click="subscribeToNotifications" class="action-button">通知購読</button>
        <button @click="handleLogout" class="action-button logout-button">ログアウト</button>
      </div>
    </div>
    <p v-if="subscriptionStatus" style="text-align: right; margin-top: 5px;">{{ subscriptionStatus }}</p>

    <div><h1>カルソル日報</h1></div>
    <hr>

    <div>
      <div class="section-header">
        <h2>月次集計 (店舗別) - {{ displayYear }}年{{ displayMonth }}月</h2>
        <div class="month-nav-buttons">
          <button @click="fetchPreviousMonth" :disabled="isLoading" class="nav-button">＜ 前月</button>
          <button @click="fetchNextMonth" :disabled="isLoading || isNextMonthDisabled" class="nav-button">次月 ＞</button>
        </div>
      </div>
      <div v-if="isLoading && !currentUser">認証状態を確認中...</div> <div v-else-if="isLoading && currentUser">集計データを読み込み中...</div>
      <div v-else-if="fetchError" style="color: red;">集計データの読み込みエラー: {{ fetchError }}</div>
      <div v-else-if="Object.keys(storesSummaryData).length > 0">
        <p><strong>全体の月間目標 (合計):</strong> {{ calculatedOverallTarget?.toLocaleString() ?? 'N/A' }} 円</p>
        <p><strong>全体の月間売上 (合計):</strong> {{ calculatedOverallSales?.toLocaleString() ?? 'N/A' }} 円</p>
        <p v-if="calculatedOverallTarget > 0">
          <strong>全体の達成率:</strong> {{ ((calculatedOverallSales / calculatedOverallTarget) * 100).toFixed(1) }} %
        </p>
        <p v-if="summaryLastUpdatedData"><small>最終集計日時: {{ formatDateTime(summaryLastUpdatedData) }}</small></p>
        <div class="store-summary-cards">
          <div v-for="(summary, storeName) in storesSummaryData"
               :key="storeName"
               class="store-summary-card"
               @click="filterByStore(storeName)"
               :class="{ 'selected-card': selectedStore === storeName }">
            <h3>{{ storeName }}</h3>
            <p><strong>売上:</strong> {{ summary.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>日次目標計:</strong> {{ summary.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>売上差額<small>(対 日次目標計)</small>:</strong> <span v-if="typeof summary.sales_amount === 'number' && typeof summary.daily_target_amount === 'number'"><span :style="{ color: (summary.sales_amount - summary.daily_target_amount) >= 0 ? 'blue' : 'red', fontWeight: 'bold' }">{{ (summary.sales_amount - summary.daily_target_amount) >= 0 ? '+' : '' }}{{ (summary.sales_amount - summary.daily_target_amount).toLocaleString() }} 円</span></span><span v-else>計算不可</span> </p>
            <p><strong>客数:</strong> {{ summary.visitor_count ?? 'N/A' }} 人 (新規: {{ summary.new_customer_count ?? 'N/A' }}, 染め: {{ summary.dye_customer_count ?? 'N/A' }})</p>
            <p><strong>値引計:</strong> {{ summary.discount_amount?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>月間目標:</strong> {{ summary.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
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
        <button v-if="selectedStore" @click="filterByStore(null)" style="margin-left: 10px; font-size: 0.8em; padding: 4px 8px;">({{ selectedStore }} のフィルター解除)</button>
      </h2>
      <div v-if="isLoading">レポートリストを読み込んでいます...</div>
      <div v-else-if="filteredAndSortedReports.length > 0" class="report-list-cards">
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
      <p v-else-if="!isLoading && !fetchError"><span v-if="selectedStore" style="font-weight: bold;">{{ selectedStore }} の</span>表示できる最近の日報データがありません。</p>
    </div>
  </div>

  <div v-else-if="!isLoading" class="login-container">
    <h2>ログイン</h2>
    <form @submit.prevent="handleLogin" class="login-form">
      <div class="form-group">
        <label for="email">メールアドレス:</label>
        <input type="email" id="email" v-model="email" required>
      </div>
      <div class="form-group">
        <label for="password">パスワード:</label>
        <input type="password" id="password" v-model="password" required>
      </div>
      <button type="submit">ログイン</button>
      <p v-if="authError" class="error-message">{{ authError }}</p>
    </form>
  </div>

  <div v-else class="loading-container">
     <p>認証状態を確認中...</p>
  </div>
</template>

<style scoped>
  /* スタイル部分は変更なし */
  /* ... (style の内容は変更なし) ... */
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 10px; }
  .month-nav-buttons button { margin-left: 5px; padding: 6px 12px; font-size: 0.9em; }
  .month-nav-buttons button:disabled { opacity: 0.5; cursor: not-allowed; }
  .user-info-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px 15px; background-color: #444; margin-bottom: 20px; border-radius: 4px; flex-wrap: wrap; gap: 10px; }
  .user-email { color: #eee; margin-right: 15px; white-space: nowrap; flex-shrink: 0; }
  .action-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; flex-grow: 1; }
  .action-button { font-size: 0.9em; padding: 6px 12px; margin-bottom: 0; white-space: nowrap; }
  .logout-button { background-color: #d9534f; border-color: #d43f3a; color: white; }
  .logout-button:hover { background-color: #c9302c; border-color: #ac2925; }
  .login-container { padding: 20px; max-width: 500px; margin: 40px auto; }
  .login-form { max-width: 400px; margin: 20px auto; padding: 20px; border: 1px solid #555; border-radius: 8px; background-color: #333; }
  .form-group { margin-bottom: 15px; }
  .form-group label { display: block; margin-bottom: 5px; color: #eee; font-weight: bold; }
  .form-group input { width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #555; background-color: #444; color: #eee; border-radius: 4px; font-size: 1em;}
  .error-message { color: #ff6b6b; margin-top: 10px; font-weight: bold; }
  .loading-container { text-align: center; padding: 50px; color: #ccc; }
  .store-summary-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; margin-top: 15px; margin-bottom: 15px; }
  .store-summary-card { border: 1px solid #d0d0d0; border-radius: 8px; padding: 12px 16px; background-color: #f9f9f9; box-shadow: 0 1px 3px rgba(0,0,0,0.06); transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out; cursor: pointer; }
  .store-summary-card.selected-card { border-color: #41B883; box-shadow: 0 3px 8px rgba(65, 184, 131, 0.5); border-width: 2px; }
  .store-summary-card h3 { margin-top: 0; margin-bottom: 10px; font-size: 1.1em; color: #1a4a7a; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  .store-summary-card p { margin: 4px 0; font-size: 0.9em; color: #222222; }
  .store-summary-card p strong { margin-right: 4px; }
  button { padding: 10px 20px; font-size: 16px; cursor: pointer; margin-right: 10px; margin-bottom: 10px;}
  .login-form button { width: 100%; }
  .user-info-bar button { margin-bottom: 0; }
  .month-nav-buttons button { margin-bottom: 0; }
  p { margin-top: 15px; }
  hr { margin: 30px 0; border: 0; border-top: 1px solid #eee; }
  h1, h2 { color: #E0E0E0; }
  h4 { color: #D0D0D0; margin-bottom: 10px; }
  .report-list-cards { display: flex; flex-direction: column; gap: 16px; margin-top: 15px; }
  .report-card { border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; background-color: #ffffff; box-shadow: 0 2px 5px rgba(0,0,0,0.08); word-wrap: break-word; }
  .report-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.1em; border-bottom: 1px solid #eee; padding-bottom: 8px; color: #2c3e50; }
  .report-card p { margin: 6px 0; font-size: 0.95em; line-height: 1.5; color: #333; }
  .report-card p strong { color: #555; margin-right: 5px; font-weight: 600; }
  .report-card .comment-text { display: block; margin-top: 4px; white-space: pre-wrap; color: #555; max-height: 100px; overflow-y: auto; background-color: #f9f9f9; padding: 5px; border-radius: 4px; font-size: 0.9em; }
  .report-card .report-meta { display: block; margin-top: 12px; font-size: 0.8em; color: #888; }
  @media (max-width: 600px) { .report-card { border-radius: 4px; padding: 12px; } .report-card h3 { font-size: 1em; margin-bottom: 8px; padding-bottom: 6px; } .report-card p { font-size: 0.9em; } .report-card .comment-text { max-height: 80px; } .store-summary-cards { grid-template-columns: 1fr; } .user-info-bar { flex-direction: column; align-items: flex-end; } .action-buttons { width: 100%; justify-content: flex-end; margin-top: 5px;} .section-header { flex-direction: column; align-items: flex-start;} .month-nav-buttons { margin-top: 10px;} }
</style>