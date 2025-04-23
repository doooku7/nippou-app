// Cloud Functions for Firebase SDK を読み込む
const functions = require("firebase-functions/v1"); // v1を使うことを明示
// Firebase Admin SDK を読み込む（Firestoreへのアクセス等に必要）
const admin = require("firebase-admin");

// Firebase Admin SDK を初期化する
admin.initializeApp();

// Firestoreの参照を取得
const db = admin.firestore();

/**
 * reportsコレクションのドキュメントが作成・更新・削除されたときに実行される関数
 * ドキュメントパス: reports/{reportId}
 * ※店舗別の月次集計を monthlySummaries/{YYYY-MM} ドキュメント内の stores マップに書き込むように変更
 * ※※※ デバッグ用にログ出力を強化 ※※※
 */
exports.updateMonthlySummary = functions
  .region("asia-northeast1") // 東京リージョンを指定
  .firestore.document("reports/{reportId}")
  .onWrite(async (change, context) => {
    const reportId = context.params.reportId;
    console.log(`---------- Function Start: Report ${reportId} Changed ----------`); // ログ開始

    // 1. イベントタイプとデータを取得
    const dataBefore = change.before.exists ? change.before.data() : null;
    const dataAfter = change.after.exists ? change.after.data() : null;
    console.log("Data Before:", dataBefore); // ★ログ追加
    console.log("Data After:", dataAfter);   // ★ログ追加

    let eventType;
    if (!dataBefore && dataAfter) {
      eventType = "CREATE";
    } else if (dataBefore && dataAfter) {
      eventType = "UPDATE";
    } else if (dataBefore && !dataAfter) {
      eventType = "DELETE";
    } else {
      console.log("Unknown event type or no data change relevant to summary.");
      return null;
    }
    console.log(`Event type: ${eventType}`);

    // 集計に必要なデータと店舗名を取得
    const reportData = eventType === "DELETE" ? dataBefore : dataAfter;
    if (!reportData) {
      console.error("Report data for calculation is missing. Aborting."); // ★ログ修正
      return null;
    }
    console.log("Report Data used for calculation:", reportData); // ★ログ追加

    // ★ store_name を取得 ★
    const storeName = reportData.store_name;
    if (!storeName || typeof storeName !== "string" || storeName.trim() === "") {
      console.error("store_name field is invalid:", storeName, ". Aborting."); // ★ログ修正
      return null;
    }
    console.log(`Store name: ${storeName}`);

    // 2. 対象月 (YYYY-MM) を特定
    const reportDateStr = reportData.report_date;
    if (!reportDateStr || typeof reportDateStr !== "string") {
      console.error("report_date field is invalid:", reportDateStr, ". Aborting."); // ★ログ修正
      return null;
    }

    let yearMonth;
    try {
      const match = reportDateStr.match(/^(\d{4})[-\/](\d{2})[-\/]\d{2}$/);
      if (!match) {
        throw new Error(`Date format "${reportDateStr}" is not YYYY/MM/DD or YYYY-MM-DD`); // ★エラーメッセージ修正
      }
      yearMonth = `${match[1]}-${match[2]}`; // "YYYY-MM"
      console.log(`Target month (YYYY-MM): ${yearMonth}`);
    } catch (error) {
      console.error("Failed to parse report_date:", reportDateStr, error);
      return null;
    }

    // 3. Firestoreトランザクションを開始して店舗別集計を更新
    const summaryDocRef = db.collection("monthlySummaries").doc(yearMonth);
    try {
      await db.runTransaction(async (transaction) => {
        console.log(`--- Transaction Start for ${storeName} in ${yearMonth} ---`); // ★ログ追加
        const summarySnapshot = await transaction.get(summaryDocRef);
        const currentDocData = summarySnapshot.exists ? summarySnapshot.data() : {};
        const currentStoresData = currentDocData.stores || {};
        const currentStoreSummary = currentStoresData[storeName] || {};

        console.log("Current Doc Data:", JSON.stringify(currentDocData)); // ★ログ追加
        console.log("Current Store Summary:", JSON.stringify(currentStoreSummary)); // ★ログ追加

        const fieldsToAggregate = [
          "sales_amount", "visitor_count",
          "new_customer_count", "dye_customer_count",
        ];
        const newStoreSummary = {};
        let reportCountDelta = 0;

        fieldsToAggregate.forEach((field) => {
          console.log(`Processing field: ${field}`);
          const valueBefore = (dataBefore && dataBefore[field] != null) ? dataBefore[field] : 0;
          const valueAfter = (dataAfter && dataAfter[field] != null) ? dataAfter[field] : 0;
          console.log(`  Value Before: ${valueBefore} (Type: ${typeof valueBefore}), Value After: ${valueAfter} (Type: ${typeof valueAfter})`); // ★ログ追加 (型も確認)

          let delta = 0;
          if (eventType === "CREATE") {
            delta = valueAfter;
          } else if (eventType === "DELETE") {
            delta = -valueBefore;
          } else if (eventType === "UPDATE") {
            delta = valueAfter - valueBefore;
          }
          console.log(`  Calculated Delta: ${delta}`);

          const currentStoreTotal = currentStoreSummary[field] ?? 0;
          console.log(`  Current Store Total for ${field}: ${currentStoreTotal}`);
          // ★ 計算結果が数値であることを確認・保証（念のため） ★
          const newValue = Number(currentStoreTotal) + Number(delta);
          newStoreSummary[field] = isNaN(newValue) ? 0 : newValue; // NaNになったら0にする
          console.log(`  New Store Total for ${field}: ${newStoreSummary[field]}`);
        });

        if (eventType === "CREATE") {
          reportCountDelta = 1;
        } else if (eventType === "DELETE") {
          reportCountDelta = -1;
        }
        const currentStoreReportCount = currentStoreSummary.reportCount ?? 0;
        console.log(`Current Store Report Count: ${currentStoreReportCount}, Delta: ${reportCountDelta}`);
        // ★ 計算結果が数値であることを確認・保証（念のため） ★
        const newReportCountValue = Number(currentStoreReportCount) + Number(reportCountDelta);
        newStoreSummary.reportCount = isNaN(newReportCountValue) ? 0 : newReportCountValue; // NaNになったら0にする
        console.log(`New Store Report Count: ${newStoreSummary.reportCount}`);

        const finalDocData = {
            stores: {
                ...currentStoresData,
                [storeName]: newStoreSummary
            },
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        };

        console.log("Final object to write (stores part):", JSON.stringify(finalDocData.stores)); // ★ログ追加
        console.log("--- Transaction Set ---");
        transaction.set(summaryDocRef, finalDocData, { merge: true });
      });
      console.log(`Transaction successfully committed for store "${storeName}" in ${yearMonth}.`);
    } catch (error) {
      console.error(`Transaction failed for store "${storeName}" in ${yearMonth}:`, error);
    }
    console.log(`---------- Function End: Report ${reportId} ----------`); // ログ終了
    return null;
  });