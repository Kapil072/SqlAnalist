import LoadingScreen from '@/components/LoadingScreen';

export default function DashboardLoading() {
  return (
    <LoadingScreen
      message="Opening Analytics Dashboard…"
      subMessage="Loading database schema, tables, and AI assistant"
    />
  );
}
