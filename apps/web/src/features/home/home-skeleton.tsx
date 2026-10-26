import { placeholderKeys, Skeleton } from '../../components/ui/skeleton'

/** Home while its shelves load: `shelves` placeholder rows, and what screen readers hear. */
export function HomeSkeleton({
  shelves = 3,
  label = 'Loading your Home…',
}: {
  shelves?: number
  label?: string
}) {
  return (
    <div role="status" className="space-y-10">
      <span className="sr-only">{label}</span>
      {placeholderKeys(shelves, 'home-shelf').map((key) => (
        <div key={key} className="space-y-4">
          <Skeleton className="h-6 w-48 rounded-full" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
            {placeholderKeys(6, `${key}-card`).map((card, index) => (
              <div
                key={card}
                className={index >= 4 ? 'max-lg:hidden' : index >= 2 ? 'max-sm:hidden' : undefined}
              >
                <Skeleton className="aspect-square w-full rounded-md" />
                <Skeleton className="mt-3 h-3.5 w-4/5 rounded-full" />
                <Skeleton className="mt-2 h-3 w-1/2 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
