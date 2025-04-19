// firebase-admin SDKをインポート
const admin = require('firebase-admin');

// Firestoreサービスアカウントキーの読み込みと初期化 (reports.js と同じ)
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK Initialized Successfully (from subscribe)!");
  } else {
    console.log("Firebase Admin SDK Already Initialized (from subscribe).");
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error (from subscribe):', e);
  // 初期化に失敗したら、このエンドポイントは機能しない
  throw new Error('Firebase Admin SDK Initialization Failed');
}

const db = admin.firestore(); // Firestoreデータベースへの参照を取得

// Vercelサーバーレス関数のエントリーポイント
module.exports = async (req, res) => {
  // dbが初期化されていない場合はエラー
  if (!db) {
    console.error('Firestore DB instance is not available (subscribe).');
    return res.status(500).json({ error: 'サーバー設定エラーが発生しました (DB Init Failed)。' });
  }

  // 1. メソッドがPOSTかチェック
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  try {
    // 2. リクエストボディを取得し、中身を検証
    const subscription = req.body && req.body.subscription; // bodyまたはbody.subscriptionを取得

    if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      console.error('Invalid subscription object received:', req.body);
      return res.status(400).json({ error: '無効な購読情報オブジェクトです。' });
    }

    // 3. 重複チェック（同じendpointが既に存在するか確認）
    const endpoint = subscription.endpoint;
    const querySnapshot = await db.collection('pushSubscriptions')
                                  .where('subscription.endpoint', '==', endpoint)
                                  .limit(1)
                                  .get();

    if (!querySnapshot.empty) {
      // 既に存在する場合
      console.log(`Subscription endpoint already exists: ${endpoint.substring(0, 40)}...`);
      return res.status(200).json({ message: '購読情報は既に登録されています。' }); // 成功(OK)として返す
    }

    // 4. Firestoreに保存するデータを作成
    const dataToSave = {
      subscription: subscription, // 受け取った購読情報オブジェクト全体
      createdAt: admin.firestore.FieldValue.serverTimestamp() // 保存日時
    };

    // 5. Firestoreの pushSubscriptions コレクションに追加
    const docRef = await db.collection('pushSubscriptions').add(dataToSave);
    console.log('Subscription saved with ID: ', docRef.id);

    // 6. 成功レスポンス (新規作成)
    return res.status(201).json({ message: '購読情報を受け付けました。' });

  } catch (error) {
    // 7. エラーハンドリング
    console.error('Error saving subscription:', error);
    return res.status(500).json({ error: '購読情報の保存中にエラーが発生しました。' });
  }
};