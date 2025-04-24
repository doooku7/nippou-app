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
    // console.log(`[Date Range Helper] Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`);
    return { startDate, endDate };
}

// Helper function to create a consistent Document ID
function createReportId(reportDateStr, storeName) {
  let formattedDate = 'INVALID_DATE';
  try {
    //<y_bin_46>/MM/DD または<y_bin_46>-MM-DD を解析し、YYYY-MM-DD 形式に統一
    const match = reportDateStr.match(/^(\d{4})\D(\d{2})\D(\d{2})/);
    if (match) {
      formattedDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    } else { throw new Error('Invalid date format for ID generation'); }
  } catch (e) { throw new Error(`Invalid report_date format: ${reportDateStr}`); }
  const sanitizedStoreName = storeName ? String(storeName).replace(/\//g, '_').trim() : '';
  if (!sanitizedStoreName) { throw new Error('Store name is empty or invalid for ID'); }
  const generatedId = `${formattedDate}_${sanitizedStoreName}`;
  return generatedId.substring(0, 500); // 念のため長さを制限
}


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' });
  }

  // ============ REQUEST METHOD ROUTING ============
  if (req.method === 'GET') {
      // ★★★ GET Handler (Reads storesSummary - Includes API Protection) ★★★
      console.log('[GET /api/v1/reports] Received request');
      try { // Start of main try block for GET
          // ★★★ START: API Protection Logic ★★★
          console.log('[Auth Check] Verifying user token...');
          const authorizationHeader = req.headers.authorization || '';
          if (!authorizationHeader.startsWith('Bearer ')) {
              console.error('[Auth Check] No Bearer token provided.');
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
              decodedToken = await admin.auth().verifyIdToken(idToken);
              const uid = decodedToken.uid;
              console.log('[Auth Check] Token verified. UID:', uid);
              userRecord = await admin.auth().getUser(uid);
              if (userRecord.disabled) {
                  console.error(`[Auth Check] User ${uid} is disabled.`);
                  return res.status(403).json({ error: 'このアカウントは無効化されています。アクセス権がありません。' });
              }
              console.log(`[Auth Check] User ${uid} (${userRecord.email}) is valid and enabled. Proceeding...`);
          } catch (error) {
              console.error('[Auth Check] Token verification or user check failed:', error);
              if (error.code === 'auth/id-token-expired') { return res.status(401).json({ error: '認証トークンの有効期限が切れています。再ログインしてください。' }); }
              else if (error.code === 'auth/user-not-found') { return res.status(401).json({ error: '該当するユーザーが見つかりません。' }); }
              return res.status(401).json({ error: '認証に失敗しました。' });
          }
          // ★★★ END: API Protection Logic ★★★

          // --- If authenticated and authorized, proceed to fetch data ---
          console.log('[Data Fetch] Starting data retrieval for authorized user.');
          // Fetch Recent Reports (Sorted by report_date asc)
          const limit = 50;
          const recentReportsSnapshot = await db.collection('reports').orderBy('report_date', 'asc').limit(limit).get();
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
            const summaryDocRef = db.collection("monthlySummaries").doc(yearMonth);
            const summarySnapshot = await summaryDocRef.get();
            if (summarySnapshot.exists) {
                const summaryData = summarySnapshot.data();
                storesSummary = summaryData.stores || {};
                summaryLastUpdated = summaryData.lastUpdated?.toDate ? summaryData.lastUpdated.toDate().toISOString() : null;
            }
          } catch (summaryFetchError) { console.error(`[Data Fetch] Error fetching monthly summary for ${yearMonth}:`, summaryFetchError); }
          // Get Overall Target from Latest Report
          let latestMonthlyTarget = 0;
          const { startDate, endDate } = getMonthDateRangeUTC(new Date());
          try {
              const latestReportSnapshot = await db.collection('reports').where('createdAt', '>=', startDate).where('createdAt', '<', endDate).orderBy('createdAt', 'desc').limit(1).get();
              if (!latestReportSnapshot.empty) { latestMonthlyTarget = latestReportSnapshot.docs[0].data().monthly_target_amount || 0; }
          } catch (targetFetchError) { console.error('[Data Fetch] Error fetching latest monthly target:', targetFetchError); }
          console.log('[Data Fetch] Prepared per-store summary and target.');
          // Return data for authorized user
          return res.status(200).json({ recentReports: recentReports, storesSummary: storesSummary, overallTarget: latestMonthlyTarget, summaryLastUpdated: summaryLastUpdated });
      } catch (error) { // Catch for the main data fetching logic
          console.error('[GET /api/v1/reports] Error during data fetching:', error);
          return res.status(500).json({ error: 'データの取得中にサーバーエラーが発生しました。' });
      }
      // --- End of GET Handler ---

  } else if (req.method === 'POST') {
      // ★★★ Handle POST Request (Ensure VAPID setup is correct) ★★★
      console.log('[POST /api/v1/reports] Received request');

      // ★★★ START: VAPID Key Setup Logic (Ensure this block is present and correct) ★★★
      let vapidKeysConfigured = false;
      try {
          const vapidSubject = process.env.VAPID_SUBJECT;
          const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
          const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
          console.log('[VAPID Check] Subject:', vapidSubject ? 'Found' : 'MISSING');
          console.log('[VAPID Check] Public Key:', vapidPublicKey ? 'Found' : 'MISSING');
          console.log('[VAPID Check] Private Key:', vapidPrivateKey ? 'Found' : 'MISSING');

          if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
              console.warn('[VAPID Config] One or more VAPID environment variables are missing.');
          } else {
              console.log('[VAPID Config] All VAPID environment variables seem present. Configuring web-push...');
              try {
                  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
                  console.log('[VAPID Config] webpush.setVapidDetails called successfully.');
                  vapidKeysConfigured = true; // Set to true ONLY if setVapidDetails succeeds
              } catch (setDetailsError) {
                  console.error('[VAPID Config] Error calling webpush.setVapidDetails:', setDetailsError);
                  // Do not set vapidKeysConfigured to true if this fails
              }
          }
      } catch (e) {
          // Catch potential errors during environment variable access/parsing (less likely here)
          console.error("[VAPID Config] Error accessing VAPID environment variables:", e);
      }
      console.log(`[VAPID Config] Final check: vapidKeysConfigured = ${vapidKeysConfigured}`);
      // ★★★ END: VAPID Key Setup Logic ★★★

      // Auth Check (API Key - Keep existing)
      const providedApiKey = req.headers['x-api-key']; const expectedApiKey = process.env.EXPECTED_API_KEY; if (!providedApiKey || providedApiKey !== expectedApiKey) { return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); }

      try { // Main try block for POST logic
          const reportData = req.body;
          console.log('Received report data:', reportData);

          // Validation
          if (!reportData || !reportData.report_date || !reportData.store_name) {
              return res.status(400).json({ error: '必須項目（日付、店舗名など）が不足しています。' });
          }

          // Generate Document ID
          let documentId;
          try {
              documentId = createReportId(reportData.report_date, reportData.store_name);
              console.log(`Using document ID for reports collection: ${documentId}`);
          } catch (idError) {
              console.error("Error creating document ID:", idError);
              return res.status(400).json({ error: `日報IDの生成に失敗: ${idError.message}` });
          }

          // Prepare Payload
          const reportPayload = {
              report_date: reportData.report_date, store_name: reportData.store_name,
              sales_amount: Number(reportData.sales_amount) || 0,
              daily_target_amount: Number(reportData.daily_target_amount) || 0,
              visitor_count: Number(reportData.visitor_count) || 0,
              new_customer_count: Number(reportData.new_customer_count) || 0,
              dye_customer_count: Number(reportData.dye_customer_count) || 0,
              discount_amount: Number(reportData.discount_amount) || 0,
              comment: reportData.comment || null,
              monthly_target_amount: Number(reportData.monthly_target_amount) || 0,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          };

          // Save to Firestore using set() for overwrite
          const docRef = db.collection('reports').doc(documentId);
          await docRef.set(reportPayload);
          console.log('Report document written/overwritten with ID: ', documentId);

          // ★★★ Push Notification Sending (Check vapidKeysConfigured flag) ★★★
          console.log('Attempting to send push notifications...');
          if (vapidKeysConfigured) { // Check the flag set by the VAPID setup logic above
              console.log('VAPID keys configured, proceeding...');
              try { // Add try-catch around push logic as well
                  const subscriptionsSnapshot = await db.collection('pushSubscriptions').get();
                  if (subscriptionsSnapshot.empty) {
                      console.log('No push subscriptions found.');
                  } else {
                      console.log(`Found ${subscriptionsSnapshot.size} subscriptions...`);
                      const notificationPayload = JSON.stringify({
                          title: `[${reportPayload.store_name}] 新しい日報`,
                          body: `売上: ${reportPayload.sales_amount.toLocaleString()}円 (日次目標: ${reportPayload.daily_target_amount.toLocaleString()}円)`
                      });
                      const sendPromises = [];
                      subscriptionsSnapshot.forEach(doc => {
                          const subRecord = doc.data();
                          if (subRecord.subscription && subRecord.subscription.endpoint) {
                              console.log(`Sending to ${subRecord.subscription.endpoint.substring(0,40)}...`);
                              sendPromises.push(
                                  webpush.sendNotification(subRecord.subscription, notificationPayload)
                                      .catch(err => {
                                          console.error(`Failed push to ${subRecord.subscription.endpoint.substring(0,40)} Err: ${err.statusCode}`);
                                          if (err.statusCode === 404 || err.statusCode === 410) {
                                              console.log(`Deleting invalid/expired subscription: ${doc.id}`);
                                              return doc.ref.delete(); // Attempt to delete invalid subscription
                                          }
                                      })
                              );
                          } else {
                              console.warn(`Invalid subscription document found: ${doc.id}`);
                          }
                      });
                      const results = await Promise.allSettled(sendPromises);
                      console.log('Push notification send results:', results.map(r => r.status));
                  }
              } catch (pushError) {
                  console.error("Error during push notification process:", pushError);
                  // Continue to return success for the report POST even if push fails
              }
          } else {
              // This log should now only appear if VAPID setup actually failed
              console.warn('VAPID keys were NOT configured correctly, skipping push notifications.');
          }

          // Return success response for the POST request
          return res.status(201).json({ message: '日報を受け付けました (同じ日付/店舗の場合は上書きされます)。', reportId: documentId });

      } catch (error) { // Catch for main POST try block
          console.error('[POST /api/v1/reports] Error processing report request:', error);
          return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
      }
      // --- End of POST Handler ---

  } else {
      // --- Handle Other Methods (変更なし) ---
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
}; // End module.exports
