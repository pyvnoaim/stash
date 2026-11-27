import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { exportBackup } from '@/components/command-palette'

/**
 * A render that throws takes React's whole tree down with it, and with no boundary that is a blank
 * window: no sidebar, no way to the export, nothing to say what happened. This catches it, says
 * what is still true — every edit is already in this browser's storage, and synced when there is a
 * connection, neither of which a broken render touches — and offers the next steps: reload, and a
 * backup to take first, in case it is the stored document itself that keeps breaking the render.
 * ponytail: one boundary around the app, not one per page. Add a tighter one around a tool if a
 * crash there ever needs to leave the lists standing.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('stash: a render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="bg-sidebar grid min-h-svh place-items-center p-4">
        <div role="alert" className="bg-background grid w-full max-w-sm gap-3 rounded-[10px] border p-6">
          <p className="font-medium">Something on this page broke.</p>
          <p className="text-muted-foreground text-sm">
            Your stash is still kept in this browser, and synced to the server when you are online. Nothing here touched it.
          </p>
          <p className="text-muted-foreground truncate font-mono text-xs" title={this.state.error.message}>
            {this.state.error.message}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => location.reload()}>Reload</Button>
            {/* if the stored document is what breaks the render, Reload breaks it again: take a copy out first */}
            <Button variant="outline" onClick={() => exportBackup()}>Export a backup</Button>
          </div>
        </div>
      </div>
    )
  }
}
