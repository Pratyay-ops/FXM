import { type ReactNode, useId } from 'react'

/** A titled group of settings, as the Settings page lists them. */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="px-1 text-lg font-bold tracking-tight">
        {title}
      </h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {children}
      </div>
    </section>
  )
}

/**
 * One setting: a label with optional help beside its control. Phones stack them as
 * label, control, help, so help whose length changes with the value (catalog mode)
 * never moves the control under the user's finger.
 */
export function SettingRow({
  label,
  labelId,
  help,
  children,
}: {
  label: string
  labelId: string
  help?: ReactNode
  children: ReactNode
}) {
  return (
    // From 768px: label and help (up to 20rem, narrower if needed) left, the whole control right.
    <div className="grid gap-3 p-4 sm:p-5 md:grid-cols-[minmax(0,20rem)_max-content] md:grid-rows-[auto_1fr] md:justify-between md:gap-x-8 md:gap-y-1">
      <p id={labelId} className="font-semibold md:col-start-1 md:row-start-1">
        {label}
      </p>
      <div className="min-w-0 md:col-start-2 md:row-span-2 md:row-start-1">{children}</div>
      {help && <div className="md:col-start-1 md:row-start-2">{help}</div>}
    </div>
  )
}
