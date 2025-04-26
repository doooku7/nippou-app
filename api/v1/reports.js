// api/v1/reports.js (GET:レポートリスト[月指定]+月次集計取得 と POST:レポート登録・通知送信)

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
}
let db;
try {
    db = admin.firestore();
} catch (dbError) {
    console.error('Failed to get Firestore instance:', dbError);
}

// Helper function to get month start/end in UTC (今回は使用しないが残しておく)
function getMonthDateRangeUTC(year, month) {
    const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    return { startDate, endDate };
}

// Helper function to create a consistent Document ID (変更なし)
function createReportId(reportDateStr, storeName) {
  let formattedDate = 'INVALID_DATE';
  try {
    // YYYY-MM-DD 形式に統一しようとする
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
    return res.status(500).json({ error: 'サーバー設定エラー (DB接続不可)。' });
  }

  // ============ REQUEST METHOD ROUTING ============
  if (req.method === 'GET') {
      // ★★★ GET Handler ★★★
      console.log('[GET /api/v1/reports] Received request');
      try { // Start of main try block for GET

          // ★★★ API Protection Logic (変更なし) ★★★
          console.log('[Auth Check] Verifying user token...');
          // ... (認証コードは省略) ...
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


          console.log('[Data Fetch] Starting data retrieval...');

          // ★★★ Determine Target Year/Month from Query Params (変更なし) ★★★
          const now = new Date();
          let targetYear = now.getUTCFullYear();
          let targetMonth = now.getUTCMonth() + 1;
          const requestedYear = parseInt(req.query.year, 10);
          const requestedMonth = parseInt(req.query.month, 10);
          if (!isNaN(requestedYear) && requestedYear > 2000 && requestedYear < 2100) { targetYear = requestedYear; }
          if (!isNaN(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12) { targetMonth = requestedMonth; }
          const yearMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}`; // YYYY-MM 形式
          console.log(`[Data Fetch] Target month for summary & reports: ${yearMonth}`);


          // === ▼▼▼ START: Fetch Reports using reportYearMonth (★ 修正箇所 ★) ▼▼▼ ===
          console.log(`[Data Fetch] Fetching reports where reportYearMonth == ${yearMonth}`);

          const reportsSnapshot = await db.collection('reports')
                                            // ↓↓↓ reportYearMonth で等式フィルタ ↓↓↓
                                            .where('reportYearMonth', '==', yearMonth)
                                            // ↓↓↓ report_date (文字列) で降順ソート (YYYY-MM-DD形式前提) ↓↓↓
                                            .orderBy('report_date', 'desc')
                                            // .limit(100) // 必要なら制限
                                            .get();

          const reportsForMonth = []; // 変数名変更
          reportsSnapshot.forEach(doc => {
              const data = doc.data();
              const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || null);
              const report = { id: doc.id, ...data, createdAt: createdAtISO };
              reportsForMonth.push(report);
          });
          // JavaScriptでの再ソートは不要

          console.log(`[Data Fetch] Fetched ${reportsForMonth.length} reports for ${yearMonth}.`);
          // === ▲▲▲ END: Fetch Reports (★ 修正箇所 ★) ▲▲▲ ===


          // --- Fetch Pre-calculated Per-Store Monthly Summary (変更なし) ---
          console.log(`[Data Fetch] Fetching pre-calculated summary for ${yearMonth}...`);
          let storesSummary = {};
          let summaryLastUpdated = null;
          try {
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

          // --- Get Overall Target (変更なし - 必要なら見直し) ---
          // このロジックも reportYearMonth でフィルタリングした方が正確になる可能性がある
          let targetMonthTarget = 0;
          try {
              const latestReportSnapshot = await db.collection('reports')
                                                .where('reportYearMonth', '==', yearMonth) // 年月で絞り込み
                                                .orderBy('report_date', 'desc') // その中で最新の日付
                                                .limit(1)
                                                .get();
              if (!latestReportSnapshot.empty) {
                  const latestData = latestReportSnapshot.docs[0].data();
                  if (typeof latestData.monthly_target_amount === 'number') {
                      targetMonthTarget = latestData.monthly_target_amount;
                  }
              }
              console.log(`[Data Fetch] Fetched monthly target for ${yearMonth}: ${targetMonthTarget}`);
          } catch (targetFetchError) {
              console.error(`[Data Fetch] Error fetching monthly target for ${yearMonth}:`, targetFetchError);
          }


          console.log('[Data Fetch] Prepared data for response.');

          // Return data for authorized user
          return res.status(200).json({
              recentReports: reportsForMonth,      // 月で絞り込んだレポートリスト
              storesSummary: storesSummary,        // 指定月の集計
              overallTarget: targetMonthTarget,    // 指定月の目標
              summaryLastUpdated: summaryLastUpdated // 指定月の集計更新日時
          });

      } catch (error) { // Catch for the main data fetching logic
          console.error('[GET /api/v1/reports] Error during data fetching:', error);
          return res.status(500).json({ error: 'データの取得中にサーバーエラーが発生しました。' });
      }
      // --- End of GET Handler ---

  } else if (req.method === 'POST') {
      // ★★★ POST Handler (★ 修正箇所 ★) ★★★
      console.log('[POST /api/v1/reports] Received request');
      // VAPID キー設定確認 (変更なし)
      let vapidKeysConfigured = false; /* ... VAPID設定コード ... */ try{const vSub=process.env.VAPID_SUBJECT,vPub=process.env.VAPID_PUBLIC_KEY,vPri=process.env.VAPID_PRIVATE_KEY;if(vSub&&vPub&&vPri){try{webpush.setVapidDetails(vSub,vPub,vPri);vapidKeysConfigured=true;console.log('[VAPID] Configured.');}catch(e){console.error('[VAPID] Setup Error:',e);}}else{console.warn('[VAPID] Missing env vars.');}}catch(e){console.error('[VAPID] Env Access Error:',e);} console.log(`[VAPID] Configured: ${vapidKeysConfigured}`);
      // APIキー認証 (変更なし)
      const providedApiKey = req.headers['x-api-key']; const expectedApiKey = process.env.EXPECTED_API_KEY; if (!providedApiKey || providedApiKey !== expectedApiKey) { console.warn('[POST Auth] Invalid or missing API Key.'); return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' }); } console.log('[POST Auth] API Key validated.');

      // レポートデータの処理と保存
      try {
          const reportData = req.body;
          if (!reportData || !reportData.report_date || !reportData.store_name) {
              return res.status(400).json({ error: '必須項目（日付、店舗名など）が不足しています。' });
          }

          // ドキュメントID生成 (変更なし)
          let documentId;
          try { documentId = createReportId(reportData.report_date, reportData.store_name); } catch (idError) { return res.status(400).json({ error: `日報IDの生成に失敗: ${idError.message}` }); }

          // === ▼▼▼ reportYearMonth を生成 ▼▼▼ ===
          const reportDateStr = reportData.report_date;
          let reportYearMonth = 'INVALID'; // エラー時のデフォルト値
          try {
              const match = reportDateStr.match(/^(\d{4})\D(\d{2})/); // YYYY と MM を抽出
              if (match) {
                  reportYearMonth = `${match[1]}-${match[2].padStart(2, '0')}`; // YYYY-MM 形式に
              } else {
                  // report_date の形式が不正な場合はエラーログを残す
                  console.error(`Invalid report_date format ("${reportDateStr}") for year-month generation. Setting reportYearMonth to INVALID.`);
                  // エラーレスポンスを返すか、'INVALID' のまま進めるか選択
                  // return res.status(400).json({ error: `Invalid report_date format: ${reportDateStr}` });
              }
          } catch(e) {
              console.error(`Failed to generate reportYearMonth from ${reportDateStr}: ${e.message}`);
              // エラーの場合も 'INVALID' のまま進めるか、エラーレスポンスを返す
          }
          // === ▲▲▲ reportYearMonth を生成 ▲▲▲ ===

          // 保存するペイロードを作成
          const reportPayload = {
              report_date: reportData.report_date, // YYYY/MM/DD or YYYY-MM-DD
              store_name: String(reportData.store_name).trim(),
              sales_amount: Number(reportData.sales_amount) || 0,
              daily_target_amount: Number(reportData.daily_target_amount) || 0,
              visitor_count: Number(reportData.visitor_count) || 0,
              new_customer_count: Number(reportData.new_customer_count) || 0,
              dye_customer_count: Number(reportData.dye_customer_count) || 0,
              discount_amount: Number(reportData.discount_amount) || 0,
              comment: reportData.comment || null,
              monthly_target_amount: Number(reportData.monthly_target_amount) || 0,
              reportYearMonth: reportYearMonth, // ★★★ reportYearMonth を追加 ★★★
              createdAt: admin.firestore.FieldValue.serverTimestamp() // 登録日時
          };

          const docRef = db.collection('reports').doc(documentId);
          await docRef.set(reportPayload); // set で上書き
          console.log('Report document written/overwritten with ID: ', documentId);

          // プッシュ通知送信 (変更なし)
          if (vapidKeysConfigured) { /* ... プッシュ通知コード ... */ console.log('[Push] Attempting to send push notifications...');try{const s=await db.collection('pushSubscriptions').get();if(s.empty){console.log('[Push] No subscriptions found.');}else{console.log(`[Push] Found ${s.size} subscriptions.`);const p=JSON.stringify({title:`[${reportPayload.store_name}] 新しい日報`,body:`売上: ${reportPayload.sales_amount.toLocaleString()}円`});const P=[];s.forEach(d=>{const S=d.data();if(S&&S.subscription&&S.subscription.endpoint){P.push(webpush.sendNotification(S.subscription,p).catch(e=>{console.error(`[Push] Failed to send to ${d.id}. Status: ${e.statusCode}`);if(e.statusCode===404||e.statusCode===410){console.log(`[Push] Deleting invalid subscription: ${d.id}`);return d.ref.delete();}}));}else{console.warn(`[Push] Invalid subscription data found for doc ID: ${d.id}`);}});const R=await Promise.allSettled(P);const SC=R.filter(r=>r.status==='fulfilled').length;const FC=R.length-SC;console.log(`[Push] Notifications sent. Success: ${SC}, Failed/Deleted: ${FC}`);}}catch(e){console.error('[Push] Error fetching subscriptions or sending notifications:',e);}} else { console.warn('[Push] VAPID keys NOT configured correctly, skipping push notifications.'); }

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