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
      // --- Handle GET Request (Fetch Reports + Fetch Per-Store Monthly Summary) --- // Modified description
      console.log('[GET /api/v1/reports] Received request');
      try {
          // --- Fetch Recent Reports (Sorted by report_date asc) ---
          const limit = 50;
          const recentReportsSnapshot = await db.collection('reports')
                                              .orderBy('report_date', 'asc') // Keep date sort
                                          // .orderBy('createdAt', 'desc')
                                              .limit(limit)
                                              .get();
          const recentReports = [];
          recentReportsSnapshot.forEach(doc => {
              const data = doc.data();
              const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || null);
              const report = { id: doc.id, ...data, createdAt: createdAtISO };
              recentReports.push(report);
          });
          console.log(`[GET /api/v1/reports] Fetched ${recentReports.length} recent reports.`);

          // --- Fetch Pre-calculated Per-Store Monthly Summary --- // <<< REPLACEMENT START >>>
          console.log('[GET /api/v1/reports] Fetching pre-calculated per-store monthly summary...');
          let storesSummary = {}; // Default to empty object for the stores map
          let summaryLastUpdated = null;
          let yearMonth = ""; // Target YYYY-MM

          try {
            // Get current month in YYYY-MM format (UTC)
            const now = new Date();
            const year = now.getUTCFullYear();
            const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
            yearMonth = `${year}-${month}`;
            console.log(`[GET /api/v1/reports] Target summary document: monthlySummaries/${yearMonth}`);

            const summaryDocRef = db.collection("monthlySummaries").doc(yearMonth);
            const summarySnapshot = await summaryDocRef.get();

            if (summarySnapshot.exists) {
                const summaryData = summarySnapshot.data();
                storesSummary = summaryData.stores || {}; // Get the 'stores' map itself
                summaryLastUpdated = summaryData.lastUpdated?.toDate ? summaryData.lastUpdated.toDate().toISOString() : null; // Get the timestamp
                console.log(`[GET /api/v1/reports] Found summary document for ${yearMonth}. Stores count: ${Object.keys(storesSummary).length}`);
            } else {
                console.log(`[GET /api/v1/reports] No summary document found for ${yearMonth}. Returning empty stores summary.`);
            }
          } catch (summaryFetchError) {
              console.error(`[GET /api/v1/reports] Error fetching monthly summary for ${yearMonth}:`, summaryFetchError);
              // Keep storesSummary as empty object on error
          }

          // --- Get Overall Target from Latest Report (Keep this logic) ---
          let latestMonthlyTarget = 0;
          const { startDate, endDate } = getMonthDateRangeUTC(new Date()); // Get range for current month
          try {
              const latestReportSnapshot = await db.collection('reports')
                                                .where('createdAt', '>=', startDate)
                                                .where('createdAt', '<', endDate)
                                                .orderBy('createdAt', 'desc')
                                                .limit(1)
                                                .get();
              if (!latestReportSnapshot.empty) {
                  latestMonthlyTarget = latestReportSnapshot.docs[0].data().monthly_target_amount || 0;
              }
              console.log(`[GET /api/v1/reports] Fetched latest monthly target: ${latestMonthlyTarget}`);
          } catch (targetFetchError) {
              console.error('[GET /api/v1/reports] Error fetching latest monthly target:', targetFetchError);
          }
          // Note: Overall target is fetched, but individual store targets aren't handled here

          console.log('[GET /api/v1/reports] Prepared per-store summary and target.');
          // <<< REPLACEMENT END >>>

          // --- Return recent reports and the new summary structure ---
          return res.status(200).json({
              recentReports: recentReports,
              storesSummary: storesSummary,         // Return the map of stores
              overallTarget: latestMonthlyTarget,   // Return the overall target
              summaryLastUpdated: summaryLastUpdated // Return the summary timestamp
          });

      } catch (error) { // GET request's main try...catch
          console.error('[GET /api/v1/reports] General error in GET handler:', error);
          return res.status(500).json({ error: 'レポートまたは集計の取得中に予期せぬエラーが発生しました。' });
      }
  } // <<< End of GET handler block >>>
   else if (req.method === 'POST') {
      // --- Handle POST Request (No changes needed here) ---
      console.log('[POST /api/v1/reports] Received request');
      // (Keep existing POST logic)
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