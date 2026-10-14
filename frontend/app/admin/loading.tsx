import LoadingScreen from '@/components/LoadingScreen';

export default function AdminLoading() {
  return (
    <LoadingScreen
      message="Loading Administration Console…"
      subMessage="Fetching system metrics, user roles, and security audit logs"
    />
  );
}
