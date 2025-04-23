<script setup>
import { computed, ref, defineProps } from 'vue';
// vue-chartjs から Bar チャートコンポーネントをインポート
import { Bar } from 'vue-chartjs';
// Chart.js 本体と、必要な要素（スケール、ツールチップなど）をインポート
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  BarElement,
  CategoryScale,
  LinearScale
} from 'chart.js';

// Chart.js に必要な要素を登録
ChartJS.register(Title, Tooltip, Legend, BarElement, CategoryScale, LinearScale);

// 親コンポーネント (App.vue) から店舗別データを受け取るための props を定義
// === ↓↓↓ プロパティ名を chartData に修正 ↓↓↓ ===
const props = defineProps({
  chartData: { // App.vue から :chart-data で渡される名前に合わせる
    type: Object,
    required: true,
    default: () => ({})
  }
});
// === ↑↑↑ ここまで修正 ↑↑↑ ===

// 受け取ったデータを Chart.js が要求する形式に変換する computed プロパティ
const processedChartData = computed(() => {
  // === ↓↓↓ props.storesData を props.chartData に修正 ↓↓↓ ===
  if (!props.chartData || Object.keys(props.chartData).length === 0) {
    return { labels: [], datasets: [] }; // データがない場合は空の構造を返す
  }

  const labels = Object.keys(props.chartData);
  const dataPoints = labels.map(storeName => props.chartData[storeName]?.sales_amount ?? 0);
  // === ↑↑↑ ここまで修正 ↑↑↑ ===

  return {
    labels: labels, // X軸のラベル (店舗名)
    datasets: [
      {
        label: '店舗別 売上 (円)', // 凡例のラベル
        backgroundColor: '#41B883', // 棒グラフの色
        borderColor: '#2a8a5e', // 枠線の色 (任意)
        borderWidth: 1,         // 枠線の太さ (任意)
        data: dataPoints      // Y軸の値 (売上)
      }
    ]
  };
});

// Chart.js の表示オプション (前回から変更なし)
const chartOptions = ref({
  responsive: true,
  plugins: {
    legend: {
      display: true,
      position: 'top',
    },
    title: {
      display: false,
    },
    tooltip: {
      enabled: true
    }
  },
  scales: {
    y: {
      beginAtZero: true
    }
  }
});
</script>

<template>
  <Bar
    v-if="processedChartData.labels.length > 0"
    :data="processedChartData"
    :options="chartOptions"
    id="store-sales-bar-chart"
  />
  <p v-else>グラフを表示するデータがありません。</p>
</template>

<style scoped>
/* このコンポーネント固有のスタイルがあれば記述 */
</style>