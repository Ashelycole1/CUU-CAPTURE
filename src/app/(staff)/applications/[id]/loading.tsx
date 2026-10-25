import { Skeleton } from '@/components/ui/skeleton';

export default function ApplicationLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-10 w-72" />
      <div className="grid gap-4 xl:grid-cols-[20rem_1fr_24rem]">
        <div className="space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-32" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}
