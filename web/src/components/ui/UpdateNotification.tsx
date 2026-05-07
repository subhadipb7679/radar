import { useState, useEffect, useRef } from 'react'
import { Download, Copy, Check, RotateCw, ArrowDownToLine, Loader2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useVersionCheck,
  useStartDesktopUpdate,
  useDesktopUpdateStatus,
  useApplyDesktopUpdate,
} from '../../api/client'
import type { DesktopUpdateState } from '../../api/client'

export function UpdateNotification() {
  const queryClient = useQueryClient()
  const { data: versionInfo } = useVersionCheck()
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)

  const [desktopUpdating, setDesktopUpdating] = useState(false)
  const startUpdate = useStartDesktopUpdate()
  const applyUpdate = useApplyDesktopUpdate()
  const { data: updateStatus } = useDesktopUpdateStatus(desktopUpdating)

  const isDesktop = versionInfo?.installMethod === 'desktop'

  useEffect(() => {
    const wailsRuntime = (window as unknown as Record<string, unknown>).runtime as
      | { EventsOn?: (event: string, callback: () => void) => () => void }
      | undefined
    if (!wailsRuntime?.EventsOn) return

    const cleanup = wailsRuntime.EventsOn('check-for-updates', () => {
      setOpen(true)
      queryClient.invalidateQueries({ queryKey: ['version-check'] })
    })

    return cleanup
  }, [queryClient])

  useEffect(() => {
    if (versionInfo?.error) {
      console.debug('[radar] Version check failed:', versionInfo.error)
    }
  }, [versionInfo?.error])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  useEffect(() => {
    if (updateStatus?.state === 'error' || updateStatus?.state === 'idle') {
      setDesktopUpdating(false)
    }
  }, [updateStatus?.state])

  const handleCopyCommand = async () => {
    if (!versionInfo?.updateCommand) return
    try {
      await navigator.clipboard.writeText(versionInfo.updateCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.debug('[radar] Clipboard write failed:', err)
      setCopyFailed(true)
      setTimeout(() => setCopyFailed(false), 2000)
    }
  }

  const handleStartDesktopUpdate = () => {
    startUpdate.mutate(undefined, {
      onSuccess: () => {
        setDesktopUpdating(true)
        setOpen(true)
      },
    })
  }

  if (!versionInfo?.updateAvailable) {
    return null
  }

  const effectiveState: DesktopUpdateState = updateStatus?.state ?? 'idle'
  const busy = effectiveState === 'downloading' || effectiveState === 'applying' || startUpdate.isPending

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen(value => !value)}
        className="relative inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-accent/40 bg-accent-muted text-accent-text hover:bg-accent-muted/80 transition-colors"
        title={`Radar ${versionInfo.latestVersion} is available`}
      >
        <UpdateIcon state={effectiveState} />
        <span className="hidden xl:inline text-xs font-medium">
          {effectiveState === 'ready' ? 'Update ready' : 'Update'}
        </span>
        {busy && <span className="sr-only">Update in progress</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-80 bg-theme-surface border border-theme-border rounded-xl shadow-theme-lg p-4">
          <div className="flex items-start gap-3">
            <div className="flex items-center justify-center w-8 h-8 bg-accent-muted rounded-full shrink-0">
              <UpdateIcon state={effectiveState} />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-theme-text-primary">
                <UpdateTitle state={effectiveState} />
              </h4>
              <p className="text-xs text-theme-text-secondary mt-1">
                Radar {versionInfo.latestVersion} is available.{' '}
                You're on {versionInfo.currentVersion}.
              </p>

              {isDesktop && (
                <DesktopUpdateControls
                  state={effectiveState}
                  progress={updateStatus?.progress}
                  error={updateStatus?.error}
                  starting={startUpdate.isPending}
                  onStart={handleStartDesktopUpdate}
                  onApply={() => applyUpdate.mutate()}
                  onRetry={handleStartDesktopUpdate}
                />
              )}

              {!isDesktop && versionInfo.updateCommand ? (
                <button
                  onClick={handleCopyCommand}
                  className="flex items-center gap-2 mt-2 px-2 py-1.5 bg-theme-elevated rounded text-xs font-mono text-theme-text-primary hover:bg-theme-hover transition-colors w-full"
                >
                  <code className="flex-1 text-left truncate">{versionInfo.updateCommand}</code>
                  <CopyIcon copied={copied} failed={copyFailed} />
                </button>
              ) : (
                !isDesktop && versionInfo.releaseUrl && (
                  <a
                    href={versionInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-accent-text hover:underline"
                  >
                    Download from GitHub
                  </a>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CopyIcon({ copied, failed }: { copied: boolean; failed: boolean }) {
  if (copied) return <Check className="w-3.5 h-3.5 text-green-400 shrink-0" />
  if (failed) return <RotateCw className="w-3.5 h-3.5 text-red-400 shrink-0" />
  return <Copy className="w-3.5 h-3.5 text-theme-text-tertiary shrink-0" />
}

function UpdateIcon({ state }: { state: DesktopUpdateState }) {
  switch (state) {
    case 'downloading':
    case 'applying':
      return <Loader2 className="w-4 h-4 text-accent animate-spin" />
    case 'ready':
      return <ArrowDownToLine className="w-4 h-4 text-green-400" />
    default:
      return <Download className="w-4 h-4 text-accent" />
  }
}

function UpdateTitle({ state }: { state: DesktopUpdateState }) {
  switch (state) {
    case 'ready':
      return <>Update Ready</>
    case 'applying':
      return <>Applying Update...</>
    default:
      return <>Update Available</>
  }
}

function DesktopUpdateControls({
  state,
  progress,
  error,
  starting,
  onStart,
  onApply,
  onRetry,
}: {
  state: DesktopUpdateState
  progress?: number
  error?: string
  starting?: boolean
  onStart: () => void
  onApply: () => void
  onRetry: () => void
}) {
  switch (state) {
    case 'idle':
      return (
        <button
          onClick={onStart}
          disabled={starting}
          className="mt-2 px-3 py-1.5 btn-brand text-xs font-medium rounded"
        >
          {starting ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Starting...
            </span>
          ) : (
            'Update Now'
          )}
        </button>
      )

    case 'downloading':
      return (
        <div className="mt-2 space-y-1">
          <div className="w-full bg-theme-elevated rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-accent h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-theme-text-tertiary">
            Downloading... {Math.round((progress ?? 0) * 100)}%
          </p>
        </div>
      )

    case 'ready':
      return (
        <div className="mt-2 flex gap-2">
          <button
            onClick={onApply}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded transition-colors"
          >
            Restart Now
          </button>
        </div>
      )

    case 'applying':
      return (
        <div className="mt-2 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
          <p className="text-xs text-theme-text-secondary">Applying update...</p>
        </div>
      )

    case 'error':
      return (
        <div className="mt-2 space-y-1.5">
          {!starting && <p className="text-xs text-red-400">{error || 'Update failed'}</p>}
          <button
            onClick={onRetry}
            disabled={starting}
            className="inline-flex items-center gap-1 px-3 py-1.5 bg-theme-elevated hover:bg-theme-hover text-xs font-medium text-theme-text-primary rounded transition-colors disabled:opacity-50"
          >
            {starting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RotateCw className="w-3 h-3" />
            )}
            {starting ? 'Starting...' : 'Retry'}
          </button>
        </div>
      )
  }
}
