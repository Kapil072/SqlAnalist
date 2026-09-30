'use client';
import { useEffect, useRef } from 'react';
import {
  Chart, CategoryScale, LinearScale, BarElement, ArcElement,
  LineElement, PointElement, Title, Tooltip, Legend,
} from 'chart.js';

Chart.register(
  CategoryScale, LinearScale, BarElement, ArcElement,
  LineElement, PointElement, Title, Tooltip, Legend
);

interface Props {
  chart: { type: string; title: string; x_axis?: string; y_axis?: string };
  columns: string[];
  rows: (string | number | null)[][];
}

const TEAL_COLORS = [
  '#0E9999','#B1E5E6','#7DD3D4','#0B7A7A','#CCFBFA',
  '#085F5F','#3DB8B9','#1EA0A0','#064848','#033030',
];

export default function ChartBlock({ chart, columns, rows }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);

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
      : columns.length > 1 ? 1 : 0;

    const labels = rows.map(r => String(r[xIdx] ?? ''));
    const values = rows.map(r => Number(r[yIdx]) || 0);
    const isDoughnut = chart.type === 'doughnut' || chart.type === 'pie';

    chartRef.current = new Chart(ctx, {
      type: isDoughnut ? 'doughnut' : chart.type === 'line' ? 'line' : 'bar',
      data: {
        labels,
        datasets: [{
          label: columns[yIdx] || 'Value',
          data: values,
          backgroundColor: isDoughnut
            ? TEAL_COLORS.slice(0, labels.length)
            : 'rgba(14,153,153,0.80)',
          borderColor: isDoughnut ? '#ffffff' : '#0B7A7A',
          borderWidth: isDoughnut ? 2 : 1.5,
          borderRadius: isDoughnut ? 0 : 6,
          fill: chart.type === 'line' ? false : undefined,
          tension: 0.3,
        } as never],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: isDoughnut,
            labels: { color: '#085F5F', font: { family: 'Inter', size: 12 } },
          },
          tooltip: {
            backgroundColor: '#ffffff',
            titleColor: '#062020',
            bodyColor: '#3d7777',
            borderColor: '#B1E5E6',
            borderWidth: 1,
            padding: 10,
          },
        },
        scales: isDoughnut ? {} : {
          x: {
            ticks: { color: '#3d7777', font: { family: 'Inter', size: 11 } },
            grid: { display: false },
          },
          y: {
            ticks: { color: '#3d7777', font: { family: 'Inter', size: 11 } },
            grid: { color: 'rgba(177,229,230,0.5)' },
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
    <div className="bg-teal-50/60 rounded-xl border border-teal-100 p-4">
      {chart.title && (
        <p className="font-heading font-bold text-sm text-teal-800 mb-3">
          {chart.title}
        </p>
      )}
      <div className="relative h-56">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
