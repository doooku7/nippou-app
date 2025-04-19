// api/v1/reports.js (GET: 月間目標を最新レポートから取得 + POST)

const admin = require('firebase-admin');
const webpush = require('web-push');

// --- Firebase Admin SDK Initialization ---
try { /* ... */ } catch (e) { /* ... */ throw new Error(...); }
const db = admin.firestore();

// Helper function to get month start/end in UTC
function getMonthDateRangeUTC(now = new Date()) { /* ... (変更なし) ... */ }


// --- API Endpoint Logic ---
module.exports = async (req, res) => {
  if (!db) { /* ... */ return res.status(500).json({ error: 'サーバー設定エラー (DB Init Failed)。' }); }

  // ============ REQUEST METHOD ROUTING ============
  if (req.method === 'GET') {
      // --- Handle GET Request (Fetch Reports + Calculate Monthly Summary) ---
      console.log('[GET /api/v1/reports] Received request');
      try {
          // --- Fetch Recent Reports ---
          const limit = 50;
          const recentReportsSnapshot = await db.collection('reports')
                                          .orderBy('createdAt', 'desc')
                                          .limit(limit)
                                          .get();
          const recentReports = [];
          recentReportsSnapshot.forEach(doc => { /* ... (変更なし) ... */ });
          console.log(`[GET /api/v1/reports] Fetched ${recentReports.length} recent reports.`);

          // --- Calculate Monthly Summary ---
          console.log('[GET /api/v1/reports] Calculating monthly summary...');
          const { startDate, endDate } = getMonthDateRangeUTC();
          const monthlyQuerySnapshot = await db.collection('reports')
                                          .where('createdAt', '>=', startDate)
                                          .where('createdAt', '<', endDate)
                                          .get();

          let totalSales = 0;
          let totalVisitors = 0;
          let totalNewCustomers = 0;
          let totalDyeCustomers = 0;
          // let monthlyTarget = null; // ← この行は削除

          monthlyQuerySnapshot.forEach(doc => {
              const data = doc.data();
              totalSales += data.sales_amount || 0;
              totalVisitors += data.visitor_count || 0;
              totalNewCustomers += data.new_customer_count || 0;
              totalDyeCustomers += data.dye_customer_count || 0;
              // ↓ 目標額はここでは集計しない
              // if (monthlyTarget === null && data.monthly_target_amount !== undefined) {
              //     monthlyTarget = data.monthly_target_amount;
              // }
          });

          // ★★★ 当月の最新レポートから月間目標を取得 ★★★
          let latestMonthlyTarget = 0; // デフォルト値
          const latestReportSnapshot = await db.collection('reports')
                                            .where('createdAt', '>=', startDate)
                                            .where('createdAt', '<', endDate)
                                            .orderBy('createdAt', 'desc') // 最新のものを取得
                                            .limit(1) // 1件だけ取得
                                            .get();

          if (!latestReportSnapshot.empty) {
              // 当月のレポートが1件以上あれば、その最新のレポートから目標額を取得
              latestMonthlyTarget = latestReportSnapshot.docs[0].data().monthly_target_amount || 0;
          }
          console.log(`[GET /api/v1/reports] Found latest monthly target for current month: ${latestMonthlyTarget}`);
          // ★★★ ここまで追加・修正 ★★★

          const monthlySummary = {
              totalSales,
              totalVisitors,
              totalNewCustomers,
              totalDyeCustomers,
              target: latestMonthlyTarget, // ★ 取得した最新の目標額を使う
              reportCount: monthlyQuerySnapshot.size
          };
          console.log('[GET /api/v1/reports] Calculated monthly summary:', monthlySummary);

          // --- Return both recent reports and summary ---
          return res.status(200).json({
              recentReports: recentReports,
              monthlySummary: monthlySummary
          });

      } catch (error) {
          console.error('[GET /api/v1/reports] Error fetching reports or calculating summary:', error);
          return res.status(500).json({ error: 'レポートまたは集計の取得中にエラーが発生しました。' });
      }

  } else if (req.method === 'POST') {
      // --- Handle POST Request (変更なし) ---
      // ... (POST処理部分はそのまま) ...

  } else {
      // --- Handle Other Methods (変更なし) ---
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
};