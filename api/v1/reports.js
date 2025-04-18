// api/v1/reports.js (toLocaleString デバッグログ + VAPID設定修正 + プッシュ通知送信機能付き)

const admin = require('firebase-admin');
const webpush = require('web-push');

// --- Firebase Admin SDK Initialization --- (トップレベルでOK)
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var not set.'); }
  const serviceAccount = JSON.parse(serviceAccountJson);
  if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
     throw new Error('Parsed service account object missing required properties.');
  }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("Firebase Admin SDK Initialized Successfully!");
  } else {
    console.log("Firebase Admin SDK Already Initialized.");
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error:', e);
  throw new Error(`Firebase Admin SDK Initialization Failed: ${e.message}`);
}
const db = admin.firestore();

// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  // --- Env Var Check Logs --- (デバッグ用に残す)
  console.log('--- START ENV VAR CHECK (inside handler) ---');
  console.log('EXPECTED_API_KEY exists:', !!process.env.EXPECTED_API_KEY);
  console.log('FIREBASE_SERVICE_ACCOUNT_JSON exists:', !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON, 'Length:', (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').length);
  console.log('VAPID_SUBJECT exists:', !!process.env.VAPID_SUBJECT, 'Value:', process.env.VAPID_SUBJECT);
  console.log('VAPID_PUBLIC_KEY exists:', !!process.env.VAPID_PUBLIC_KEY, 'Value (start):', (process.env.VAPID_PUBLIC_KEY || '').substring(0, 10));
  console.log('VAPID_PRIVATE_KEY exists:', !!process.env.VAPID_PRIVATE_KEY, 'Value (start):', (process.env.VAPID_PRIVATE_KEY || '').substring(0, 10));
  console.log('--- END ENV VAR CHECK (inside handler) ---');

  // --- DB Init Check ---
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' });
  }

  // --- VAPID Configuration --- (ハンドラ内に移動済み)
  let vapidKeysConfigured = false;
  console.log('--- VAPID CONFIG START (inside handler) ---');
  try {
    const vapidSubject = process.env.VAPID_SUBJECT;
    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

    if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
      console.warn('[VAPID Config] VAPID env vars not fully set inside handler.');
    } else {
      console.log('[VAPID Config] All VAPID env vars present inside handler. Configuring...');
      try {
          webpush.setVapidDetails(
            vapidSubject,
            vapidPublicKey,
            vapidPrivateKey
          );
          console.log('[VAPID Config] webpush.setVapidDetails called successfully inside handler.');
          vapidKeysConfigured = true;
          console.log('[VAPID Config] vapidKeysConfigured flag set to true inside handler.');
      } catch (setDetailsError) {
           console.error('[VAPID Config] Error DIRECTLY from setVapidDetails inside handler:', setDetailsError);
      }
    }
  } catch(e) {
    console.error("[VAPID Config] Outer catch error inside handler", e);
  }
  console.log(`[VAPID Config] Final check inside handler: vapidKeysConfigured = ${vapidKeysConfigured}`);
  console.log('--- VAPID CONFIG END (inside handler) ---');

  // --- Method & Auth Check ---
  if (req.method !== 'POST') { return res.status(405).json({ error: `Method ${req.method} Not Allowed` }); }
  const providedApiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.EXPECTED_API_KEY;
  if (!providedApiKey || providedApiKey !== expectedApiKey) { return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }

  let savedReportId = null;

  try {
    // --- リクエストボディ取得 & 基本Validation ---
    const reportData = req.body;
    console.log('Received report data:', reportData);
    if (!reportData || !reportData.report_date || !reportData.store_name /* etc */) {
        console.error('Validation Error: Missing required fields in report data');
        return res.status(400).json({ error: '必須項目が不足しています。' });
    }
    // TODO: Add more detailed validation

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
    if (vapidKeysConfigured) {
        console.log('VAPID keys seem configured, proceeding to fetch subscriptions...');
        const subscriptionsSnapshot = await db.collection('pushSubscriptions').get();

        if (subscriptionsSnapshot.empty) {
          console.log('No push subscriptions found.');
        } else {
          console.log(`Found ${subscriptionsSnapshot.size} subscriptions. Preparing to send...`);

          // ★★★★★ toLocaleString 前のデバッグログ ★★★★★
          console.log('DEBUG: Checking reportPayload before creating notification:');
          console.log('DEBUG: reportPayload:', JSON.stringify(reportPayload, null, 2)); // オブジェクト全体
          console.log('DEBUG: reportPayload.sales_amount:', reportPayload.sales_amount, typeof reportPayload.sales_amount); // 売上金額と型
          console.log('DEBUG: reportPayload.daily_target_amount:', reportPayload.daily_target_amount, typeof reportPayload.daily_target_amount); // 日次目標と型
          // ★★★★★ ここまで追加 ★★★★★

          // 通知ペイロードを作成
          const notificationPayload = JSON.stringify({
            title: `[${reportPayload.store_name}] 新しい日報`,
            // ↓↓↓ ここでエラーが発生していた箇所 ↓↓↓
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
        console.warn('VAPID keys NOT configured correctly for this request, skipping.');
    }
    // ★★★ ここまで ★★★

    // --- Return Success Response ---
    return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });

  } catch (error) {
    // --- Error Handling ---
    console.error('Error processing report request:', error);
    if (error instanceof TypeError && error.message.includes('toLocaleString')) {
        console.error('>>> Likely error during toLocaleString() call!');
         return res.status(500).json({ error: `サーバー内部でエラー (toLocaleString): ${error.message}` });
    }
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
        return res.status(400).json({ error: 'リクエストボディのJSON形式が不正です。' });
    }
    return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
  }
};