<script setup>
// onUnmounted と PullToRefresh をインポート
import { ref, onMounted, onUnmounted, computed } from 'vue'; // onUnmounted を追加
import PullToRefresh from 'pulltorefreshjs'; // PullToRefresh をインポート

import StoreSalesChart from './components/StoreSalesChart.vue'; // グラフコンポーネントのパスを確認
import { auth } from './firebaseConfig'; // Firebase設定ファイルのパスを確認
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

// --- Notification Subscription Logic (変更なし) ---
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const subscriptionStatus = ref('');

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
    // ★ getIdToken を追加して認証情報を付与
    const idToken = currentUser.value ? await currentUser.value.getIdToken() : null;
    if (!idToken) {
      throw new Error('認証トークンが取得できませんでした。再度ログインしてください。');
    }
    const response = await fetch('/api/v1/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}` // ★ トークンを追加
      },
      body: JSON.stringify({ subscription: subscription }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: '不明なサーバーエラー' }));
      // 401/403 エラーの場合はログアウトを促すメッセージを追加
      if (response.status === 401 || response.status === 403) {
          throw new Error(`サーバーエラー: ${response.status} ${response.statusText} - ${errorData.error} (アクセス権限がない可能性があります。再度ログインしてください)`);
      } else {
          throw new Error(`サーバーエラー: ${response.status} ${response.statusText} - ${errorData.error}`);
      }
    }
    const result = await response.json();
    console.log('Server response:', result);
    subscriptionStatus.value = `購読に成功しました！ (${result.message || '完了'})`;

  } catch (error) {
    console.error('Error during subscription process:', error);
    // 既存のエラーメッセージ表示ロジックは維持
    if (!subscriptionStatus.value.startsWith('エラー') && !subscriptionStatus.value.startsWith('購読中にエラー')) {
        subscriptionStatus.value = `エラーが発生しました: ${error.message}`;
    } else if (!subscriptionStatus.value.includes(error.message)) {
        subscriptionStatus.value += ` ${error.message}`; // メッセージを追加する場合
    }
    // subscribe 中のエラーに特化したメッセージ
    if (error.name === 'AbortError' || (error.message && error.message.toLowerCase().includes('subscribe'))) {
        subscriptionStatus.value = `購読中にエラーが発生しました: ${error.message}`;
    }
    // 認証エラーの場合のメッセージ
    if (error.message.includes('認証トークン')) {
        subscriptionStatus.value = `エラー: ${error.message}`;
    }
  }
}


function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4); const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); const rawData = window.atob(base64); const outputArray = new Uint8Array(rawData.length); for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); } return outputArray;
}

// --- Report Display Logic (変更なし) ---
const reports = ref([]);
const storesSummaryData = ref({});
const summaryLastUpdatedData = ref(null);
const isLoading = ref(true); // ★ PullToRefresh で使用
const fetchError = ref(null);
const selectedStore = ref(null);
const email = ref('');
const password = ref('');
const authError = ref(null);
const currentUser = ref(null);
const now = new Date(); // 現在時刻はここで取得される (JST)
const displayYear = ref(now.getFullYear());
const displayMonth = ref(now.getMonth() + 1);

function formatDateTime(isoString) {
  if (!isoString) return 'N/A'; try { const date = new Date(isoString); return date.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { console.error("Error formatting date:", e); return isoString; }
}

async function fetchApiData(year = displayYear.value, month = displayMonth.value) {
  isLoading.value = true;
  fetchError.value = null;

  console.log(`Workspaceing data for ${year}-${month}...`); // Typo修正済
  try {
    if (!currentUser.value) { throw new Error('ユーザーがログインしていません。'); }
    const idToken = await currentUser.value.getIdToken(); // ★ トークン取得
    const headers = { 'Authorization': `Bearer ${idToken}` };
    const apiUrl = `/api/v1/reports?year=${year}&month=${month}`;
    const response = await fetch(apiUrl, { headers: headers });

    if (!response.ok) {
      let errorMsg = `HTTP error! status: ${response.status}`;
      try { const errorData = await response.json(); errorMsg = errorData.error || errorMsg; } catch(e) { /* ignore */ }
      if (response.status === 401 || response.status === 403) {
          errorMsg = `アクセス権エラー (${response.status}): ${errorMsg} 再度ログインしてください。`;
          handleLogout();
      }
      throw new Error(errorMsg);
    }
    const data = await response.json();

    if (data) {
        reports.value = data.recentReports || [];
        storesSummaryData.value = data.storesSummary || {};
        summaryLastUpdatedData.value = data.summaryLastUpdated || null;
        displayYear.value = year;
        displayMonth.value = month;
        selectedStore.value = null;
    } else { throw new Error('API応答の形式が不正です。'); }
  } catch (error) {
    console.error('Error fetching data:', error);
    if (error.code && error.code.startsWith('auth/')) {
         fetchError.value = `認証エラー: ${error.message}`;
    } else {
         fetchError.value = `データ取得に失敗: ${error.message}`;
    }
    reports.value = []; storesSummaryData.value = {}; summaryLastUpdatedData.value = null; selectedStore.value = null;
  } finally {
    isLoading.value = false;
  }
}

const sortedReports = computed(() => {
  if (!reports.value || reports.value.length === 0) { return []; }
  return [...reports.value].sort((a, b) => {
    try {
      const dateAStr = String(a.report_date).replace(/\//g, '-');
      const dateBStr = String(b.report_date).replace(/\//g, '-');
      const dateA = new Date(dateAStr);
      const dateB = new Date(dateBStr);
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
          console.warn(`Invalid date format for sorting: A='${a.report_date}', B='${b.report_date}'`);
          return 0;
      }
      return dateB - dateA;
    } catch (e) {
      console.error("Error parsing date for sorting:", e, a.report_date, b.report_date);
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
  if (!storesSummaryData.value || typeof storesSummaryData.value !== 'object') return 0;
  return Object.values(storesSummaryData.value).reduce((total, storeSummary) => {
    const target = storeSummary?.monthly_target_amount ?? 0;
    return total + (typeof target === 'number' ? target : 0);
  }, 0);
});

const calculatedOverallSales = computed(() => {
  if (!storesSummaryData.value || typeof storesSummaryData.value !== 'object') return 0;
  return Object.values(storesSummaryData.value).reduce((total, storeSummary) => {
    const sales = storeSummary?.sales_amount ?? 0;
    return total + (typeof sales === 'number' ? sales : 0);
  }, 0);
});

const calculatedOverallAchievementRate = computed(() => {
    const target = calculatedOverallTarget.value;
    const sales = calculatedOverallSales.value;
    if (target > 0 && typeof sales === 'number') {
        return ((sales / target) * 100).toFixed(1);
    }
    return 'N/A';
});

const sortedStoresSummary = computed(() => {
  if (!storesSummaryData.value || typeof storesSummaryData.value !== 'object') {
    return [];
  }
  return Object.entries(storesSummaryData.value)
    .sort(([, summaryA], [, summaryB]) => {
      const salesA = summaryA?.sales_amount ?? -Infinity;
      const salesB = summaryB?.sales_amount ?? -Infinity;
      const numSalesA = typeof salesA === 'number' ? salesA : -Infinity;
      const numSalesB = typeof salesB === 'number' ? salesB : -Infinity;
      return numSalesB - numSalesA;
    });
});

async function handleLogin() {
  authError.value = null;
  try {
    await signInWithEmailAndPassword(auth, email.value, password.value);
    password.value = '';
  } catch (error) {
    console.error("Login failed:", error);
    switch (error.code) {
        case 'auth/invalid-email': authError.value = 'メールアドレスの形式が正しくありません。'; break;
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential': authError.value = 'メールアドレスまたはパスワードが間違っています。'; break;
        case 'auth/too-many-requests': authError.value = '試行回数が多すぎます。しばらくしてから再度お試しください。'; break;
        default: authError.value = `ログイン失敗。(${error.message})`;
    }
  }
}

async function handleLogout() {
  destroyPullToRefresh();
  try {
    await signOut(auth);
    console.log("User logged out successfully.");
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


// --- ▼▼▼ PullToRefresh 関連 (修正箇所) ▼▼▼ ---
let ptrInstance = null;

function initializePullToRefresh() {
  if (ptrInstance) return;
  if (typeof PullToRefresh === 'undefined' || !PullToRefresh.init) {
    console.error('PullToRefresh library is not loaded correctly.');
    return;
  }
  try {
    console.log('Initializing PullToRefresh for body trigger (top only)...'); // ログ変更

    ptrInstance = PullToRefresh.init({
      mainElement: 'body', // ページ全体を対象
      triggerElement: 'body', // ページ全体を対象

      // ★ 更新を許可する条件 (スクロール位置を追加) ★
      shouldPullToRefresh: () => {
        const isAtTop = window.scrollY < 5; // 5px未満なら最上部とみなす (調整可能)
        // console.log(`shouldPullToRefresh: isLoading=${isLoading.value}, currentUser=${!!currentUser.value}, isAtTop=${isAtTop}`); // デバッグ用
        return !isLoading.value && !!currentUser.value && isAtTop;
      },

      onRefresh: async () => {
        console.log('PullToRefresh: Refresh triggered!');
        await fetchApiData(displayYear.value, displayMonth.value);
        console.log('PullToRefresh: fetchApiData finished.');
      },

      // 表示テキスト
      instructionsPullToRefresh: '下にスワイプして更新', // テキストを戻す
      instructionsReleaseToRefresh: '指を離して更新',
      instructionsRefreshing: '更新中...',

      // ★ トリガー距離（感度）の設定例 ★
      distThreshold: 90, // 更新が始まるまでの距離 (デフォルト60より少し鈍く)
      distMax: 100,       // 最大引き下げ距離 (デフォルト80より少し伸ばす)
      // distReload: 50,   // 更新開始後の戻り距離 (デフォルトのまま)

      // 他のオプション (変更なし)
      resistanceFunction: t => Math.min(1, t / 2.5),
      refreshTimeout: 5000,
      // haptics: true,
      classPrefix: 'ptr--',
    });
    console.log('PullToRefresh initialized for body trigger (top only). Threshold:', 70); // 設定値をログに出す
  } catch (error) {
    console.error('PullToRefresh initialization failed:', error);
    ptrInstance = null;
  }
}

// destroyPullToRefresh 関数は変更なし
function destroyPullToRefresh() {
  if (ptrInstance && typeof PullToRefresh !== 'undefined' && PullToRefresh.destroyAll) {
    try {
        PullToRefresh.destroyAll();
        ptrInstance = null;
        console.log('PullToRefresh instance destroyed.');
    } catch(error) {
        console.error('Error destroying PullToRefresh:', error);
        ptrInstance = null;
    }
  } else if (ptrInstance) {
      console.warn('PullToRefresh.destroyAll is not available, clearing instance reference only.');
      ptrInstance = null;
  }
}
// --- ▲▲▲ PullToRefresh 関連 (修正箇所) ▲▲▲ ---


onMounted(() => {
  registerServiceWorker();
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    currentUser.value = user;
    if (user) {
      console.log('User logged in:', user.email);
      fetchApiData();
      // PullToRefreshの初期化を少し遅らせる (変更なし)
      setTimeout(initializePullToRefresh, 100);
    } else {
      console.log('User logged out or not logged in.');
      destroyPullToRefresh();
      // データクリア処理 (変更なし)
      reports.value = [];
      storesSummaryData.value = {};
      summaryLastUpdatedData.value = null;
      fetchError.value = null;
      selectedStore.value = null;
      email.value = '';
      password.value = '';
      authError.value = null;
      subscriptionStatus.value = '';
      isLoading.value = false;
    }
  });

  onUnmounted(() => {
    unsubscribe();
    destroyPullToRefresh();
    console.log("Auth state listener and PullToRefresh destroyed on unmount.");
  });
});

</script>

<template>
  <div id="app">
    <div v-if="currentUser">
      <header class="user-info-bar">
        <span class="user-email">ログイン中: {{ currentUser.email }}</span>
        <div class="action-buttons">
          <button @click="fetchApiData(displayYear, displayMonth)" :disabled="isLoading" class="action-button">{{ isLoading ? '読込中...' : '手動更新' }}</button>
          <button @click="subscribeToNotifications" class="action-button" :disabled="isLoading || !currentUser">通知購読</button>
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

          <div v-if="isLoading && !fetchError" class="loading-message">集計データを読み込み中...</div>
          <div v-else-if="fetchError" class="error-message">{{ fetchError }}</div>
          <div v-else-if="Object.keys(storesSummaryData).length > 0">
            <div class="overall-summary">
              <p><strong>全体の月間目標 (合計):</strong> {{ calculatedOverallTarget?.toLocaleString() ?? 'N/A' }} 円</p>
              <p><strong>全体の月間売上 (合計):</strong> {{ calculatedOverallSales?.toLocaleString() ?? 'N/A' }} 円</p>
              <p><strong>全体の達成率:</strong>
                {{ calculatedOverallAchievementRate }}
                <span v-if="calculatedOverallAchievementRate !== 'N/A'"> %</span>
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
                <p><strong>売上:</strong> {{ summary?.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
                <p><strong>日次目標計:</strong> {{ summary?.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
                <p><strong>売上差額<small>(対 日次目標計)</small>:</strong>
                  <span v-if="typeof summary?.sales_amount === 'number' && typeof summary?.daily_target_amount === 'number'">
                    <span :style="{ color: (summary.sales_amount - summary.daily_target_amount) >= 0 ? '#4fc3f7' : '#ef5350', fontWeight: 'bold' }">
                      {{ (summary.sales_amount - summary.daily_target_amount) >= 0 ? '+' : '' }}{{ (summary.sales_amount - summary.daily_target_amount).toLocaleString() }} 円
                    </span>
                  </span>
                  <span v-else>計算不可</span>
                </p>
                <p><strong>客数:</strong> {{ summary?.visitor_count ?? 'N/A' }} 人 (新規: {{ summary?.new_customer_count ?? 'N/A' }}, 染め: {{ summary?.dye_customer_count ?? 'N/A' }})</p>
                <p><strong>値引計:</strong> {{ summary?.discount_amount?.toLocaleString() ?? 'N/A' }} 円</p>
                <p><strong>月間目標:</strong> {{ summary?.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
                <p><strong>レポート数:</strong> {{ summary?.reportCount ?? 'N/A' }} 件</p>
              </div>
            </div>

            <div class="chart-container">
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
           <div v-if="isLoading && !fetchError" class="loading-message">レポートリストを読み込んでいます...</div>
          <div v-else-if="fetchError" class="error-message">{{ fetchError }}</div>
          <div v-else-if="filteredAndSortedReports.length > 0" class="report-list">
            <div v-for="report in filteredAndSortedReports" :key="report.id /* または report.report_date + report.store_name など一意なキー */" class="report-card">
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
  </div>
</template>

<style scoped>
    /* グローバルな#appのpaddingをリセット (変更なし) */
    :global(#app) {
      padding-left: 0 !important;
      padding-right: 0 !important;
      box-sizing: border-box;
    }
    :global(body), :global(html) {
      /* 変更なし */
    }

    /* 基本スタイル (変更なし) */
    #app {
        padding: 0 15px;
        box-sizing: border-box;
        max-width: 1200px;
        margin: 0 auto;
    }
    main { /* 変更なし */ }
    body { font-family: sans-serif; margin: 0; background-color: #282c34; color: #e0e0e0; }
    button { padding: 8px 16px; font-size: 0.95em; cursor: pointer; border-radius: 4px; border: 1px solid #666; background-color: #444; color: #eee; transition: background-color 0.2s ease, border-color 0.2s ease; margin: 0; vertical-align: middle; }
    button:hover:not(:disabled) { background-color: #555; border-color: #777; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    hr { margin: 30px 0; border: 0; border-top: 1px solid #555; }
    h1, h2 { color: #E0E0E0; margin-top: 0; margin-bottom: 0.8em; }
    h3 { margin-top: 0; margin-bottom: 0.7em; color: #a6c0fe; }
    h4 { color: #D0D0D0; margin-bottom: 10px; text-align: center; }
    p { margin-top: 0; margin-bottom: 0.8em; line-height: 1.6; }
    small { font-size: 0.85em; color: #bbb; }

    /* --- ▼▼▼ ヘッダーバー (修正箇所) ▼▼▼ --- */
    .user-info-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0; /* #appのpaddingを利用 */
      background-color: #3a3f4a; /* 背景色は維持 */
      margin-bottom: 20px;
      border-radius: 4px;
      flex-wrap: wrap;
      gap: 10px;
      /* position: sticky; */ /* ← 削除 */
      /* top: 0; */          /* ← 削除 */
      /* z-index: 10; */     /* ← 削除 */
    }
    /* --- ▲▲▲ ヘッダーバー (修正箇所) ▲▲▲ --- */

    .user-email { color: #eee; white-space: nowrap; flex-shrink: 0; font-size: 0.9em; }
    .action-buttons { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; flex-grow: 1; }
    .action-button { font-size: 0.9em; padding: 6px 12px; }
    .logout-button { background-color: #d9534f; border-color: #d43f3a; color: white; }
    .logout-button:hover:not(:disabled) { background-color: #c9302c; border-color: #ac2925; }
    .subscription-status { text-align: right; margin-top: -15px; margin-bottom: 15px; font-size: 0.85em; color: #aaa; padding-right: 5px; }

    /* メインコンテンツ (変更なし) */
    .main-title { text-align: center; margin-bottom: 15px; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
    .section-header h2 { margin-bottom: 0; font-size: 1.4em; }
    .month-nav-buttons button { margin-left: 8px; padding: 6px 12px; font-size: 0.9em; }
    .loading-message, .no-data-message, .error-message { padding: 15px; margin-top: 15px; border-radius: 4px; text-align: center; }
    .loading-message { color: #ccc; }
    .no-data-message { color: #aaa; background-color: rgba(85, 85, 85, 0.2); }
    .error-message { color: #ffcaca; background-color: rgba(217, 83, 79, 0.2); border: 1px solid rgba(217, 83, 79, 0.4); font-weight: bold; }

    /* 全体サマリー (変更なし) */
    .overall-summary { margin-bottom: 20px; padding: 15px; background-color: #333842; border-radius: 4px; }
    .overall-summary p { margin-bottom: 6px; }
    .overall-summary p:last-child { margin-bottom: 0; }
    .overall-summary strong { color: #b8c5d6; }

    /* 店舗別サマリースライダー (変更なし) */
    .store-summary-slider {
      display: flex;
      overflow-x: auto;
      padding: 5px 30px 20px 30px;
      margin: 15px 0;
      scroll-snap-type: x mandatory;
      gap: 16px;
      -webkit-overflow-scrolling: touch;
      scroll-padding: 0 30px;
    }
    .store-summary-slider::-webkit-scrollbar { height: 10px; }
    .store-summary-slider::-webkit-scrollbar-track { background: rgba(68, 68, 68, 0.5); border-radius: 5px; }
    .store-summary-slider::-webkit-scrollbar-thumb { background-color: #777; border-radius: 5px; border: 2px solid rgba(68, 68, 68, 0.5); }
    .store-summary-slider::-webkit-scrollbar-thumb:hover { background-color: #999; }
    .store-summary-slider { scrollbar-width: thin; scrollbar-color: #777 rgba(68, 68, 68, 0.5); }

    /* 店舗別サマリーカード (変更なし) */
    .store-summary-card {
      flex: 0 0 300px;
      max-width: 300px;
      scroll-snap-align: center; /* ユーザーが前回 center にしていたので維持 */
      border: 1px solid #5a5a5a;
      border-radius: 8px;
      padding: 15px 20px;
      background-color: #3c414d;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
      cursor: pointer;
    }
    .store-summary-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.15em; border-bottom: 1px solid #555; padding-bottom: 8px; }
    .store-summary-card p { margin: 6px 0; font-size: 0.9em; color: #c0c0c0; }
    .store-summary-card p strong { margin-right: 5px; color: #dcdcdc; font-weight: 600; }
    .store-summary-card.selected-card { border-color: #41B883; box-shadow: 0 4px 10px rgba(65, 184, 131, 0.4); border-width: 2px; transform: translateY(-3px); }

    /* グラフコンテナ (変更なし) */
    .chart-container { margin-top: 30px; max-width: 800px; margin-left: auto; margin-right: auto; position: relative; height: auto; min-height: 350px; background-color: #333842; padding: 10px 20px 10px 20px; border-radius: 4px; display: flex; flex-direction: column; }
    .chart-container > :deep(div), .chart-container > *:last-child { flex-grow: 1; min-height: 300px; display: flex; align-items: stretch; }

    /* 日報セクション (変更なし) */
    .filter-reset-button { margin-left: 10px; font-size: 0.8em; padding: 4px 8px; background-color: #555; border: none; }
    .filter-reset-button:hover { background-color: #666; }
    .report-list { display: flex; flex-direction: column; gap: 16px; margin-top: 15px; }
    .report-card {
      border: 1px solid #5a5a5a;
      border-radius: 8px;
      padding: 16px;
      background-color: #3c414d;
      box-shadow: 0 2px 5px rgba(0,0,0,0.15);
      word-wrap: break-word;
      width: 90%;
      margin-left: auto;
      margin-right: auto;
      max-width: 700px;
    }
    .report-card h3 { margin-top: 0; margin-bottom: 12px; font-size: 1.1em; border-bottom: 1px solid #555; padding-bottom: 8px; }
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

    /* 初期ローディング (変更なし) */
    .loading-container { text-align: center; padding: 60px 20px; color: #ccc; font-size: 1.1em; }

    /* レスポンシブ対応 (変更なし) */
    @media (max-width: 768px) {
      #app { padding: 0 10px; }
      .chart-container { min-height: 300px; }
      .chart-container > :deep(div), .chart-container > *:last-child { min-height: 250px; }
      .store-summary-card { flex-basis: 260px; max-width: 260px; } /* スライダーカード幅は維持 */
      .report-card { width: 95%; }
    }
    @media (max-width: 600px) {
      /* ★ ヘッダー固定解除に伴い、ここの align-items も見直す必要があるかもしれないが、一旦変更しない */
      .user-info-bar { flex-direction: column; align-items: stretch; }
      .user-email { width: 100%; text-align: left; margin-bottom: 8px; }
      .action-buttons { width: 100%; justify-content: space-between; gap: 8px; }
      .action-buttons > button { flex-grow: 1; }
      .section-header { flex-direction: column; align-items: flex-start; }
      .month-nav-buttons { margin-top: 10px; width: 100%; display: flex; justify-content: space-between; }
      .month-nav-buttons button { margin-left: 0; flex-grow: 1; margin: 0 4px; }
      /* ★ スライダーのレスポンシブもユーザーが指定した値 (vw基準) に戻っているが、一旦変更しない */
      .store-summary-slider { padding-left: 5px; padding-right: 5px; scroll-padding: 0 5px; gap: 12px; margin: 15px -5px; }
      .store-summary-card { flex-basis: calc(85vw - 20px); padding: 12px 15px; }
      .report-card { border-radius: 4px; padding: 12px; width: 95%; }
      .report-card h3 { font-size: 1em; margin-bottom: 8px; padding-bottom: 6px; }
      .report-card p { font-size: 0.9em; }
      .report-card .comment-text { max-height: 100px; }
      .login-container { margin: 40px 15px; }
    }

    /* --- PullToRefreshの表示調整CSS (変更なし) --- */
    :deep(.ptr--ptr) {
      z-index: 9999 !important;
    }
    :deep(.ptr--box) { /* 変更なし */ }
    :deep(.ptr--icon) {
      color: #4fc3f7;
    }
    :deep(.ptr--text) {
      color: #ffffff;
    }
</style>