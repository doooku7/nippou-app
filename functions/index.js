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
 */
exports.updateMonthlySummary = functions
  .region("asia-northeast1") // 東京リージョンを指定
  .firestore.document("reports/{reportId}")
  .onWrite(async (change, context) => {
    const reportId = context.params.reportId;
    console.log(`Report ${reportId} changed. Triggering per-store summary update.`);

    // 1. イベントタイプとデータを取得
    const dataBefore = change.before.exists ? change.before.data() : null;
    const dataAfter = change.after.exists ? change.after.data() : null;

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
      console.error("Report data is missing.");
      return null;
    }

    // ★ store_name を取得 ★
    const storeName = reportData.store_name;
    // storeName が存在し、空文字でなく、文字列であることを確認
    if (!storeName || typeof storeName !== "string" || storeName.trim() === "") {
      console.error("store_name field is missing, empty, or not a string:", storeName);
      // store_name がなければどの店舗の集計か判断できないため終了
      return null;
    }
    console.log(`Store name: ${storeName}`);

    // 2. 対象月 (YYYY-MM) を特定
    const reportDateStr = reportData.report_date;
    if (!reportDateStr || typeof reportDateStr !== "string") {
      console.error("report_date field is missing or not a string:", reportDateStr);
      return null;
    }

    let yearMonth;
    try {
      const match = reportDateStr.match(/^(\d{4})[-\/](\d{2})[-\/]\d{2}$/);
      if (!match) {
        throw new Error("Date format is not YYYY/MM/DD or YYYY-MM-DD");
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
        // 4. トランザクション内で月次集計ドキュメント全体を読み込み
        const summarySnapshot = await transaction.get(summaryDocRef);
        const currentDocData = summarySnapshot.exists ? summarySnapshot.data() : {}; // ドキュメント全体のデータ

        // 5. ★ 店舗別データを処理 ★
        const currentStoresData = currentDocData.stores || {}; // storesマップがなければ空オブジェクト
        const currentStoreSummary = currentStoresData[storeName] || {}; // 対象店舗のデータがなければ空オブジェクト

        // 集計対象のフィールド名リスト
        const fieldsToAggregate = [
          "sales_amount",
          "visitor_count",
          "new_customer_count",
          "dye_customer_count",
        ];

        const newStoreSummary = {}; // 更新後のこの店舗のデータ
        let reportCountDelta = 0; // この店舗のレポート数の増減

        // イベントタイプに応じて各フィールドの差分（delta）を計算
        fieldsToAggregate.forEach((field) => {
          // レポートデータから値を取得 (なければ0)
          const valueBefore = (dataBefore && dataBefore[field] != null) ? dataBefore[field] : 0;
          const valueAfter = (dataAfter && dataAfter[field] != null) ? dataAfter[field] : 0;
          let delta = 0;

          if (eventType === "CREATE") {
            delta = valueAfter;
          } else if (eventType === "DELETE") {
            delta = -valueBefore;
          } else if (eventType === "UPDATE") {
            delta = valueAfter - valueBefore;
          }

          // ★ この店舗の現在の集計値に差分を加算 ★
          const currentStoreTotal = currentStoreSummary[field] ?? 0; // 店舗データから現在の値を取得
          newStoreSummary[field] = currentStoreTotal + delta;
        });

        // ★ この店舗のレポート数の増減を計算 ★
        if (eventType === "CREATE") {
          reportCountDelta = 1;
        } else if (eventType === "DELETE") {
          reportCountDelta = -1;
        }
        const currentStoreReportCount = currentStoreSummary.reportCount ?? 0; // 店舗データから現在のレポート数を取得
        newStoreSummary.reportCount = currentStoreReportCount + reportCountDelta;

        // 6. ★ 書き込むための最終的なドキュメントデータを作成 ★
        const finalDocData = {
            // ...currentDocData, // ← ドキュメント全体の他のフィールド(もしあれば)を維持する場合、必要ならコメント解除
            stores: { // stores マップを更新
                ...currentStoresData, // 他の店舗のデータを維持
                [storeName]: newStoreSummary // ★ この店舗のデータを更新/追加 ★
            },
            lastUpdated: admin.firestore.FieldValue.serverTimestamp(), // 最終更新日時
        };

        // (もし全体の合計値 'overall' も保持するなら、ここで別途計算して finalDocData.overall に設定する)

        console.log(`Updating summary for store "${storeName}" in ${yearMonth}:`, newStoreSummary);

        // 7. トランザクション内で新しいドキュメントデータを書き込み (set + merge:true で安全に)
        transaction.set(summaryDocRef, finalDocData, { merge: true });
      });

      console.log(`Transaction successfully committed for store "${storeName}" in ${yearMonth}.`);

    } catch (error) {
      console.error(`Transaction failed for store "${storeName}" in ${yearMonth}:`, error);
    }

    return null; // 関数の終了
  });