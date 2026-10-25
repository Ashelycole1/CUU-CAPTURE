import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { studentText } from '@/i18n/student';

/** Loading state: skeletons, not spinners (design §8). */
export default function StudentLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only" role="status">
        {studentText.common.loading}
      </span>
      <Skeleton className="h-9 w-2/3" />
      <Skeleton className="h-24 w-full" />
      <SkeletonText lines={2} />
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
    </div>
  );
}
