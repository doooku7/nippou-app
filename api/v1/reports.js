// api/v1/reports.js (プッシュ通知送信機能付き)
const admin = require('firebase-admin');
const webpush = require('web-push'); // ★ web-pushライブラリをインポート

// --- Firebase Admin SDK Initialization ---
// (変更なし、ただしエラー時はスローするように調整)
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
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
  throw new Error('Firebase Admin SDK Initialization Failed');
}
const db = admin.firestore();

// ★★★ VAPID キーの設定 ★★★
try {
  const vapidSubject = process.env.VAPID_SUBJECT;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

  // 環境変数がすべてセットされているか確認
  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    console.error('VAPID environment variables are not fully set. Push notifications disabled.');
    // VAPIDキーがない場合はプッシュ通知を試行しないようにする
  } else {
    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );
    console.log("Web Push VAPID details configured.");
  }
} catch(e) {
  console.error("Error configuring VAPID details", e);
  // VAPID設定エラーの場合もプッシュ通知は送られない
}
// ★★★ ここまで追加 ★★★


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  if (!db) {
    console.error('Firestore DB instance is not available (reports).');
    return res.status(500).json({ error: 'サーバー設定エラーが発生しました (DB Init Failed)。' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
  const providedApiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.EXPECTED_API_KEY;
  if (!providedApiKey || providedApiKey !== expectedApiKey) {
    return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' });
  }

  let savedReportId = null;

  try {
    const reportData = req.body;
    console.log('Received report data:', reportData);

    // --- Basic Validation (省略) ---
    if (!reportData || !reportData.report_date || !reportData.store_name /* ... */) {
      console.error('Validation Error: Missing required fields in report data');
      return res.status(400).json({ error: '必須項目が不足しています。' });
    }

    // --- Prepare Data for Firestore (省略) ---
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

    // ★★★ プッシュ通知送信処理を追加 ★★★
    console.log('Attempting to send push notifications...');
    // VAPIDキーが設定されている場合のみ実行
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
        const subscriptionsSnapshot = await db.collection('pushSubscriptions').get();

        if (subscriptionsSnapshot.empty) {
          console.log('No push subscriptions found.');
        } else {
          console.log(`Found ${subscriptionsSnapshot.size} subscriptions. Preparing to send...`);

          // 通知ペイロード（通知内容）を作成
          // TODO: 月次集計結果なども含める
          const notificationPayload = JSON.stringify({
            title: `[${reportPayload.store_name}] 新しい日報`,
            body: `売上: ${reportPayload.sales_amount.toLocaleString()}円 (日次目標: ${reportPayload.daily_target_amount.toLocaleString()}円)`,
            // icon: '/icon.png', // アイコンも指定できる
            // data: { url: '/some-report-url' } // 通知クリック時の遷移先など
          });

          const sendPromises = []; // 各通知送信のPromiseを格納する配列
          subscriptionsSnapshot.forEach(doc => {
            const subscriptionRecord = doc.data();
            if (subscriptionRecord.subscription && subscriptionRecord.subscription.endpoint) {
              console.log(`Sending notification to endpoint starting with: ${subscriptionRecord.subscription.endpoint.substring(0, 40)}...`);

              // webpush.sendNotification は Promise を返す
              const pushPromise = webpush.sendNotification(
                subscriptionRecord.subscription, // 保存されている購読情報オブジェクト
                notificationPayload // 通知内容
              ).catch(err => {
                // 送信エラー処理
                console.error(`Failed to send notification to ${subscriptionRecord.subscription.endpoint.substring(0, 40)}... Error: ${err.statusCode} ${err.message}`);
                // エラーが 404 or 410 なら、購読が無効になっているのでFirestoreから削除
                if (err.statusCode === 404 || err.statusCode === 410) {
                  console.log(`Deleting expired/invalid subscription: ${doc.id}`);
                  return doc.ref.delete(); // 削除処理 (これもPromise)
                }
                // 他のエラーはログに残すだけ（リトライなどはここではしない）
              });
              sendPromises.push(pushPromise); // Promiseを配列に追加

            } else {
               console.warn(`Subscription document ${doc.id} is invalid.`);
            }
          });

          // 全ての通知送信（と削除）の試行が終わるのを待つ
          const results = await Promise.allSettled(sendPromises);
          console.log('Push notification sending results:', results.map(r => r.status)); // 結果のステータスだけログ出力
        }
    } else {
        console.warn('VAPID keys not configured, skipping push notifications.');
    }
    // ★★★ ここまで追加 ★★★

    // --- Return Success Response ---
    // プッシュ通知の成否に関わらず、日報の保存が成功したら201を返す
    return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });

  } catch (error) {
    // --- Error Handling ---
    console.error('Error processing report request:', error);
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
        return res.status(400).json({ error: 'リクエストボディのJSON形式が不正です。' });
    }
    return res.status(500).json({ error: 'サーバー内部でエラーが発生しました。' });
  }
};