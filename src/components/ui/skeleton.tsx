import { cn } from "@/lib/utils"

/**
 * A loading placeholder with a highlight sweeping across it — the `.shimmer` class in index.css,
 * which is one gradient and one keyframe. No animation library for a moving rectangle, and the
 * reduced-motion rule in the same file already stills it for anyone who asked for that.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted shimmer relative overflow-hidden rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
