// firebase-admin SDKをインポート (Firestore操作に必要)
const admin = require('firebase-admin');

// ★★★ Firestoreサービスアカウントキーの読み込みと初期化 ★★★
// 環境変数からサービスアカウント情報を取得
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');

// Admin SDKが初期化されていない場合のみ初期化
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (e) {
    console.error('Firebase Admin Initialization Error', e);
  }
}

const db = admin.firestore(); // Firestoreデータベースへの参照を取得

// Vercelサーバーレス関数のエントリーポイント
module.exports = async (req, res) => {
  // 1. HTTPメソッドがPOSTかチェック
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  // 2. 認証: APIキーをヘッダーから取得して検証
  const providedApiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.EXPECTED_API_KEY; // Vercelの環境変数から読み込む

  if (!providedApiKey || providedApiKey !== expectedApiKey) {
    // APIキーが違う場合は401 Unauthorizedエラーを返す
    return res.status(401).json({ error: '認証に失敗しました。APIキーが無効です。' });
  }

  try {
    // 3. リクエストボディ (JSON) を取得
    // Vercelでは通常自動でパースされるが、エラーハンドリングはあっても良い
    const reportData = req.body;

    // 4. データ検証 (バリデーション) ★★★ ここに詳細なチェック処理を追加 ★★★
    console.log('Received data:', reportData); // まずは受け取ったデータをログに出力してみる
    // 例: 必須項目チェック
    if (!reportData || !reportData.report_date || !reportData.store_name /* ...など */) {
      console.error('Validation Error: Missing required fields');
      return res.status(400).json({ error: '必須項目が不足しています。' });
    }
    // ここに、データ型、日付形式、数値範囲などのチェックを追加していく

    // 5. Firestoreにデータを保存する準備
    const reportPayload = {
      report_date: reportData.report_date,
      store_name: reportData.store_name,
      sales_amount: Number(reportData.sales_amount) || 0, // 数値に変換 (失敗したら0)
      daily_target_amount: Number(reportData.daily_target_amount) || 0,
      visitor_count: Number(reportData.visitor_count) || 0,
      new_customer_count: Number(reportData.new_customer_count) || 0,
      dye_customer_count: Number(reportData.dye_customer_count) || 0,
      comment: reportData.comment || null, // なければnull
      monthly_target_amount: Number(reportData.monthly_target_amount) || 0,
      // createdAtはFirestoreのサーバータイムスタンプ機能で自動設定
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // 6. Firestoreにデータを追加
    const docRef = await db.collection('reports').add(reportPayload);
    console.log('Document written with ID: ', docRef.id); // ログに記録

    // 7. 成功レスポンスを返す
    return res.status(201).json({ message: '日報を受け付けました', reportId: docRef.id });

  } catch (error) {
    // 8. エラーハンドリング
    console.error('Error processing report:', error); // エラー内容をサーバーログに記録
    // JSONパースエラーなどのクライアント起因エラーも考慮
    if (error instanceof SyntaxError && error.message.includes('JSON')) {
        return res.status(400).json({ error: 'リクエストボディのJSON形式が不正です。' });
    }
    // その他の予期せぬエラー
    return res.status(500).json({ error: 'サーバー内部でエラーが発生しました。' });
  }
};