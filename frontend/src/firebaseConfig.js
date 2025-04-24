// src/firebaseConfig.js
import { initializeApp } from "firebase/app"; // Firebase App モジュールをインポート
import { getAuth } from "firebase/auth";   // Firebase Auth モジュールをインポート

// ★★★ 下の firebaseConfig の中身全体を、Firebase コンソールからコピーしたものに置き換える ★★★
const firebaseConfig = {
    apiKey: "AIzaSyAjkR1IPkS7tZVA0f0eosg25yyU8c93X8A",
    authDomain: "nippou-app-001.firebaseapp.com",
    projectId: "nippou-app-001",
    storageBucket: "nippou-app-001.firebasestorage.app",
    messagingSenderId: "463716864839",
    appId: "1:463716864839:web:e7c8bbc8c156b5c6cff262",
    measurementId: "G-7SMCG6V1QS"
};
// ★★★ 置き換えここまで ★★★

// Firebase アプリを初期化
const app = initializeApp(firebaseConfig);

// Firebase Authentication のインスタンスを取得してエクスポート
// これを他の Vue コンポーネントからインポートして使う
const auth = getAuth(app);

export { auth };