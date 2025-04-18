// api/v1/reports.js (環境変数デバッグログ + プッシュ通知送信機能付き)

const admin = require('firebase-admin');
const webpush = require('web-push'); // web-pushライブラリをインポート

// --- Firebase Admin SDK Initialization ---
// (変更なし、ただしエラー時はスローするように調整)
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.');
  }
  const serviceAccount = JSON.parse(serviceAccountJson);
  // JSONパース後のチェックを追加 (念のため)
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
  // 初期化失敗は致命的なのでエラーをスローして Vercel に知らせる
  throw new Error(`Firebase Admin SDK Initialization Failed: ${e.message}`);
}
const db = admin.firestore();

// --- VAPID Configuration ---
let vapidKeysConfigured = false; // VAPID設定が完了したかのフラグ
try {
  const vapidSubject = process.env.VAPID_SUBJECT;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

  // 環境変数がすべてセットされているか確認
  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    console.warn('VAPID environment variables are not fully set. Push notifications will be disabled.');
  } else {
    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );
    vapidKeysConfigured = true; // 設定成功フラグを立てる
    console.log("Web Push VAPID details configured successfully.");
  }
} catch(e) {
  console.error("Error configuring VAPID details", e);
  // VAPID設定エラーの場合もプッシュ通知は送られない
}

// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  // ★★★★★ 環境変数を先頭で全てログ出力 ★★★★★
  console.log('--- START ENV VAR CHECK ---');
  // !! は変数が存在すれば true, なければ false を出力
  console.log('EXPECTED_API_KEY exists:', !!process.env.EXPECTED_API_KEY);
  console.log('FIREBASE_SERVICE_ACCOUNT_JSON exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON, 'Length:', (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').length); // JSONは長いので長さだけ
  console.log('VAPID_SUBJECT exists:', !!process.env.VAPID_SUBJECT, 'Value:', process.env.VAPID_SUBJECT); // 値も出力
  console.log('VAPID_PUBLIC_KEY exists:', !!process.env.VAPID_PUBLIC_KEY, 'Value (start):', (process.env.VAPID_PUBLIC_KEY || '').substring(0, 10)); // 値の先頭10文字
  console.log('VAPID_PRIVATE_KEY exists:', !!process.env.VAPID_PRIVATE_KEY, 'Value (start):', (process.env.VAPID_PRIVATE_KEY || '').substring(0, 10)); // 値の先頭10文字
  console.log('--- END ENV VAR CHECK ---');
  // ★★★★★ ここまで追加 ★★★★★

  // --- DB初期化チェック ---
  if (!db) {
    console.error('Firestore DB instance is not available (reports).');
    // このエラーは通常、上の初期化でthrowされるはずだが念のため
    return res.status(500).json({ error: 'サーバー設定エラーが発生しました (DB Init Failed)。' });
  }

  // --- メソッドチェック ---
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // --- 認証チェック ---
  const providedApiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.EXPECTED_API_KEY;
  if (!providedApiKey || providedApiKey !== expectedApiKey) {
    return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' });
  }

  let savedReportId = null;

  try {
    // --- リクエストボディ取得 ---
    const reportData = req.body;
    console.log('Received report data:', reportData);

    // --- Basic Validation ---
    if (!reportData || !reportData.report_date || !reportData.store_name /* etc */) {
      console.error('Validation Error: Missing required fields in report data');
      return res.status(400).json({ error: '必須項目が不足しています。' });
    }
    // TODO: Add more detailed validation (data types, formats, ranges)

    // --- Prepare Data for Firestore ---
    const reportPayload = {
      report_date: reportData.report_date,
      store_name: reportData.store_name,
      sales_amount: Number(reportData.sales_amount) || 0,
      daily_target_amount: Number(reportData.daily_target_amount) || 0,
      visitor_count: Number(reportData.visitor_count) || 0,
      new_customer_count: Number(reportData.new_customer_count) || 0,
      dye_customer_count: Number(reportData.dye_customer_count) || 0,
      comment: reportData.comment || null,
      monthly_target_amount: Number(reportData.monthly_target_amount) || 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // --- Save Report to Firestore ---
    const docRef = await db.collection('reports').add(reportPayload);
    savedReportId = docRef.id;
    console.log('Report document written with ID: ', savedReportId);

    // ★★★ プッシュ通知送信処理 ★★★
    console.log('Attempting to send push notifications...');
    // VAPIDキーが正しく設定されている場合のみ実行
    if (vapidKeysConfigured) {
        const subscriptionsSnapshot = await db.collection('pushSubscriptions').get();

        if (subscriptionsSnapshot.empty) {
          console.log('No push subscriptions found.');
        } else {
          console.log(`Found ${subscriptionsSnapshot.size} subscriptions. Preparing to send...`);

          // 通知ペイロードを作成
          // TODO: 月次集計結果なども含める
          const notificationPayload = JSON.stringify({
            title: `[${reportPayload.store_name}] 新しい日報`,
            body: `売上: ${reportPayload.sales_amount.toLocaleString()}円 (日次目標: ${reportPayload.daily_target_amount.toLocaleString()}円)`,
          });

          const sendPromises = [];
          subscriptionsSnapshot.forEach(doc => {
            const subscriptionRecord = doc.data();
            if (subscriptionRecord.subscription && subscriptionRecord.subscription.endpoint) {
              console.log(`Sending notification to endpoint starting with: ${subscriptionRecord.subscription.endpoint.substring(0, 40)}...`);
              const pushPromise = webpush.sendNotification(
                subscriptionRecord.subscription,
                notificationPayload
              ).catch(err => {
                console.error(`Failed to send notification to ${subscriptionRecord.subscription.endpoint.substring(0, 40)}... Error: ${err.statusCode} ${err.message}`);
                if (err.statusCode === 404 || err.statusCode === 410) {
                  console.log(`Deleting expired/invalid subscription: ${doc.id}`);
                  return doc.ref.delete();
                }
              });
              sendPromises.push(pushPromise);
            } else {
               console.warn(`Subscription document ${doc.id} is invalid.`);
            }
          });

          const results = await Promise.allSettled(sendPromises);
          console.log('Push notification sending results:', results.map(r => r.status));
        }
    } else {
        console.warn('VAPID keys not configured correctly, skipping push notifications.'); // より明確なログに変更
    }
    // ★★★ ここまで ★★★

    // --- Return Success Response ---
    return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });

  } catch (error) {
    // --- Error Handling ---
    console.error('Error processing report request:', error);
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
        return res.status(400).json({ error: 'リクエストボディのJSON形式が不正です。' });
    }
    // Firestore保存前などのエラーも考慮
    return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
  }
};