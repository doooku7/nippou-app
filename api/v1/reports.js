// api/v1/reports.js (さらに詳細なデバッグログ + プッシュ通知送信機能付き)

const admin = require('firebase-admin');
const webpush = require('web-push');

// --- Firebase Admin SDK Initialization ---
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.');
  }
  const serviceAccount = JSON.parse(serviceAccountJson);
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
     throw new Error('Parsed service account object is missing required properties (project_id, private_key, client_email).');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK Initialized Successfully (from reports)!");
  } else {
    console.log("Firebase Admin SDK Already Initialized (from reports).");
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error (from reports):', e);
  throw new Error(`Firebase Admin SDK Initialization Failed: ${e.message}`);
}
const db = admin.firestore();

// --- VAPID Configuration ---
let vapidKeysConfigured = false; // フラグ初期化
console.log('--- VAPID CONFIG START ---'); // ★追加ログ
try {
  const vapidSubject = process.env.VAPID_SUBJECT;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

  // 環境変数の存在チェック (ログ出力はenv var checkで行うのでここでは省略)
  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    console.warn('[VAPID Config] VAPID environment variables are not fully set.');
  } else {
    console.log('[VAPID Config] All VAPID env vars seem present. Attempting to configure web-push...'); // ★追加ログ
    try { // ★ setVapidDetails 専用の try-catch を追加
        webpush.setVapidDetails(
          vapidSubject,
          vapidPublicKey,
          vapidPrivateKey
        );
        // ★ setVapidDetails が成功した場合のログを追加
        console.log('[VAPID Config] webpush.setVapidDetails called successfully.');
        vapidKeysConfigured = true; // ★ フラグを立てる
        // ★ フラグを立てた直後のログを追加
        console.log('[VAPID Config] vapidKeysConfigured flag set to true.');
    } catch (setDetailsError) {
         // ★ setVapidDetails がエラーを投げた場合のログ
         console.error('[VAPID Config] Error thrown DIRECTLY from webpush.setVapidDetails:', setDetailsError);
    }
  }
} catch(e) {
  // ★ VAPID設定ブロック全体での予期せぬエラー
  console.error("[VAPID Config] Outer catch block error during VAPID config", e);
}
console.log(`[VAPID Config] Final check: vapidKeysConfigured = ${vapidKeysConfigured}`); // ★最終的なフラグの状態をログ出力
console.log('--- VAPID CONFIG END ---'); // ★追加ログ

// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  // --- 環境変数チェックログ (前回追加したもの) ---
  console.log('--- START ENV VAR CHECK ---');
  console.log('EXPECTED_API_KEY exists:', !!process.env.EXPECTED_API_KEY);
  console.log('FIREBASE_SERVICE_ACCOUNT_JSON exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON, 'Length:', (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').length);
  console.log('VAPID_SUBJECT exists:', !!process.env.VAPID_SUBJECT, 'Value:', process.env.VAPID_SUBJECT);
  console.log('VAPID_PUBLIC_KEY exists:', !!process.env.VAPID_PUBLIC_KEY, 'Value (start):', (process.env.VAPID_PUBLIC_KEY || '').substring(0, 10));
  console.log('VAPID_PRIVATE_KEY exists:', !!process.env.VAPID_PRIVATE_KEY, 'Value (start):', (process.env.VAPID_PRIVATE_KEY || '').substring(0, 10));
  console.log('--- END ENV VAR CHECK ---');

  // --- DB初期化チェック ---
  if (!db) {
    console.error('Firestore DB instance is not available (reports).');
    return res.status(500).json({ error: 'サーバー設定エラーが発生しました (DB Init Failed)。' });
  }

  // --- メソッド & 認証チェック (省略) ---
  if (req.method !== 'POST') { /* ... */ return res.status(405).json({ error: `Method ${req.method} Not Allowed` }); }
  const providedApiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.EXPECTED_API_KEY;
  if (!providedApiKey || providedApiKey !== expectedApiKey) { /* ... */ return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }

  let savedReportId = null;

  try {
    // --- リクエストボディ取得 & 基本Validation (省略) ---
    const reportData = req.body;
    console.log('Received report data:', reportData);
    if (!reportData || !reportData.report_date || !reportData.store_name /* ... */) { /* ... */ return res.status(400).json({ error: '必須項目が不足しています。' }); }

    // --- Prepare Data for Firestore (省略) ---
    const reportPayload = { /* ... */ };

    // --- Save Report to Firestore ---
    const docRef = await db.collection('reports').add(reportPayload);
    savedReportId = docRef.id;
    console.log('Report document written with ID: ', savedReportId);

    // ★★★ プッシュ通知送信処理 ★★★
    console.log('Attempting to send push notifications...');
    // ★ 修正: vapidKeysConfigured フラグを直接参照
    if (vapidKeysConfigured) {
        console.log('VAPID keys seem configured, proceeding to fetch subscriptions...'); // ★追加ログ
        const subscriptionsSnapshot = await db.collection('pushSubscriptions').get();
        if (subscriptionsSnapshot.empty) {
          console.log('No push subscriptions found.');
        } else {
          console.log(`Found ${subscriptionsSnapshot.size} subscriptions. Preparing to send...`);
          const notificationPayload = JSON.stringify({ /* ... */ });
          const sendPromises = [];
          subscriptionsSnapshot.forEach(doc => { /* ... (webpush.sendNotification call inside) ... */ });
          const results = await Promise.allSettled(sendPromises);
          console.log('Push notification sending results:', results.map(r => r.status));
        }
    } else {
        // このログが依然として出るかどうかが焦点
        console.warn('VAPID keys not configured correctly OR error occurred during configuration, skipping push notifications.');
    }
    // ★★★ ここまで ★★★

    // --- Return Success Response ---
    return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });

  } catch (error) {
    // --- Error Handling (省略) ---
    console.error('Error processing report request:', error);
    /* ... */
    return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
  }
};