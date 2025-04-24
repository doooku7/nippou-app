<script setup>
import { ref, onMounted, computed } from 'vue';
import StoreSalesChart from './components/StoreSalesChart.vue'; // グラフコンポーネント

// ★ Firebase Auth 関連をインポート ★
import { auth } from './firebaseConfig'; // 作成した設定ファイルをインポート
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

// --- Notification Subscription Logic (変更なし) ---
// ... (existing code) ...
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
const reports = ref([]);
const storesSummaryData = ref({});
const overallTargetData = ref(0);
const summaryLastUpdatedData = ref(null);
const isLoading = ref(true); // Start as true until auth state is known
const fetchError = ref(null);
const selectedStore = ref(null);

// ★★★ ログイン関連の ref 変数を追加 ★★★
const email = ref('');
const password = ref('');
const authError = ref(null);
const currentUser = ref(null); // 現在のユーザー (null = 未ログイン)

// 日付フォーマット関数
function formatDateTime(isoString) {
  if (!isoString) return 'N/A'; try { const date = new Date(isoString); return date.toLocaleString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { console.error("Error formatting date:", e); return isoString; }
}

// API呼び出し関数
async function fetchApiData() {
  // isLoading.value = true; // ローディングは onAuthStateChanged で管理
  fetchError.value = null; // エラーリセット
  // データリセットも onAuthStateChanged で行うのでここでは不要かも
  // reports.value = [];
  // storesSummaryData.value = {};
  // overallTargetData.value = 0;
  // summaryLastUpdatedData.value = null;
  // selectedStore.value = null;

  console.log('Fetching reports and summaries from /api/v1/reports...');

  try {
    // ★★★ ↓↓↓ ここから追加・変更 ↓↓↓ ★★★
    if (!currentUser.value) {
      // この関数はログイン後に呼ばれるはずだが、念のためチェック
      throw new Error('ユーザーがログインしていません。');
    }

    console.log("Getting ID token for API request...");
    // 現在のユーザーからIDトークンを取得 (これは非同期処理！)
    const idToken = await currentUser.value.getIdToken();

    // fetch リクエストに Authorization ヘッダーを追加するための headers オブジェクトを作成
    const headers = {
      'Authorization': `Bearer ${idToken}`
    };
    console.log("Fetching API with Authorization header...");

    // fetch 呼び出しに headers オプションを追加して実行
    const response = await fetch('/api/v1/reports', { headers: headers });
    // ★★★ ↑↑↑ ここまで追加・変更 ↑↑↑ ★★★

    if (!response.ok) {
      // APIからのエラーメッセージを取得・表示するように改善
      let errorMsg = `HTTP error! status: ${response.status}`;
      try {
         // エラー応答がJSON形式の場合、メッセージを取得試行
         const errorData = await response.json();
         errorMsg = errorData.error || errorMsg;
      } catch(e) { /* JSON parse error */ }
      // 401/403エラーの場合は再ログインを促すメッセージを追加しても良い
      if (response.status === 401 || response.status === 403) {
          errorMsg = `アクセス権エラー: ${errorMsg} 再ログインが必要な場合があります。`;
          // handleLogout(); // 強制的にログアウトさせることも可能
      }
      throw new Error(errorMsg);
    }
    const data = await response.json();

    // ref へのデータ代入部分は変更なし
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
    // fetchError ref にエラーメッセージを設定してテンプレートで表示
    fetchError.value = `データ取得に失敗: ${error.message}`;
    // エラー発生時はデータをクリア
    reports.value = [];
    storesSummaryData.value = {};
    overallTargetData.value = 0;
    summaryLastUpdatedData.value = null;
  } finally {
    // isLoading.value = false; // ローディング解除は onAuthStateChanged で行う
  }
}

// 日付順ソート用 computed
const sortedReports = computed(() => {
  // ... (same as before) ...
  if (!reports.value || reports.value.length === 0) return [];
  return [...reports.value].sort((a, b) => {
    try {
      const dateA = new Date(a.report_date.replace(/\//g, '-'));
      const dateB = new Date(b.report_date.replace(/\//g, '-'));
      if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) return 0;
      return dateB - dateA; // 降順
    } catch (e) { return 0; }
  });
});

// フィルター用関数
function filterByStore(storeName) {
  // ... (same as before) ...
  selectedStore.value = (selectedStore.value === storeName) ? null : storeName;
  console.log("Filtering by store:", selectedStore.value);
}

// フィルターされたレポートリスト用 computed
const filteredAndSortedReports = computed(() => {
  // ... (same as before) ...
  if (!selectedStore.value) return sortedReports.value;
  return sortedReports.value.filter(report => report.store_name === selectedStore.value);
});

// ★★★ ログイン処理関数 ★★★
async function handleLogin() {
  authError.value = null;
  try {
    console.log(`Attempting login for: ${email.value}`);
    const userCredential = await signInWithEmailAndPassword(auth, email.value, password.value);
    console.log("Login successful:", userCredential.user.uid);
    // ログイン成功 → onAuthStateChanged が検知して currentUser が更新され、データが fetch される
  } catch (error) {
    console.error("Login failed:", error.code, error.message);
    authError.value = `ログインエラー: ${error.message}`;
  }
}

// ★★★ ログアウト処理関数 ★★★
async function handleLogout() {
  try {
    await signOut(auth);
    console.log("Logout successful");
    // ログアウト成功 → onAuthStateChanged が検知して currentUser が null になり、データがクリアされる
  } catch (error) {
    console.error("Logout failed:", error);
  }
}

// マウント時の処理
onMounted(() => {
  // ★ Firebase Auth のログイン状態変化を監視 ★
  onAuthStateChanged(auth, (user) => {
    isLoading.value = false; // 認証状態が確定したらローディング表示終了
    if (user) {
      // ログイン中
      currentUser.value = user;
      console.log("User signed in:", user.uid, user.email);
      fetchApiData(); // ★ ログイン後にデータを取得
    } else {
      // ログアウト中
      currentUser.value = null;
      console.log("User signed out.");
      // ★ 表示データをクリア ★
      reports.value = [];
      storesSummaryData.value = {};
      overallTargetData.value = 0;
      summaryLastUpdatedData.value = null;
      fetchError.value = null;
    }
  });
  // checkSubscriptionStatus(); // 通知購読状態チェック (必要なら)
});
// --- End Report Display Logic ---
</script>

<template>
  <!-- ★ ログインしている場合のみ表示するメインコンテンツ ★ -->
  <div v-if="currentUser" class="main-content">
    <div class="user-info">
      <span>ログイン中: {{ currentUser.email }}</span>
      <button @click="handleLogout" class="logout-button">ログアウト</button>
    </div>
    <hr>

    <!-- ↓↓↓ 元々のコンテンツはここに入れる ↓↓↓ -->
    <div>
      <h1>日報アプリ - 通知設定</h1>
      <p>日報が届いたときにプッシュ通知を受け取るには、以下のボタンを押して通知を許可してください。</p>
      <button @click="subscribeToNotifications">通知を購読する</button> <!-- TODO: Add v-if="!isSubscribed" later -->
      <p v-if="subscriptionStatus">{{ subscriptionStatus }}</p>
    </div>

    <hr>
    <div>
      <h2>月次集計 (店舗別)</h2>
      <button @click="fetchApiData" :disabled="isLoading">
        {{ isLoading ? '読み込み中...' : '最新情報に更新' }}
      </button>
      <div v-if="isLoading">集計データを読み込み中...</div>
      <div v-else-if="fetchError" style="color: red;">集計データの読み込みエラー: {{ fetchError }}</div>
      <div v-else-if="Object.keys(storesSummaryData).length > 0">
         <p><strong>全体の月間目標:</strong> {{ overallTargetData?.toLocaleString() ?? 'N/A' }} 円</p>
         <p v-if="summaryLastUpdatedData"><small>最終集計日時: {{ formatDateTime(summaryLastUpdatedData) }}</small></p>
         <div class="store-summary-cards">
           <div v-for="(summary, storeName) in storesSummaryData" :key="storeName" class="store-summary-card" @click="filterByStore(storeName)" style="cursor: pointer;" :class="{ 'selected-card': selectedStore === storeName }">
             <h3>{{ storeName }}</h3>
             <p><strong>売上:</strong> {{ summary.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
             <p><strong>売上差額<small>(対 日次目標計)</small>:</strong> <span v-if="typeof summary.sales_amount === 'number' && typeof summary.daily_target_amount === 'number'">{{ (summary.sales_amount - summary.daily_target_amount).toLocaleString() }} 円</span><span v-else>計算不可</span></p>
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
        <button v-if="selectedStore" @click="filterByStore(null)" style="margin-left: 10px; font-size: 0.8em; padding: 4px 8px;">({{ selectedStore }} のフィルター解除)</button>
      </h2>
      <div v-if="isLoading && reports.length === 0">レポートリストを読み込んでいます...</div>
      <div v-else-if="filteredAndSortedReports.length > 0" class="report-list-cards">
        <div v-for="report in filteredAndSortedReports" :key="report.id" class="report-card">
            <h3>{{ report.report_date }} - {{ report.store_name }}</h3>
            <p><strong>売上:</strong> {{ report.sales_amount?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>日次目標:</strong> {{ report.daily_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>月間目標:</strong> {{ report.monthly_target_amount?.toLocaleString() ?? 'N/A' }} 円</p>
            <p><strong>来店:</strong> {{ report.visitor_count ?? 'N/A' }} 人 (新規: {{ report.new_customer_count ?? 'N/A' }}, 染め: {{ report.dye_customer_count ?? 'N/A' }})</p>
             <p><strong>値引:</strong> {{ report.discount_amount?.toLocaleString() ?? 'N/A' }} 円</p> <!-- ★ レポートカードにも値引表示追加 (任意) -->
            <p v-if="report.comment"><strong>コメント:</strong><br><span class="comment-text">{{ report.comment }}</span></p>
            <small class="report-meta">登録日時: {{ formatDateTime(report.createdAt) }} (ID: {{ report.id }})</small>
        </div>
      </div>
      <p v-else-if="!isLoading && !fetchError">
        <span v-if="selectedStore" style="font-weight: bold;">{{ selectedStore }} の</span>表示できる最近の日報データがありません。
      </p>
    </div>
    <!-- ↑↑↑ 元々のコンテンツここまで ↑↑↑ -->

  </div>

  <!-- ★ ログインしていない場合に表示するログインフォーム ★ -->
  <!-- isLoading が false になってから表示 (認証状態確認後) -->
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

  <!-- ★ 認証状態を確認中のローディング表示 ★ -->
  <div v-else class="loading-container">
     <p>認証状態を確認中...</p>
     <!-- ここにスピナーなどを追加しても良い -->
  </div>
</template>

<style scoped>
  /* ★★★ ログインフォーム用のスタイル例 ★★★ */
  .login-container { padding: 20px; max-width: 500px; margin: 40px auto; }
  .login-form { max-width: 400px; margin: 20px auto; padding: 20px; border: 1px solid #555; border-radius: 8px; background-color: #333; }
  .form-group { margin-bottom: 15px; }
  .form-group label { display: block; margin-bottom: 5px; color: #eee; font-weight: bold; }
  .form-group input { width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #555; background-color: #444; color: #eee; border-radius: 4px; font-size: 1em;}
  .error-message { color: #ff6b6b; margin-top: 10px; font-weight: bold; }
  .loading-container { text-align: center; padding: 50px; color: #ccc; }
  .user-info { text-align: right; margin-bottom: 10px; color: #eee; background-color: #444; padding: 10px; border-radius: 4px; } /* 少しスタイル調整 */
  .logout-button { font-size: 0.9em; padding: 5px 10px; margin-left: 10px; }

  /* ★★★ store-summary-cards 用のスタイル ★★★ */
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
    transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
    cursor: pointer; /* クリック可能を示すカーソルは style 属性からこちらに移動 */
  }
  /* 選択中カードのスタイル */
  .store-summary-card.selected-card {
      border-color: #41B883; /* Vue Green */
      box-shadow: 0 3px 8px rgba(65, 184, 131, 0.5);
      border-width: 2px;
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
    /* font-weight: 600; */ /* 強調しすぎないようにコメントアウト */
   }

   /* --- レポートカード等、既存のスタイル --- */
   button { padding: 10px 20px; font-size: 16px; cursor: pointer; margin-right: 10px; margin-bottom: 10px;}
   /* ログインフォーム内のボタンは別途スタイル指定 */
   .login-form button { width: 100%; }
   .user-info button { margin-bottom: 0; } /* ユーザー情報欄のボタンの下マージン削除 */

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