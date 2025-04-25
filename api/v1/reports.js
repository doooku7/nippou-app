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

// ★ Helper function to get month start/end in UTC for a specific year/month ★
function getMonthDateRangeUTC(year, month) { // 引数で年月を受け取る
    // month is 1-based (1 for Jan, 12 for Dec)
    const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)); // month-1 for 0-based index
    const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)); // Next month's 1st day
    // console.log(`[Date Range Helper] For ${year}-${month}: Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`);
    return { startDate, endDate };
}

// Helper function to create a consistent Document ID (変更なし)
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
      // ★★★ GET Handler (Handles Month Selection & API Protection) ★★★
      console.log('[GET /api/v1/reports] Received request');
      try { // Start of main try block for GET

          // ★★★ START: API Protection Logic (変更なし) ★★★
          console.log('[Auth Check] Verifying user token...');
          const authorizationHeader = req.headers.authorization || '';
          if (!authorizationHeader.startsWith('Bearer ')) { return res.status(401).json({ error: '認証トークンが必要です。ログインしてください。' }); }
          const idToken = authorizationHeader.split('Bearer ')[1];
          if (!idToken) { return res.status(401).json({ error: '認証トークンが無効です。' }); }
          try {
              const decodedToken = await admin.auth().verifyIdToken(idToken);
              const userRecord = await admin.auth().getUser(decodedToken.uid);
              if (userRecord.disabled) { return res.status(403).json({ error: 'このアカウントは無効化されています。アクセス権がありません。' }); }
              console.log(`[Auth Check] User ${decodedToken.uid} (${userRecord.email}) is valid and enabled. Proceeding...`);
          } catch (error) {
              console.error('[Auth Check] Token verification or user check failed:', error);
              if (error.code === 'auth/id-token-expired') { return res.status(401).json({ error: '認証トークンの有効期限が切れています。再ログインしてください。' }); }
              else if (error.code === 'auth/user-not-found') { return res.status(401).json({ error: '該当するユーザーが見つかりません。' }); }
              return res.status(401).json({ error: '認証に失敗しました。' });
          }
          // ★★★ END: API Protection Logic ★★★


          // --- If authenticated and authorized, proceed to fetch data ---
          console.log('[Data Fetch] Starting data retrieval...');

          // ★★★ START: Determine Target Year/Month from Query Params ★★★
          const now = new Date();
          let targetYear = now.getUTCFullYear(); // Default to current year
          let targetMonth = now.getUTCMonth() + 1; // Default to current month (1-based)

          // Check for query parameters ?year=YYYY&month=M
          const requestedYear = parseInt(req.query.year, 10);
          const requestedMonth = parseInt(req.query.month, 10);

          if (!isNaN(requestedYear) && requestedYear > 2000 && requestedYear < 2100) {
              targetYear = requestedYear;
          }
          if (!isNaN(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12) {
              targetMonth = requestedMonth;
          }

          const yearMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}`; // Format YYYY-MM
          console.log(`[Data Fetch] Target month for summary & target: ${yearMonth}`);
          // ★★★ END: Determine Target Year/Month ★★★


          // --- Fetch Recent Reports (Keep fetching absolute latest 50 for now) ---
          const limit = 50;
          // ★ report_date の降順（新しい順）に戻す ★
          const recentReportsSnapshot = await db.collection('reports')
                                              .orderBy('report_date', 'desc')
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

          // --- Fetch Pre-calculated Per-Store Monthly Summary for the target month ---
          console.log(`[Data Fetch] Fetching pre-calculated summary for ${yearMonth}...`);
          let storesSummary = {};
          let summaryLastUpdated = null;

          try {
            // ★ Use the determined yearMonth ★
            const summaryDocRef = db.collection("monthlySummaries").doc(yearMonth);
            const summarySnapshot = await summaryDocRef.get();

            if (summarySnapshot.exists) {
                const summaryData = summarySnapshot.data();
                storesSummary = summaryData.stores || {};
                summaryLastUpdated = summaryData.lastUpdated?.toDate ? summaryData.lastUpdated.toDate().toISOString() : null;
                console.log(`[Data Fetch] Found summary document for ${yearMonth}.`);
            } else {
                console.log(`[Data Fetch] No summary document found for ${yearMonth}.`);
            }
          } catch (summaryFetchError) {
              console.error(`[Data Fetch] Error fetching monthly summary for ${yearMonth}:`, summaryFetchError);
          }

          // --- Get Overall Target for the target month --- ★ MODIFIED ★
          let targetMonthTarget = 0;
          // ★ Use targetYear and targetMonth to get the date range ★
          const { startDate: targetStartDate, endDate: targetEndDate } = getMonthDateRangeUTC(targetYear, targetMonth);
          try {
              const latestReportSnapshot = await db.collection('reports')
                                                // ★ Query within the target month ★
                                                .where('createdAt', '>=', targetStartDate)
                                                .where('createdAt', '<', targetEndDate)
                                                .orderBy('createdAt', 'desc')
                                                .limit(1)
                                                .get();
              if (!latestReportSnapshot.empty) {
                  targetMonthTarget = latestReportSnapshot.docs[0].data().monthly_target_amount || 0;
              }
              console.log(`[Data Fetch] Fetched monthly target for ${yearMonth}: ${targetMonthTarget}`);
          } catch (targetFetchError) {
              console.error(`[Data Fetch] Error fetching monthly target for ${yearMonth}:`, targetFetchError);
          }

          console.log('[Data Fetch] Prepared data for response.');

          // Return data for authorized user
          return res.status(200).json({
              recentReports: recentReports,        // Absolute latest reports
              storesSummary: storesSummary,        // Summary for the target month
              overallTarget: targetMonthTarget,    // Target for the target month
              summaryLastUpdated: summaryLastUpdated // Timestamp for the target month's summary
          });

      } catch (error) { // Catch for the main data fetching logic
          console.error('[GET /api/v1/reports] Error during data fetching:', error);
          return res.status(500).json({ error: 'データの取得中にサーバーエラーが発生しました。' });
      }
      // --- End of GET Handler ---

  } else if (req.method === 'POST') {
      // ★★★ POST Handler (Handles Duplicates - No changes needed from previous version) ★★★
      console.log('[POST /api/v1/reports] Received request');
      let vapidKeysConfigured = false;
      try { /* VAPID Setup */ const vSub=process.env.VAPID_SUBJECT,vPub=process.env.VAPID_PUBLIC_KEY,vPri=process.env.VAPID_PRIVATE_KEY; if(vSub&&vPub&&vPri){ try{webpush.setVapidDetails(vSub,vPub,vPri);vapidKeysConfigured=true;console.log('[VAPID] Configured.');}catch(e){console.error('[VAPID] Setup Error:',e);} }else{console.warn('[VAPID] Missing env vars.');} }catch(e){console.error('[VAPID] Env Access Error:',e);} console.log(`[VAPID] Configured: ${vapidKeysConfigured}`);
      const providedApiKey = req.headers['x-api-key']; const expectedApiKey = process.env.EXPECTED_API_KEY; if (!providedApiKey || providedApiKey !== expectedApiKey) { return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }
      try {
          const reportData = req.body;
          if (!reportData || !reportData.report_date || !reportData.store_name) { return res.status(400).json({ error: '必須項目（日付、店舗名など）が不足しています。' }); }
          let documentId;
          try { documentId = createReportId(reportData.report_date, reportData.store_name); } catch (idError) { return res.status(400).json({ error: `日報IDの生成に失敗: ${idError.message}` }); }
          const reportPayload = { report_date: reportData.report_date, store_name: reportData.store_name, sales_amount: Number(reportData.sales_amount) || 0, daily_target_amount: Number(reportData.daily_target_amount) || 0, visitor_count: Number(reportData.visitor_count) || 0, new_customer_count: Number(reportData.new_customer_count) || 0, dye_customer_count: Number(reportData.dye_customer_count) || 0, discount_amount: Number(reportData.discount_amount) || 0, comment: reportData.comment || null, monthly_target_amount: Number(reportData.monthly_target_amount) || 0, createdAt: admin.firestore.FieldValue.serverTimestamp() };
          const docRef = db.collection('reports').doc(documentId);
          await docRef.set(reportPayload);
          console.log('Report document written/overwritten with ID: ', documentId);
          console.log('Attempting to send push notifications...');
          if (vapidKeysConfigured) {
             console.log('VAPID keys configured, proceeding...');
             try { const subs = await db.collection('pushSubscriptions').get(); if(subs.empty){console.log('No subs.');}else{console.log(`Found ${subs.size} subs.`); const payload=JSON.stringify({title:`[${reportPayload.store_name}] 新しい日報`,body:`売上: ${reportPayload.sales_amount.toLocaleString()}円`}); const promises=[]; subs.forEach(doc=>{const sub=doc.data().subscription; if(sub?.endpoint){promises.push(webpush.sendNotification(sub,payload).catch(err=>{console.error(`Push failed ${err.statusCode}`); if(err.statusCode===404||err.statusCode===410){doc.ref.delete();}}));}}); await Promise.allSettled(promises);}} catch(e){console.error('Push Error:',e);}
          } else { console.warn('VAPID keys NOT configured correctly, skipping.'); }
          return res.status(201).json({ message: '日報を受け付けました (同じ日付/店舗の場合は上書きされます)。', reportId: documentId });
       } catch (error) {
          console.error('[POST /api/v1/reports] Error processing report request:', error);
          return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
       }
      // --- End of POST Handler ---
  } else {
      // --- Handle Other Methods ---
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}; // End module.exports
