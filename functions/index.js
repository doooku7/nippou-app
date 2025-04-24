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
 * ※店舗別の月次集計に daily_target_amount 合計と monthly_target_amount, discount_amount 合計を追加
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
    // console.log("Data Before:", dataBefore); // デバッグ完了後はコメントアウト推奨
    // console.log("Data After:", dataAfter);   // デバッグ完了後はコメントアウト推奨

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
      console.error("Report data for calculation is missing. Aborting.");
      return null;
    }
    // console.log("Report Data used for calculation:", reportData); // デバッグ完了後はコメントアウト推奨

    // ★ store_name を取得 ★
    const storeName = reportData.store_name;
    // storeName が存在し、空文字でなく、文字列であることを確認
    if (!storeName || typeof storeName !== "string" || storeName.trim() === "") {
      console.error("store_name field is invalid:", storeName, ". Aborting.");
      return null;
    }
    console.log(`Store name: ${storeName}`);

    // 2. 対象月 (YYYY-MM) を特定
    const reportDateStr = reportData.report_date;
    if (!reportDateStr || typeof reportDateStr !== "string") {
      console.error("report_date field is invalid:", reportDateStr, ". Aborting.");
      return null;
    }

    let yearMonth;
    try {
      // 区切り文字が / でも - でもOKなように修正 (\D は数字以外の任意の一文字)
      const match = reportDateStr.match(/^(\d{4})\D(\d{2})\D(\d{2})/);
      if (!match) {
        throw new Error(`Date format "${reportDateStr}" could not be parsed (Expected YYYY?MM?DD)`);
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
        console.log(`--- Transaction Start for ${storeName} in ${yearMonth} ---`);
        const summarySnapshot = await transaction.get(summaryDocRef);
        const currentDocData = summarySnapshot.exists ? summarySnapshot.data() : {};
        const currentStoresData = currentDocData.stores || {};
        const currentStoreSummary = currentStoresData[storeName] || {};

        console.log("Current Store Summary:", JSON.stringify(currentStoreSummary)); // デバッグ用ログ

        // ★★★ 集計対象に daily_target_amount と discount_amount を追加 ★★★
        const fieldsToAggregate = [
          "sales_amount", "visitor_count",
          "new_customer_count", "dye_customer_count",
          "daily_target_amount", // ← 日次目標合計用
          "discount_amount"      // ← 値引き合計用
        ];
        const newStoreSummary = {};
        let reportCountDelta = 0;

        // このループで新しいフィールドも自動的に集計される
        fieldsToAggregate.forEach((field) => {
          // console.log(`Processing field: ${field}`); // デバッグ用
          const valueBefore = (dataBefore && dataBefore[field] != null) ? dataBefore[field] : 0;
          const valueAfter = (dataAfter && dataAfter[field] != null) ? dataAfter[field] : 0;
          // console.log(`  Value Before: ${valueBefore}, Value After: ${valueAfter}`); // デバッグ用

          let delta = 0;
          if (eventType === "CREATE") delta = valueAfter;
          else if (eventType === "DELETE") delta = -valueBefore;
          else if (eventType === "UPDATE") delta = valueAfter - valueBefore;
          // console.log(`  Calculated Delta: ${delta}`); // デバッグ用

          const currentStoreTotal = currentStoreSummary[field] ?? 0;
          // console.log(`  Current Store Total for ${field}: ${currentStoreTotal}`); // デバッグ用
          const newValue = Number(currentStoreTotal) + Number(delta);
          newStoreSummary[field] = isNaN(newValue) ? 0 : newValue; // NaNチェック
          // console.log(`  New Store Total for ${field}: ${newStoreSummary[field]}`); // デバッグ用
        });

        // reportCount計算 (変更なし)
        if (eventType === "CREATE") reportCountDelta = 1;
        else if (eventType === "DELETE") reportCountDelta = -1;
        const currentStoreReportCount = currentStoreSummary.reportCount ?? 0;
        const newReportCountValue = Number(currentStoreReportCount) + Number(reportCountDelta);
        newStoreSummary.reportCount = isNaN(newReportCountValue) ? 0 : newReportCountValue; // NaNチェック
        // console.log(`New Store Report Count: ${newStoreSummary.reportCount}`); // デバッグ用


        // ★★★ 最新の monthly_target_amount を保存 ★★★
        const currentMonthlyTarget = currentStoreSummary.monthly_target_amount ?? 0;
        const reportMonthlyTarget = reportData.monthly_target_amount; // レポートの月間目標値 (undefined かもしれない)
        if (eventType === 'DELETE') {
            // 削除の場合は古い値を維持 (ただし数値保証)
            newStoreSummary.monthly_target_amount = isNaN(Number(currentMonthlyTarget)) ? 0 : Number(currentMonthlyTarget);
        } else {
            // 作成・更新の場合は、レポートに値があればそれ、なければ古い値 (ただし数値保証)
            newStoreSummary.monthly_target_amount = (reportMonthlyTarget != null) ? Number(reportMonthlyTarget) : Number(currentMonthlyTarget);
            newStoreSummary.monthly_target_amount = isNaN(Number(newStoreSummary.monthly_target_amount)) ? 0 : newStoreSummary.monthly_target_amount;
        }
        console.log(`New Store Monthly Target: ${newStoreSummary.monthly_target_amount}`); // ★ログ追加
        // ★★★ ここまで monthly_target_amount の処理 ★★★


        const finalDocData = {
            stores: {
                ...currentStoresData,
                [storeName]: newStoreSummary
            },
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        };

        console.log("Final newStoreSummary object:", JSON.stringify(newStoreSummary)); // デバッグ用ログ
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