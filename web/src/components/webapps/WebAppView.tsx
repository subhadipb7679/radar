import { ExternalLink, Globe2 } from 'lucide-react'
import type { CustomWebApp } from '../../types/webapps'
import { openExternal } from '../../utils/navigation'

export function WebAppView({ app }: { app?: CustomWebApp | null }) {
  if (!app) {
    return (
      <div className="flex-1 min-h-0 bg-theme-base p-6">
        <div className="rounded-xl border border-theme-border bg-theme-surface p-6 text-sm text-theme-text-secondary">
          Select a web app from the top bar, or add one in Settings.
        </div>
      </div>
    )
  }
  const embeddedURL = `/webapp-proxy/${encodeURIComponent(app.id)}/`

  return (
    <div className="flex-1 min-h-0 bg-theme-base p-4">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-theme-sm">
        <div className="flex items-center justify-between gap-3 border-b border-theme-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-elevated"
              style={{ color: app.color || undefined }}
            >
              <Globe2 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-theme-text-primary">{app.name}</div>
              <div className="truncate text-xs text-theme-text-tertiary">{app.url}</div>
            </div>
          </div>
          <button
            onClick={() => openExternal(app.url)}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-theme-border bg-theme-elevated px-3 py-1.5 text-sm text-theme-text-secondary hover:bg-theme-hover hover:text-theme-text-primary"
          >
            <ExternalLink className="h-4 w-4" />
            Open externally
          </button>
        </div>

        <iframe
          title={app.name}
          src={embeddedURL}
          className="min-h-0 flex-1 bg-white"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
        />
      </div>
    </div>
  )
}
