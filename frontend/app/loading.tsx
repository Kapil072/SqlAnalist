import LoadingScreen from '@/components/LoadingScreen';

export default function RootLoading() {
  return (
    <LoadingScreen
      message="Loading SQLAnalyst…"
      subMessage="Connecting to workspace and analytical services"
    />
  );
}
