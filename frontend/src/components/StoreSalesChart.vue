<script setup>
import { computed, ref, defineProps } from 'vue';
// vue-chartjs から Bar チャートコンポーネントをインポート
import { Bar } from 'vue-chartjs';
// Chart.js 本体と、必要な要素（スケール、ツールチップなど）をインポート
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend, // Legend は登録しておく
  BarElement,
  CategoryScale,
  LinearScale
} from 'chart.js';

// Chart.js に必要な要素を登録
ChartJS.register(Title, Tooltip, Legend, BarElement, CategoryScale, LinearScale);

// 親コンポーネント (App.vue) から店舗別データを受け取るための props を定義
const props = defineProps({
  chartData: { // App.vue から :chart-data で渡される
    type: Object,
    required: true,
    default: () => ({})
  }
});

// 受け取ったデータを Chart.js が要求する形式に変換する computed プロパティ
const processedChartData = computed(() => {
  // データがない、または空オブジェクトの場合は空のグラフデータを返す
  if (!props.chartData || Object.keys(props.chartData).length === 0) {
    return { labels: [], datasets: [] };
  }

  // 店舗名をラベルとして抽出
  const labels = Object.keys(props.chartData);
  // 各店舗の売上データを抽出 (データがない場合は 0 とする)
  const dataPoints = labels.map(storeName => props.chartData[storeName]?.sales_amount ?? 0);

  return {
    labels: labels, // X軸のラベル (店舗名)
    datasets: [
      {
        label: '店舗別 売上', // 凡例非表示でもツールチップ等で使われることがある
        backgroundColor: '#4fc3f7', // 棒グラフの色 (App.vue の売上差額プラスの色に合わせた例)
        // backgroundColor: '#3e608a', // または、テーマに合わせた別の色
        borderColor: 'rgba(79, 195, 247, 0.5)', // 枠線の色 (任意)
        borderWidth: 1, // 枠線の太さ (任意)
        data: dataPoints // Y軸の値 (売上)
      }
    ]
  };
});

// Chart.js の表示オプション
const chartOptions = ref({
  responsive: true, // コンテナに合わせてリサイズ
  maintainAspectRatio: false, // コンテナの高さに追従させる (重要)
  plugins: {
    legend: {
      // --- ▼▼▼ 凡例を非表示にする ▼▼▼ ---
      display: false,
      // --- ▲▲▲ ここを false に変更 ▲▲▲ ---
    },
    title: {
      display: false, // グラフ自体のタイトルは表示しない
    },
    tooltip: {
      enabled: true // マウスオーバー時のツールチップは有効
      // ツールチップのカスタマイズ (任意)
      // callbacks: {
      //   label: function(context) {
      //     let label = context.dataset.label || '';
      //     if (label) {
      //       label += ': ';
      //     }
      //     if (context.parsed.y !== null) {
      //       label += new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(context.parsed.y);
      //     }
      //     return label;
      //   }
      // }
    }
  },
  scales: {
    y: { // Y軸の設定
      beginAtZero: true, // 0から開始
      title: {
        display: false, // Y軸のタイトルは表示しない
      },
      // Y軸の目盛り・グリッド線のスタイル (ダークテーマ向け調整例)
      ticks: {
          color: '#bbb' // 目盛りの文字色
      },
      grid: {
          color: 'rgba(187, 187, 187, 0.2)' // Y軸のグリッド線色
      }
    },
    x: { // X軸の設定
      // X軸の目盛り・グリッド線のスタイル (ダークテーマ向け調整例)
      ticks: {
          color: '#bbb' // 目盛りの文字色
      },
      grid: {
          display: false // X軸のグリッド線は非表示に
      }
    }
  }
});
</script>

<template>
  <Bar
    v-if="processedChartData.labels.length > 0"
    :data="processedChartData"
    :options="chartOptions" id="store-sales-bar-chart"
    style="height: 100%; width: 100%;" />
  <p v-else>グラフを表示するデータがありません。</p>
</template>

<style scoped>
/* このコンポーネント固有のスタイル */
p { /* データがない場合のメッセージスタイル */
    margin-top: 20px;
    text-align: center;
    color: #aaa;
}
</style>