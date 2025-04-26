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
  // 初期化失敗時はここで処理を中断させるか、db が null であることを確認してハンドラ側でエラーを返す
  // throw new Error(`Firebase Admin SDK Initialization Failed: ${e.message}`); // ここで投げるとサーバー起動失敗の可能性
}
// DBインスタンス取得は try-catch の後で行うのが安全
let db;
try {
    db = admin.firestore();
} catch (dbError) {
    console.error('Failed to get Firestore instance:', dbError);
    // db が null のままでも、ハンドラ側でチェックする
}

// Helper function to get month start/end in UTC for a specific year/month
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
  return generatedId.substring(0, 500); // Firestore ID 長制限考慮
}


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  // DBインスタンスが利用可能かチェック
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB接続不可)。' });
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

          // ★★★ START: Determine Target Year/Month from Query Params (変更なし) ★★★
          const now = new Date();
          let targetYear = now.getUTCFullYear(); // Default to current year
          let targetMonth = now.getUTCMonth() + 1; // Default to current month (1-based)

          const requestedYear = parseInt(req.query.year, 10);
          const requestedMonth = parseInt(req.query.month, 10);

          if (!isNaN(requestedYear) && requestedYear > 2000 && requestedYear < 2100) {
              targetYear = requestedYear;
          }
          if (!isNaN(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12) {
              targetMonth = requestedMonth;
          }

          const yearMonth = `${targetYear}-${String(targetMonth).padStart(2, '0')}`; // Format YYYY-MM
          console.log(`[Data Fetch] Target month for summary & reports: ${yearMonth}`);
          // ★★★ END: Determine Target Year/Month ★★★


          // === ▼▼▼ START: Fetch Reports for the target month (★ 修正箇所 ★) ▼▼▼ ===
          const { startDate: reportStartDate, endDate: reportEndDate } = getMonthDateRangeUTC(targetYear, targetMonth); // 対象年月の開始日・終了日を取得
          console.log(`[Data Fetch] Fetching reports between ${reportStartDate.toISOString()} and ${reportEndDate.toISOString()}`);

          const reportsSnapshot = await db.collection('reports')
                                            // ↓↓↓ createdAt で対象月の範囲を指定 ↓↓↓
                                            .where('createdAt', '>=', reportStartDate)
                                            .where('createdAt', '<', reportEndDate)
                                            // ↓↓↓ 範囲指定と組み合わせるため、一旦 createdAt で並び替え ↓↓↓
                                            .orderBy('createdAt', 'desc')
                                            // .limit(100) // 月ごとの取得件数制限が必要な場合
                                            .get();

          const reportsForMonth = []; // 変数名を変更
          reportsSnapshot.forEach(doc => {
              const data = doc.data();
              const createdAtISO = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (data.createdAt || null);
              const report = { id: doc.id, ...data, createdAt: createdAtISO };
              reportsForMonth.push(report);
          });

          // ↓↓↓ Firestoreの制約上 createdAt でソートしたので、必要ならJSで report_date で再ソート ↓↓↓
          reportsForMonth.sort((a, b) => {
              try {
                  // report_date が null や undefined の場合も考慮
                  const dateStrA = String(a.report_date || '').replace(/\//g, '-');
                  const dateStrB = String(b.report_date || '').replace(/\//g, '-');
                  if (!dateStrA || !dateStrB) return 0; // 無効な日付文字列は順序変更しない

                  const dateA = new Date(dateStrA);
                  const dateB = new Date(dateStrB);
                  // 無効な日付オブジェクトの場合も考慮
                  if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) return 0;
                  return dateB - dateA; // 新しい順 (降順)
              } catch (e) {
                  console.error("Error sorting reports by report_date:", e);
                  return 0; // エラー時も順序変更しない
              }
          });

          console.log(`[Data Fetch] Fetched ${reportsForMonth.length} reports for ${yearMonth}.`);
          // === ▲▲▲ END: Fetch Reports for the target month (★ 修正箇所 ★) ▲▲▲ ===


          // --- Fetch Pre-calculated Per-Store Monthly Summary for the target month (変更なし) ---
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
              // エラーが発生しても処理を続行し、空の集計を返す
          }


          // --- Get Overall Target for the target month (★ ロジック確認推奨 ★) ---
          // 現在の実装: 指定月の範囲内の最新レポートから monthly_target_amount を取得
          let targetMonthTarget = 0;
          try {
              // startDate, endDate は上で定義済み
              const latestReportSnapshot = await db.collection('reports')
                                                .where('createdAt', '>=', reportStartDate) // 対象月内
                                                .where('createdAt', '<', reportEndDate)
                                                .orderBy('createdAt', 'desc') // その中で最新
                                                .limit(1)
                                                .get();
              if (!latestReportSnapshot.empty) {
                  const latestData = latestReportSnapshot.docs[0].data();
                  // monthly_target_amount が数値であることを確認
                  if (typeof latestData.monthly_target_amount === 'number') {
                      targetMonthTarget = latestData.monthly_target_amount;
                  }
              }
              console.log(`[Data Fetch] Fetched monthly target for ${yearMonth}: ${targetMonthTarget}`);
          } catch (targetFetchError) {
              console.error(`[Data Fetch] Error fetching monthly target for ${yearMonth}:`, targetFetchError);
              // エラーが発生しても処理を続行し、目標 0 を返す
          }


          console.log('[Data Fetch] Prepared data for response.');

          // Return data for authorized user
          return res.status(200).json({
              // ↓↓↓ 月で絞り込んだ結果を返すように変更 ↓↓↓
              recentReports: reportsForMonth,
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
      // ★★★ POST Handler (変更なし) ★★★
      console.log('[POST /api/v1/reports] Received request');
      // VAPID キー設定の確認
      let vapidKeysConfigured = false;
      try {
          const vSub = process.env.VAPID_SUBJECT;
          const vPub = process.env.VAPID_PUBLIC_KEY;
          const vPri = process.env.VAPID_PRIVATE_KEY;
          if (vSub && vPub && vPri) {
              try {
                  webpush.setVapidDetails(vSub, vPub, vPri);
                  vapidKeysConfigured = true;
                  console.log('[VAPID] Configured.');
              } catch (e) {
                  console.error('[VAPID] Setup Error:', e);
              }
          } else {
              console.warn('[VAPID] Missing env vars.');
          }
      } catch (e) {
          console.error('[VAPID] Env Access Error:', e);
      }
      console.log(`[VAPID] Configured: ${vapidKeysConfigured}`);

      // APIキー認証
      const providedApiKey = req.headers['x-api-key'];
      const expectedApiKey = process.env.EXPECTED_API_KEY;
      if (!providedApiKey || providedApiKey !== expectedApiKey) {
          console.warn('[POST Auth] Invalid or missing API Key.');
          return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' });
      }
      console.log('[POST Auth] API Key validated.');

      // レポートデータの処理と保存
      try {
          const reportData = req.body;
          if (!reportData || !reportData.report_date || !reportData.store_name) {
              return res.status(400).json({ error: '必須項目（日付、店舗名など）が不足しています。' });
          }

          let documentId;
          try {
              documentId = createReportId(reportData.report_date, reportData.store_name);
          } catch (idError) {
              return res.status(400).json({ error: `日報IDの生成に失敗: ${idError.message}` });
          }

          // 保存するペイロードを作成 (数値変換とデフォルト値設定)
          const reportPayload = {
              report_date: reportData.report_date,
              store_name: String(reportData.store_name).trim(),
              sales_amount: Number(reportData.sales_amount) || 0,
              daily_target_amount: Number(reportData.daily_target_amount) || 0,
              visitor_count: Number(reportData.visitor_count) || 0,
              new_customer_count: Number(reportData.new_customer_count) || 0,
              dye_customer_count: Number(reportData.dye_customer_count) || 0,
              discount_amount: Number(reportData.discount_amount) || 0,
              comment: reportData.comment || null, // null許容
              monthly_target_amount: Number(reportData.monthly_target_amount) || 0,
              createdAt: admin.firestore.FieldValue.serverTimestamp() // 登録日時
          };

          const docRef = db.collection('reports').doc(documentId);
          await docRef.set(reportPayload); // set で上書きを許可
          console.log('Report document written/overwritten with ID: ', documentId);

          // プッシュ通知の送信試行
          if (vapidKeysConfigured) {
             console.log('[Push] Attempting to send push notifications...');
             try {
                 const subsSnapshot = await db.collection('pushSubscriptions').get();
                 if (subsSnapshot.empty) {
                     console.log('[Push] No subscriptions found.');
                 } else {
                     console.log(`[Push] Found ${subsSnapshot.size} subscriptions.`);
                     const payload = JSON.stringify({
                         title: `[${reportPayload.store_name}] 新しい日報`,
                         body: `売上: ${reportPayload.sales_amount.toLocaleString()}円`
                         // icon: '/path/to/icon.png' // アイコンパスなど追加可能
                     });
                     const pushPromises = [];
                     subsSnapshot.forEach(doc => {
                         const subData = doc.data();
                         if (subData && subData.subscription && subData.subscription.endpoint) {
                             pushPromises.push(
                                 webpush.sendNotification(subData.subscription, payload)
                                     .catch(err => {
                                         console.error(`[Push] Failed to send to ${doc.id}. Status: ${err.statusCode}`);
                                         // 無効なサブスクリプションを削除
                                         if (err.statusCode === 404 || err.statusCode === 410) {
                                             console.log(`[Push] Deleting invalid subscription: ${doc.id}`);
                                             return doc.ref.delete();
                                         }
                                     })
                             );
                         } else {
                             console.warn(`[Push] Invalid subscription data found for doc ID: ${doc.id}`);
                         }
                     });
                     const results = await Promise.allSettled(pushPromises);
                     const successCount = results.filter(r => r.status === 'fulfilled').length;
                     const failedCount = results.length - successCount;
                     console.log(`[Push] Notifications sent. Success: ${successCount}, Failed/Deleted: ${failedCount}`);
                 }
             } catch (pushDbError) {
                 console.error('[Push] Error fetching subscriptions or sending notifications:', pushDbError);
             }
          } else {
             console.warn('[Push] VAPID keys NOT configured correctly, skipping push notifications.');
          }

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