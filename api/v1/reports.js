// api/v1/reports.js (GET:レポートリスト+月次集計取得 と POST:レポート登録・通知送信)

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
const db = admin.firestore();

// Helper function to get month start/end in UTC
function getMonthDateRangeUTC(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
    return { startDate, endDate };
}

// Helper function to create a consistent Document ID
function createReportId(reportDateStr, storeName) {
  let formattedDate = 'INVALID_DATE';
  try {
    const match = reportDateStr.match(/^(\d{4})\D(\d{2})\D(\d{2})/);
    if (match) {
      formattedDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    } else { throw new Error('Invalid date format for ID generation'); }
  } catch (e) { throw new Error(`Invalid report_date format: ${reportDateStr}`); }
  const sanitizedStoreName = storeName ? String(storeName).replace(/\//g, '_').trim() : '';
  if (!sanitizedStoreName) { throw new Error('Store name is empty or invalid for ID'); }
  const generatedId = `${formattedDate}_${sanitizedStoreName}`;
  return generatedId.substring(0, 500);
}


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' });
  }

  // ============ REQUEST METHOD ROUTING ============
  if (req.method === 'GET') {
      // ★★★ GET Handler with API Protection ★★★
      console.log('[GET /api/v1/reports] Received request');
      try { // Start of main try block for GET

          // ★★★ START: API Protection Logic ★★★
          console.log('[Auth Check] Verifying user token...');
          const authorizationHeader = req.headers.authorization || '';
          if (!authorizationHeader.startsWith('Bearer ')) {
              console.error('[Auth Check] No Bearer token provided.');
              // 401 Unauthorized - Correct status for missing credentials
              return res.status(401).json({ error: '認証トークンが必要です。ログインしてください。' });
          }

          const idToken = authorizationHeader.split('Bearer ')[1];
          if (!idToken) {
              console.error('[Auth Check] Bearer token is empty.');
              return res.status(401).json({ error: '認証トークンが無効です。' });
          }

          let decodedToken;
          let userRecord;
          try {
              // Verify the ID token using Firebase Admin SDK
              decodedToken = await admin.auth().verifyIdToken(idToken);
              const uid = decodedToken.uid;
              console.log('[Auth Check] Token verified. UID:', uid);

              // Check if the user account associated with the token is disabled
              userRecord = await admin.auth().getUser(uid);
              if (userRecord.disabled) {
                  console.error(`[Auth Check] User ${uid} is disabled.`);
                  // 403 Forbidden - Authenticated but not authorized
                  return res.status(403).json({ error: 'このアカウントは無効化されています。アクセス権がありません。' });
              }

              console.log(`[Auth Check] User ${uid} (${userRecord.email}) is valid and enabled. Proceeding...`);
              // If verification and enabled check pass, continue to the main API logic below

          } catch (error) {
              console.error('[Auth Check] Token verification or user check failed:', error);
              // Handle specific auth errors (e.g., expired token)
              if (error.code === 'auth/id-token-expired') {
                   return res.status(401).json({ error: '認証トークンの有効期限が切れています。再ログインしてください。' });
              } else if (error.code === 'auth/user-not-found') {
                   // This case might happen if the user was deleted after token was issued
                   return res.status(401).json({ error: '該当するユーザーが見つかりません。' });
              }
              // General authentication failure
              return res.status(401).json({ error: '認証に失敗しました。' });
          }
          // ★★★ END: API Protection Logic ★★★


          // --- If authenticated and authorized, proceed to fetch data ---
          console.log('[Data Fetch] Starting data retrieval for authorized user.');

          // Fetch Recent Reports (Sorted by report_date asc)
          const limit = 50;
          const recentReportsSnapshot = await db.collection('reports')
                                              .orderBy('report_date', 'asc')
                                              .limit(limit)
                                              .get();
          const recentReports = [];
          recentReportsSnapshot.forEach(doc => {
              const data = doc.data();
              const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || null);
              const report = { id: doc.id, ...data, createdAt: createdAtISO };
              recentReports.push(report);
          });
          console.log(`[Data Fetch] Fetched ${recentReports.length} recent reports.`);

          // Fetch Pre-calculated Per-Store Monthly Summary
          console.log('[Data Fetch] Fetching pre-calculated per-store monthly summary...');
          let storesSummary = {};
          let summaryLastUpdated = null;
          let yearMonth = "";

          try {
            const now = new Date();
            const year = now.getUTCFullYear();
            const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');
            yearMonth = `${year}-${month}`;
            console.log(`[Data Fetch] Target summary document: monthlySummaries/${yearMonth}`);

            const summaryDocRef = db.collection("monthlySummaries").doc(yearMonth);
            const summarySnapshot = await summaryDocRef.get();

            if (summarySnapshot.exists) {
                const summaryData = summarySnapshot.data();
                storesSummary = summaryData.stores || {};
                summaryLastUpdated = summaryData.lastUpdated?.toDate ? summaryData.lastUpdated.toDate().toISOString() : null;
                console.log(`[Data Fetch] Found summary document for ${yearMonth}. Stores count: ${Object.keys(storesSummary).length}`);
            } else {
                console.log(`[Data Fetch] No summary document found for ${yearMonth}.`);
            }
          } catch (summaryFetchError) {
              console.error(`[Data Fetch] Error fetching monthly summary for ${yearMonth}:`, summaryFetchError);
          }

          // Get Overall Target from Latest Report
          let latestMonthlyTarget = 0;
          const { startDate, endDate } = getMonthDateRangeUTC(new Date());
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
              console.log(`[Data Fetch] Fetched latest monthly target: ${latestMonthlyTarget}`);
          } catch (targetFetchError) {
              console.error('[Data Fetch] Error fetching latest monthly target:', targetFetchError);
          }

          console.log('[Data Fetch] Prepared per-store summary and target.');

          // Return data for authorized user
          return res.status(200).json({
              recentReports: recentReports,
              storesSummary: storesSummary,
              overallTarget: latestMonthlyTarget,
              summaryLastUpdated: summaryLastUpdated
          });

      } catch (error) { // Catch for the main data fetching logic
          console.error('[GET /api/v1/reports] Error during data fetching:', error);
          // Return a generic server error if something unexpected happens after auth
          return res.status(500).json({ error: 'データの取得中にサーバーエラーが発生しました。' });
      }
      // --- End of GET Handler ---

  } else if (req.method === 'POST') {
      // --- POST Handler (Handles Duplicates - No Auth change needed for now) ---
      // ... (Keep existing POST logic from #115) ...
      console.log('[POST /api/v1/reports] Received request');
      let vapidKeysConfigured = false; /* ... VAPID setup ... */
      const providedApiKey = req.headers['x-api-key']; const expectedApiKey = process.env.EXPECTED_API_KEY; if (!providedApiKey || providedApiKey !== expectedApiKey) { return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }
      try {
          const reportData = req.body;
          if (!reportData || !reportData.report_date || !reportData.store_name) { return res.status(400).json({ error: '必須項目（日付、店舗名など）が不足しています。' }); }
          let documentId;
          try { documentId = createReportId(reportData.report_date, reportData.store_name); console.log(`Using document ID for reports collection: ${documentId}`); } catch (idError) { return res.status(400).json({ error: `日報IDの生成に失敗: ${idError.message}` }); }
          const reportPayload = { report_date: reportData.report_date, store_name: reportData.store_name, sales_amount: Number(reportData.sales_amount) || 0, daily_target_amount: Number(reportData.daily_target_amount) || 0, visitor_count: Number(reportData.visitor_count) || 0, new_customer_count: Number(reportData.new_customer_count) || 0, dye_customer_count: Number(reportData.dye_customer_count) || 0, discount_amount: Number(reportData.discount_amount) || 0, comment: reportData.comment || null, monthly_target_amount: Number(reportData.monthly_target_amount) || 0, createdAt: admin.firestore.FieldValue.serverTimestamp() };
          const docRef = db.collection('reports').doc(documentId);
          await docRef.set(reportPayload);
          console.log('Report document written/overwritten with ID: ', documentId);
          /* ... Push notification logic ... */
          if (vapidKeysConfigured) { const subscriptionsSnapshot = await db.collection('pushSubscriptions').get(); if (!subscriptionsSnapshot.empty) { console.log(`Found ${subscriptionsSnapshot.size} subscriptions...`); const notificationPayload = JSON.stringify({ title: `[${reportPayload.store_name}] 新しい日報`, body: `売上: ${reportPayload.sales_amount.toLocaleString()}円 (日次目標: ${reportPayload.daily_target_amount.toLocaleString()}円)` }); const sendPromises = []; subscriptionsSnapshot.forEach(doc => { const subRecord = doc.data(); if (subRecord.subscription && subRecord.subscription.endpoint) { sendPromises.push(webpush.sendNotification(subRecord.subscription, notificationPayload).catch(err => { console.error(`Failed push ... Err: ${err.statusCode}`); if (err.statusCode === 404 || err.statusCode === 410) { return doc.ref.delete(); }})); } else {console.warn(`Invalid sub doc ${doc.id}`);} }); const results = await Promise.allSettled(sendPromises); console.log('Push results:', results.map(r => r.status)); } } else { console.warn('VAPID keys NOT configured correctly, skipping.'); }
          return res.status(201).json({ message: '日報を受け付けました (同じ日付/店舗の場合は上書きされます)。', reportId: documentId });
       } catch (error) {
          console.error('[POST /api/v1/reports] Error processing report request:', error);
          return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
       }
  } else {
      // --- Handle Other Methods ---
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}; // End module.exports