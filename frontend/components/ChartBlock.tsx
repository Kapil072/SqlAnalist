'use client';
import { useEffect, useRef } from 'react';
import {
  Chart,
  CategoryScale,
  LinearScale,
  BarElement,
  BarController,
  ArcElement,
  DoughnutController,
  PieController,
  LineElement,
  PointElement,
  LineController,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

Chart.register(
  CategoryScale,
  LinearScale,
  BarElement,
  BarController,
  ArcElement,
  DoughnutController,
  PieController,
  LineElement,
  PointElement,
  LineController,
  Title,
  Tooltip,
  Legend,
);

interface Props {
  chart: { type: string; title: string; x_axis?: string; y_axis?: string };
  columns: string[];
  rows: (string | number | null)[][];
}

// Distinct, colour-blind-friendly hues so pie slices are easy to tell apart
const PALETTE = [
  '#0E9999',
  '#6366F1',
  '#F59E0B',
  '#EC4899',
  '#0EA5E9',
  '#8B5CF6',
  '#10B981',
  '#F97316',
  '#64748B',
  '#14B8A6',
];
const AXIS = { color: '#64748B', font: { family: 'Inter', size: 11 } };
const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function ChartBlock({ chart, columns, rows }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    // Destroy existing chart
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    const colNames = columns.map(c => c.toLowerCase());
    const xIdx = chart.x_axis ? colNames.indexOf(chart.x_axis.toLowerCase()) : 0;
    const yIdx = chart.y_axis
      ? colNames.indexOf(chart.y_axis.toLowerCase())
      : columns.length > 1
        ? 1
        : 0;

    const labels = rows.map(r => String(r[xIdx] ?? ''));
    const values = rows.map(r => Number(r[yIdx]) || 0);
    const isDoughnut = chart.type === 'doughnut' || chart.type === 'pie';

    chartRef.current = new Chart(ctx, {
      type: isDoughnut ? 'doughnut' : chart.type === 'line' ? 'line' : 'bar',
      data: {
        labels,
        datasets: [
          {
            label: columns[yIdx] || 'Value',
            data: values,
            backgroundColor: isDoughnut
              ? labels.map((_, i) => PALETTE[i % PALETTE.length])
              : chart.type === 'line'
                ? 'rgba(14,153,153,0.12)'
                : 'rgba(14,153,153,0.85)',
            borderColor: isDoughnut ? '#ffffff' : '#0B7A7A',
            borderWidth: isDoughnut ? 2 : chart.type === 'line' ? 2 : 0,
            borderRadius: isDoughnut ? 0 : 6,
            maxBarThickness: 48,
            fill: chart.type === 'line',
            pointRadius: chart.type === 'line' ? 3 : undefined,
            tension: 0.3,
          } as never,
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: isDoughnut,
            position: 'right',
            labels: { color: '#334155', font: { family: 'Inter', size: 12 }, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: '#0F172A',
            titleColor: '#F8FAFC',
            bodyColor: '#E2E8F0',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: c => ` ${c.dataset.label}: ${fmt(Number(c.raw))}`,
            },
          },
        },
        scales: isDoughnut
          ? {}
          : {
              x: { ticks: { ...AXIS, maxRotation: 45 }, grid: { display: false } },
              y: {
                beginAtZero: true,
                ticks: { ...AXIS, callback: v => fmt(Number(v)) },
                grid: { color: '#EEF2F6' },
                border: { display: false },
              },
            },
      },
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [chart, columns, rows]);

  return (
    <div>
      {chart.title && <p className="text-sm font-semibold text-slate-800 mb-3">{chart.title}</p>}
      <div className="relative h-64">
        <canvas ref={canvasRef} role="img" aria-label={chart.title || 'Chart'} />
      </div>
    </div>
  );
}
