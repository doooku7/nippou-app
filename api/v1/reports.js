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
const db = admin.firestore(); // Get DB instance after successful init

// Helper function to get month start/end in UTC for Firestore Timestamps
function getMonthDateRangeUTC(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth(); // 0-11
    const startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)); // 月の初日 (UTC)
    const endDate = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)); // 次の月の初日 (UTC)
    // 日本時間に注意: FirestoreのTimestampはUTC基準ですが、日付での集計は運用に合わせて調整が必要な場合もあります。
    // 今回は createdAt (UTC) で当月かどうかを判定します。
    console.log(`[Date Range] Start: ${startDate.toISOString()}, End: ${endDate.toISOString()}`);
    return { startDate, endDate };
}


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  // --- DB Init Check ---
  if (!db) {
    console.error('Firestore DB instance is not available (reports handler).');
    return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' });
  }

  // ============ REQUEST METHOD ROUTING ============
  if (req.method === 'GET') {
      // --- Handle GET Request (Fetch Reports + Calculate Monthly Summary) ---
      console.log('[GET /api/v1/reports] Received request');
      try {
          // --- Fetch Recent Reports (for list display) ---
          const limit = 50; // 最近のレポート取得件数
          const recentReportsSnapshot = await db.collection('reports')
                                          .orderBy('createdAt', 'desc')
                                          .limit(limit)
                                          .get();
          const recentReports = [];
          recentReportsSnapshot.forEach(doc => {
              const data = doc.data();
              const report = {
                  id: doc.id,
                  ...data,
                  createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : null
              };
              recentReports.push(report);
          });
          console.log(`[GET /api/v1/reports] Fetched ${recentReports.length} recent reports.`);

          // ★★★ Calculate Monthly Summary (for current month) ★★★
          console.log('[GET /api/v1/reports] Calculating monthly summary...');
          const { startDate, endDate } = getMonthDateRangeUTC(); // Get UTC start/end of current month
          const monthlyQuerySnapshot = await db.collection('reports')
                                          .where('createdAt', '>=', startDate)
                                          .where('createdAt', '<', endDate) // '<' endDate で当月のみ
                                          .get();

          let totalSales = 0;
          let totalVisitors = 0;
          let totalNewCustomers = 0;
          let totalDyeCustomers = 0;
          let monthlyTarget = null; // 当月の目標額を格納

          monthlyQuerySnapshot.forEach(doc => {
              const data = doc.data();
              totalSales += data.sales_amount || 0;
              totalVisitors += data.visitor_count || 0;
              totalNewCustomers += data.new_customer_count || 0;
              totalDyeCustomers += data.dye_customer_count || 0;
              // 月間目標額は、その月の最初のレポートから取得する（毎日のレポートに同じ値が入っている想定）
              if (monthlyTarget === null && data.monthly_target_amount !== undefined) {
                  monthlyTarget = data.monthly_target_amount;
              }
          });

          const monthlySummary = {
              totalSales,
              totalVisitors,
              totalNewCustomers,
              totalDyeCustomers,
              target: monthlyTarget ?? 0, // 見つからなければ0
              reportCount: monthlyQuerySnapshot.size // 当月のレポート数
          };
          console.log('[GET /api/v1/reports] Calculated monthly summary:', monthlySummary);
          // ★★★ ここまで集計処理 ★★★

          // --- Return both recent reports and summary ---
          // ★★★ 応答の形を変更 ★★★
          return res.status(200).json({
              recentReports: recentReports, // 最近のレポートリスト
              monthlySummary: monthlySummary // 月間の集計データ
          });

      } catch (error) {
          console.error('[GET /api/v1/reports] Error fetching reports or calculating summary:', error);
          return res.status(500).json({ error: 'レポートまたは集計の取得中にエラーが発生しました。' });
      }

  } else if (req.method === 'POST') {
      // --- Handle POST Request (Submit Report & Send Push) ---
      // ... (POST処理部分は変更なし) ...
      console.log('[POST /api/v1/reports] Received request');
      // (Env Var Check logs...)
      // (VAPID Config logic...)
      // (Auth Check...)
      let savedReportId = null;
      try {
          const reportData = req.body; /* ... */
          if (!reportData || !reportData.report_date /* ... */) { return res.status(400).json({ error: '必須項目が不足しています。' }); }
          const reportPayload = { /* ... */ };
          const docRef = await db.collection('reports').add(reportPayload);
          savedReportId = docRef.id;
          console.log('Report document written with ID: ', savedReportId);
          // (Push Notification Sending logic...)
          return res.status(201).json({ message: '日報を受け付け、通知送信処理を試みました。', reportId: savedReportId });
      } catch (error) {
           console.error('[POST /api/v1/reports] Error processing report request:', error);
           /* ... specific error checks ... */
           return res.status(500).json({ error: `サーバー内部でエラーが発生しました: ${error.message}` });
      }

  } else {
      // --- Handle Other Methods ---
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
};