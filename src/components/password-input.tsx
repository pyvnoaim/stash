import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * A password field with the eye on it. One of these rather than a toggle per form: there is no
 * password anywhere in the app that should be harder to check than another, and this way adding
 * one cannot forget it. There is no reset by mail here, so a typo you cannot see is expensive.
 *
 * The state is per field and starts hidden every time — nothing remembers that you revealed one.
 */
export function PasswordInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  const [shown, setShown] = useState(false)

  return (
    <div className="relative">
      <Input
        {...props}
        type={shown ? 'text' : 'password'}
        // room for the button, and never the browser's own reveal on top of ours
        className={cn('pr-9 [&::-ms-reveal]:hidden', className)}
      />
      <button
        type="button"
        // reachable by tab: a keyboard is the only way some people have of checking what they typed
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}
