import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react'
import { cn } from '../../../lib/cn'

const control =
  'w-full rounded-lg border border-border-strong bg-background px-3 text-base text-text placeholder:text-text-muted'

interface FieldProps {
  label: string
  /** Help under the control. */
  hint?: string
  className?: string
}

/**
 * A labelled text input. The text is 16px, so phones don't zoom in on focus. An `error` shows
 * under it, marks it invalid and joins its description, so screen readers read it with the
 * field.
 */
export function TextField({
  label,
  hint,
  error,
  className,
  ...input
}: FieldProps & {
  /** Why the value was refused, for people; announced when it appears. */
  error?: string | undefined
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  const id = useId()
  const hintId = useId()
  const errorId = useId()
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ')
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <input
        {...input}
        id={id}
        aria-describedby={describedBy || undefined}
        aria-invalid={error ? true : undefined}
        className={cn(control, 'h-touch', error && 'border-danger')}
      />
      {hint && (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** A labelled multi-line text field. */
export function TextAreaField({
  label,
  hint,
  className,
  ...textarea
}: FieldProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  const id = useId()
  const hintId = useId()
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <textarea
        {...textarea}
        id={id}
        aria-describedby={hint ? hintId : undefined}
        className={cn(control, 'min-h-24 resize-y py-2.5')}
      />
      {hint && (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      )}
    </div>
  )
}
