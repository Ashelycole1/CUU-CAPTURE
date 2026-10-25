import { Skeleton } from '@/components/ui/skeleton';

/** Skeleton while the dashboard page streams (design §8: skeletons, not spinners). */
export default function DashboardLoading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <Skeleton className="h-9 w-48" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-11" />
      <div className="space-y-2">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
