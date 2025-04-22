// api/v1/reports.js (GET:レポートリスト+月次集計取得 と POST:レポート登録・通知送信)

const admin = require('firebase-admin');
const webpush = require('web-push'); // POST処理で使うため残します

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

// Helper function to get month start/end in UTC (月間目標取得にまだ必要)
function getMonthDateRangeUTC(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-11
    const startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
    // このヘルパー関数のログは頻繁なのでコメントアウトしても良いかもしれません
    // console.log(`[Date Range Helper] Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`);
    return { startDate, endDate };
}


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' });
  }

  // ============ REQUEST METHOD ROUTING ============
  if (req.method === 'GET') {
      // --- Handle GET Request (Fetch Reports + Fetch Pre-calculated Monthly Summary) ---
      console.log('[GET /api/v1/reports] Received request');
      try {
          // --- Fetch Recent Reports (変更なし) ---
          const limit = 50;
          const recentReportsSnapshot = await db.collection('reports')
                                      //.orderBy('report_date', 'asc') // ← report_date の昇順 (古い順) に変更
                                       .orderBy('createdAt', 'desc') // ← createdAtでの並び替えも組み合わせる場合は追加可能
                                      .limit(limit) // limit はそのまま
                                      .get();
          const recentReports = [];
          recentReportsSnapshot.forEach(doc => {
              const data = doc.data();
              // createdAt が Timestamp オブジェクトか確認して変換
              const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || null);
              const report = { id: doc.id, ...data, createdAt: createdAtISO };
              recentReports.push(report);
          });
          console.log(`[GET /api/v1/reports] Fetched ${recentReports.length} recent reports.`);

          // --- Fetch Pre-calculated Monthly Summary ---
          console.log('[GET /api/v1/reports] Fetching pre-calculated monthly summary...');
          let monthlySummary = { // 見つからない場合のデフォルト値
              totalSales: 0, totalVisitors: 0, totalNewCustomers: 0,
              totalDyeCustomers: 0, target: 0, reportCount: 0, lastUpdated: null,
          };
          let yearMonth = ""; // 対象年月 (YYYY-MM)

          try {
            // 現在の年月をYYYY-MM 形式で取得 (UTC基準)
            const now = new Date();
            const year = now.getUTCFullYear();
            const month = (now.getUTCMonth() + 1).toString().padStart(2, '0'); // 月は0-11のため+1し、2桁ゼロ埋め
            yearMonth = `${year}-${month}`;
            console.log(`[GET /api/v1/reports] Target summary document: monthlySummaries/${yearMonth}`);

            // monthlySummaries コレクションから該当月のドキュメントを取得
            const summaryDocRef = db.collection("monthlySummaries").doc(yearMonth);
            const summarySnapshot = await summaryDocRef.get();

            // === この if ブロック内が最終修正された状態 ===
            if (summarySnapshot.exists) {
                // ドキュメントが存在すれば、そのデータを monthlySummary に設定
                const summaryData = summarySnapshot.data();
                // 正しいフィールド名で読み込む
                monthlySummary.totalSales = summaryData.sales_amount ?? 0;
                monthlySummary.totalVisitors = summaryData.visitor_count ?? 0;
                monthlySummary.totalNewCustomers = summaryData.new_customer_count ?? 0;
                // totalDyeCustomers を Number() で確実に数値化する
                monthlySummary.totalDyeCustomers = Number(summaryData.dye_customer_count ?? 0);
                // reportCount を正しく読み込む (より安全な形式で)
                monthlySummary.reportCount = (summaryData && summaryData.reportCount != null) ? summaryData.reportCount : 0;
                // lastUpdated を読み込む
                monthlySummary.lastUpdated = summaryData.lastUpdated?.toDate ? summaryData.lastUpdated.toDate().toISOString() : null;

                console.log(`[GET /api/v1/reports] Found pre-calculated summary data for ${yearMonth}.`);
            } else {
                // ドキュメントが存在しない場合（月の初めなど）はデフォルト値が使われる
                console.log(`[GET /api/v1/reports] No summary document found for ${yearMonth}. Using default values.`);
            }
            // =====================================

          } catch (summaryFetchError) {
              console.error(`[GET /api/v1/reports] Error fetching monthly summary for ${yearMonth}:`, summaryFetchError);
              // 集計データの取得に失敗した場合もデフォルト値を使う（エラー応答はしない）
          }

          // --- Get Target from Latest Report (月間目標は別途取得を維持) ---
          let latestMonthlyTarget = 0;
          const { startDate, endDate } = getMonthDateRangeUTC(new Date()); // ヘルパー関数で今月の範囲を取得
          try {
              const latestReportSnapshot = await db.collection('reports')
                                                .where('createdAt', '>=', startDate)
                                                .where('createdAt', '<', endDate)
                                                .orderBy('createdAt', 'desc')
                                                .limit(1)
                                                .get();
              if (!latestReportSnapshot.empty) {
                  // 最新レポートの monthly_target_amount を取得 (なければ 0)
                  latestMonthlyTarget = latestReportSnapshot.docs[0].data().monthly_target_amount || 0;
              }
              console.log(`[GET /api/v1/reports] Fetched latest monthly target for current month: ${latestMonthlyTarget}`);
          } catch (targetFetchError) {
              console.error('[GET /api/v1/reports] Error fetching latest monthly target:', targetFetchError);
              // 目標取得エラーの場合は target は 0 のままになる
          }
          // 取得した目標値を monthlySummary オブジェクトに設定
          monthlySummary.target = latestMonthlyTarget;

          console.log('[GET /api/v1/reports] Final monthly summary prepared:', monthlySummary);

          // --- Return both recent reports and summary ---
          // recentReports と、上記で準備した monthlySummary を返す
          return res.status(200).json({
              recentReports: recentReports,
              monthlySummary: monthlySummary
          });

      } catch (error) { // GETリクエスト全体の try...catch
          console.error('[GET /api/v1/reports] General error in GET handler:', error);
          return res.status(500).json({ error: 'レポートまたは集計の取得中に予期せぬエラーが発生しました。' });
      }

  } else if (req.method === 'POST') {
      // --- Handle POST Request (変更なし) ---
      console.log('[POST /api/v1/reports] Received request');
      // (元のPOST処理コードはそのまま)
      let vapidKeysConfigured = false;
      console.log('--- VAPID CONFIG START (inside handler) ---'); try { const vapidSubject = process.env.VAPID_SUBJECT; const vapidPublicKey = process.env.VAPID_PUBLIC_KEY; const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY; if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) { console.warn('[VAPID Config] VAPID env vars not fully set inside handler.'); } else { console.log('[VAPID Config] All VAPID env vars present inside handler. Configuring...'); try { webpush.setVapidDetails( vapidSubject, vapidPublicKey, vapidPrivateKey ); console.log('[VAPID Config] webpush.setVapidDetails called successfully inside handler.'); vapidKeysConfigured = true; console.log('[VAPID Config] vapidKeysConfigured flag set to true inside handler.'); } catch (setDetailsError) { console.error('[VAPID Config] Error DIRECTLY from setVapidDetails inside handler:', setDetailsError); } } } catch(e) { console.error("[VAPID Config] Outer catch error inside handler", e); } console.log(`[VAPID Config] Final check inside handler: vapidKeysConfigured = ${vapidKeysConfigured}`); console.log('--- VAPID CONFIG END (inside handler) ---');
      const providedApiKey = req.headers['x-api-key']; const expectedApiKey = process.env.EXPECTED_API_KEY; if (!providedApiKey || providedApiKey !== expectedApiKey) { return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }
      let savedReportId = null;
      try {
          const reportData = req.body; console.log('Received report data:', reportData); if (!reportData || !reportData.report_date /* ... */) { return res.status(400).json({ error: '必須項目が不足しています。' }); }
          const reportPayload = { report_date: reportData.report_date, store_name: reportData.store_name, sales_amount: Number(reportData.sales_amount) || 0, daily_target_amount: Number(reportData.daily_target_amount) || 0, visitor_count: Number(reportData.visitor_count) || 0, new_customer_count: Number(reportData.new_customer_count) || 0, dye_customer_count: Number(reportData.dye_customer_count) || 0, comment: reportData.comment || null, monthly_target_amount: Number(reportData.monthly_target_amount) || 0, createdAt: admin.firestore.FieldValue.serverTimestamp() };
          const docRef = await db.collection('reports').add(reportPayload); savedReportId = docRef.id; console.log('Report document written with ID: ', savedReportId);
          console.log('Attempting to send push notifications...'); if (vapidKeysConfigured) { console.log('VAPID keys configured, proceeding...'); const subscriptionsSnapshot = await db.collection('pushSubscriptions').get(); if (subscriptionsSnapshot.empty) { console.log('No push subscriptions found.'); } else { console.log(`Found ${subscriptionsSnapshot.size} subscriptions...`); const notificationPayload = JSON.stringify({ title: `[${reportPayload.store_name}] 新しい日報`, body: `売上: ${reportPayload.sales_amount.toLocaleString()}円 (日次目標: ${reportPayload.daily_target_amount.toLocaleString()}円)` }); const sendPromises = []; subscriptionsSnapshot.forEach(doc => { const subRecord = doc.data(); if (subRecord.subscription && subRecord.subscription.endpoint) { console.log(`Sending to ${subRecord.subscription.endpoint.substring(0,40)}...`); sendPromises.push(webpush.sendNotification(subRecord.subscription, notificationPayload).catch(err => { console.error(`Failed push to ${subRecord.subscription.endpoint.substring(0,40)} Err: ${err.statusCode}`); if (err.statusCode === 404 || err.statusCode === 410) { console.log(`Deleting sub: ${doc.id}`); return doc.ref.delete(); }})); } else {console.warn(`Invalid sub doc ${doc.id}`);} }); const results = await Promise.allSettled(sendPromises); console.log('Push results:', results.map(r => r.status)); } } else { console.warn('VAPID keys NOT configured correctly, skipping.'); }
          return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });
      } catch (error) {
          console.error('[POST /api/v1/reports] Error processing report request:', error); if (error instanceof TypeError && error.message.includes('toLocaleString')) { return res.status(500).json({ error: `サーバー内部でエラー (toLocaleString): ${error.message}` }); } if (error instanceof SyntaxError && error.message.includes('JSON')) { return res.status(400).json({ error: 'リクエストボディのJSON形式が不正です。' }); } return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
      }

  } else {
      // --- Handle Other Methods (変更なし) ---
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}; // End module.exports