// api/v1/reports.js (GET:レポート取得 と POST:レポート登録・通知送信 の両方を処理)

const admin = require('firebase-admin');
const webpush = require('web-push');

// --- Firebase Admin SDK Initialization ---
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
const db = admin.firestore(); // Get DB instance after successful init

// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  // --- DB Init Check ---
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' });
  }

  // ============ リクエストメソッドによる処理分岐 ============
  if (req.method === 'GET') {
      // --- GETリクエスト処理 (日報リスト取得) ---
      console.log('[GET /api/v1/reports] Received request');
      try {
          const limit = 50; // 一度に取得する件数上限
          const querySnapshot = await db.collection('reports')
                                      .orderBy('createdAt', 'desc') // 保存された日時が新しい順
                                      // .orderBy('report_date', 'desc') // または報告日で並び替えたい場合
                                      .limit(limit)
                                      .get();

          const reports = [];
          querySnapshot.forEach(doc => {
              const data = doc.data();
              // FirestoreのTimestampをISO文字列に変換 (フロントエンドで扱いやすくするため)
              const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null;
              reports.push({
                  id: doc.id,         // ドキュメントIDも含める
                  ...data,            // 元のデータを展開
                  createdAt: createdAtISO // 変換後のタイムスタンプで上書き
              });
          });

          console.log(`[GET /api/v1/reports] Fetched ${reports.length} reports.`);
          return res.status(200).json(reports); // 取得したレポートの配列をJSONで返す

      } catch (error) {
          console.error('[GET /api/v1/reports] Error fetching reports:', error);
          return res.status(500).json({ error: 'レポートの取得中にエラーが発生しました。' });
      }

  } else if (req.method === 'POST') {
      // --- POSTリクエスト処理 (日報登録 & プッシュ通知) ---
      console.log('[POST /api/v1/reports] Received request');

      // (環境変数チェックログ、VAPID設定、認証チェックは変更なし)
      console.log('--- START ENV VAR CHECK ...'); /* ... */ console.log('--- END ENV VAR CHECK ...');
      let vapidKeysConfigured = false;
      console.log('--- VAPID CONFIG START ...'); /* ... */ console.log('--- VAPID CONFIG END ...');
      try { /* ... configure webpush ... */ vapidKeysConfigured = true; /* ... */ } catch (e) { /* ... */ }

      const providedApiKey = req.headers['x-api-key']; /* ... */
      if (!providedApiKey || providedApiKey !== process.env.EXPECTED_API_KEY) { return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }

      let savedReportId = null;
      try {
          const reportData = req.body; /* ... */
          if (!reportData || !reportData.report_date /* ... */) { return res.status(400).json({ error: '必須項目が不足しています。' }); }
          const reportPayload = { /* ... */ }; // (変更なし)
          const docRef = await db.collection('reports').add(reportPayload);
          savedReportId = docRef.id;
          console.log('Report document written with ID: ', savedReportId);

          // --- Push Notification Sending --- (変更なし)
          console.log('Attempting to send push notifications...');
          if (vapidKeysConfigured) {
              console.log('VAPID keys configured, proceeding...');
              // デバッグログ
              console.log('DEBUG: Checking reportPayload before creating notification:'); /* ... */
              // 購読情報取得 & 送信ループ
              const subscriptionsSnapshot = await db.collection('pushSubscriptions').get();
              if (subscriptionsSnapshot.empty) { /* ... */ }
              else { /* ... loop and webpush.sendNotification ... */ }
          } else {
              console.warn('VAPID keys NOT configured correctly, skipping.');
          }

          return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });

      } catch (error) {
          console.error('[POST /api/v1/reports] Error processing report request:', error);
          /* ... specific error checks ... */
          return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
      }

  } else {
      // --- その他のメソッドは許可しない ---
      console.log(`Received unsupported method: ${req.method}`);
      res.setHeader('Allow', ['GET', 'POST']); // AllowヘッダーにGETを追加
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
};