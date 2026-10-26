import { type ReactNode, type Ref, useId } from 'react'

/**
 * A titled group of settings: a heading over a card of {@link SettingRow}s. With `headingRef`,
 * the heading can take focus, for a link that leads to the section.
 */
export function SettingsSection({
  title,
  headingRef,
  children,
}: {
  title: string
  headingRef?: Ref<HTMLHeadingElement>
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2
        id={headingId}
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
        className="rounded-md px-1 text-lg font-bold tracking-tight"
      >
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
 * never moves the control under the user's finger. A `badge`, such as the quality
 * settings' "In use", sits beside the label but outside it, so the control's name
 * stays the label: give it an id and add that to the control's description.
 */
export function SettingRow({
  label,
  labelId,
  badge,
  help,
  children,
}: {
  label: string
  labelId: string
  badge?: ReactNode
  help?: ReactNode
  children: ReactNode
}) {
  return (
    // From 768px: label and help (up to 20rem, narrower if needed) left, the whole control right.
    <div className="grid gap-3 p-4 sm:p-5 md:grid-cols-[minmax(0,20rem)_max-content] md:grid-rows-[auto_1fr] md:justify-between md:gap-x-8 md:gap-y-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:col-start-1 md:row-start-1">
        <p id={labelId} className="font-semibold">
          {label}
        </p>
        {badge}
      </div>
      <div className="min-w-0 md:col-start-2 md:row-span-2 md:row-start-1">{children}</div>
      {help && <div className="md:col-start-1 md:row-start-2">{help}</div>}
    </div>
  )
}
