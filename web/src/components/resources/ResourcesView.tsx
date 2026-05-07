import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ApiError, fetchJSON, isForbiddenError, useSecretCertExpiry, useTopPodMetrics, useTopNodeMetrics } from '../../api/client'
import { apiUrl, getAuthHeaders, getCredentialsMode, getBasename } from '../../api/config'
import { useAPIResources } from '../../api/apiResources'
import { initNavigationMap } from '@skyhook-io/k8s-ui'
import { usePinnedKinds } from '../../hooks/useFavorites'
import { useOpenLogs, useOpenWorkloadLogs } from '../dock'
import {
  ResourcesView as BaseResourcesView,
  CORE_RESOURCES,
} from '@skyhook-io/k8s-ui'
import type { APIResource, ResourceQueryResult } from '@skyhook-io/k8s-ui'
import type { SelectedResource } from '../../types'
import { kindToPlural, type NavigateToResource } from '../../utils/navigation'
import { CreateResourceDialog } from '../shared/CreateResourceDialog'
import { getSkeletonYaml } from '../../utils/skeleton-yaml'
import { KarpenterDashboard } from './KarpenterDashboard'

interface ResourceCountsResponse {
  counts: Record<string, number>
  forbidden?: string[]
}

interface ResourceColumnSettings {
  visible: string[]
  widths: Record<string, number>
}

interface UserSettingsResponse {
  resourceColumns?: Record<string, ResourceColumnSettings>
}

interface ResourcesViewProps {
  namespaces: string[]
  selectedResource?: SelectedResource | null
  onResourceClick?: (resource: SelectedResource | null) => void
  onResourceClickYaml?: NavigateToResource
  onKindChange?: () => void
}

const RESOURCE_REFRESH_INTERVAL_STORAGE_KEY = 'radar.resourceRefreshIntervalMs'
const RESOURCE_REFRESH_INTERVAL_OPTIONS = [
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '1m' },
  { value: 120000, label: '2m' },
]
const DEFAULT_RESOURCE_REFRESH_INTERVAL_MS = 5000
const KARPENTER_DASHBOARD_RESOURCE: APIResource = {
  group: 'karpenter.sh',
  version: 'v1',
  kind: 'Dashboard',
  name: 'dashboard',
  namespaced: false,
  isCrd: true,
  verbs: ['list'],
}
const TYPED_RESOURCE_NAMES = new Set([
  'pods',
  'services',
  'deployments',
  'daemonsets',
  'statefulsets',
  'replicasets',
  'ingresses',
  'configmaps',
  'secrets',
  'events',
  'persistentvolumeclaims',
  'pvcs',
  'jobs',
  'cronjobs',
  'hpas',
  'horizontalpodautoscalers',
  'nodes',
  'namespaces',
  'persistentvolumes',
  'pvs',
  'storageclasses',
  'sc',
  'poddisruptionbudgets',
  'pdbs',
  'networkpolicies',
  'netpol',
])

function getInitialResourceRefreshInterval(): number {
  if (typeof window === 'undefined') return DEFAULT_RESOURCE_REFRESH_INTERVAL_MS

  const stored = Number(window.localStorage.getItem(RESOURCE_REFRESH_INTERVAL_STORAGE_KEY))
  return RESOURCE_REFRESH_INTERVAL_OPTIONS.some(option => option.value === stored)
    ? stored
    : DEFAULT_RESOURCE_REFRESH_INTERVAL_MS
}

function isKarpenterDashboardKind(kind: { name: string; kind: string; group: string } | null | undefined): boolean {
  return kind?.group === KARPENTER_DASHBOARD_RESOURCE.group && kind?.name === KARPENTER_DASHBOARD_RESOURCE.name
}

export function ResourcesView({ namespaces, selectedResource, onResourceClick, onResourceClickYaml, onKindChange }: ResourcesViewProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const [resourceRefreshIntervalMs, setResourceRefreshIntervalMs] = useState(getInitialResourceRefreshInterval)

  useEffect(() => {
    window.localStorage.setItem(RESOURCE_REFRESH_INTERVAL_STORAGE_KEY, String(resourceRefreshIntervalMs))
  }, [resourceRefreshIntervalMs])

  // API resources discovery
  const { data: apiResources } = useAPIResources()
  const { data: persistedSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => fetchJSON<UserSettingsResponse>('/settings'),
    staleTime: 60000,
  })
  const resourceColumnSettings = persistedSettings?.resourceColumns || {}
  const lastResourceColumnSettingsWrites = useRef<Record<string, string>>({})

  useEffect(() => {
    if (persistedSettings?.resourceColumns) {
      for (const [key, value] of Object.entries(persistedSettings.resourceColumns)) {
        try {
          window.localStorage.setItem(key, JSON.stringify(value))
        } catch {
          // Local cache is best effort; server settings are authoritative.
        }
      }
    }
  }, [persistedSettings?.resourceColumns])

  const persistResourceColumnSettings = useCallback((key: string, settings: ResourceColumnSettings) => {
    const serialized = JSON.stringify(settings)
    if (lastResourceColumnSettingsWrites.current[key] === serialized) return
    lastResourceColumnSettingsWrites.current[key] = serialized
    try {
      window.localStorage.setItem(key, JSON.stringify(settings))
    } catch {
      // Still try the durable backend settings write.
    }
    fetch(apiUrl('/settings'), {
      method: 'PUT',
      credentials: getCredentialsMode(),
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ resourceColumns: { [key]: settings } }),
    }).then(response => {
      if (!response.ok) console.warn('[settings] Failed to persist resource columns:', response.status)
    }).catch(error => console.warn('[settings] Failed to persist resource columns:', error))
  }, [])

  const resourcesWithKarpenterDashboard = useMemo(() => {
    if (!apiResources) return apiResources
    const hasKarpenter = apiResources.some(resource =>
      resource.group === 'karpenter.sh' || resource.group === 'karpenter.k8s.aws',
    )
    const hasDashboard = apiResources.some(resource =>
      resource.group === KARPENTER_DASHBOARD_RESOURCE.group &&
      resource.name === KARPENTER_DASHBOARD_RESOURCE.name &&
      resource.kind === KARPENTER_DASHBOARD_RESOURCE.kind,
    )
    if (!hasKarpenter || hasDashboard) return apiResources
    return [KARPENTER_DASHBOARD_RESOURCE, ...apiResources]
  }, [apiResources])

  // Initialize navigation kind↔plural maps from discovered API resources
  useEffect(() => {
    if (apiResources) initNavigationMap(apiResources)
  }, [apiResources])

  // Track the selected kind from the k8s-ui component
  const [selectedKind, setSelectedKind] = useState<{ name: string; kind: string; group: string } | null>(null)

  // Lightweight resource counts for sidebar badges (~2KB instead of ~608MB)
  const namespacesParam = namespaces.join(',')
  const { data: countsData } = useQuery({
    queryKey: ['resource-counts', namespacesParam],
    queryFn: async () => {
      const params = new URLSearchParams()
      if (namespaces.length > 0) params.set('namespaces', namespacesParam)
      return fetchJSON<ResourceCountsResponse>(`/resource-counts?${params}`)
    },
    staleTime: Math.max(0, resourceRefreshIntervalMs - 1000),
    refetchInterval: resourceRefreshIntervalMs, // Safety net — SSE k8s_event drives near-real-time invalidation
  })

  const shouldSendGroup = useMemo(() => {
    if (!selectedKind || isKarpenterDashboardKind(selectedKind)) return false
    const match = apiResources?.find(r => r.name === selectedKind.name && r.group === selectedKind.group)
      ?? CORE_RESOURCES.find(r => r.name === selectedKind.name && r.group === selectedKind.group)
    return Boolean(selectedKind.group && (match?.isCrd || !TYPED_RESOURCE_NAMES.has(selectedKind.name)))
  }, [selectedKind, apiResources])

  // Fetch full data only for the selected kind
  const selectedKindQuery = useQuery({
    queryKey: ['resources', selectedKind?.name, shouldSendGroup ? selectedKind?.group : '', namespaces],
    queryFn: async () => {
      if (!selectedKind) return []
      if (isKarpenterDashboardKind(selectedKind)) return []
      const params = new URLSearchParams()
      if (namespaces.length > 0) params.set('namespaces', namespacesParam)
      if (shouldSendGroup && selectedKind.group) params.set('group', selectedKind.group)
      const res = await fetch(apiUrl(`/resources/${selectedKind.name}?${params}`), {
        credentials: getCredentialsMode(),
        headers: getAuthHeaders(),
      })
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new ApiError(errorData.error || `Failed to fetch ${selectedKind.name}`, res.status, errorData)
      }
      return res.json()
    },
    enabled: !!selectedKind && !isKarpenterDashboardKind(selectedKind),
    staleTime: Math.max(0, resourceRefreshIntervalMs - 1000),
    refetchInterval: resourceRefreshIntervalMs, // Safety net — SSE k8s_event drives near-real-time invalidation
    retry: (failureCount: number, error: Error) => {
      if (isForbiddenError(error)) return false
      return failureCount < 3
    },
  })

  // Map to ResourceQueryResult shape
  const selectedKindQueryResult: ResourceQueryResult | undefined = useMemo(() => {
    if (!selectedKind) return undefined
    return {
      data: isKarpenterDashboardKind(selectedKind) ? [] : selectedKindQuery.data as any[] | undefined,
      isLoading: isKarpenterDashboardKind(selectedKind) ? false : selectedKindQuery.isLoading,
      error: selectedKindQuery.error,
      refetch: selectedKindQuery.refetch,
      dataUpdatedAt: selectedKindQuery.dataUpdatedAt,
    }
  }, [selectedKind, selectedKindQuery.data, selectedKindQuery.isLoading, selectedKindQuery.error, selectedKindQuery.refetch, selectedKindQuery.dataUpdatedAt])

  // Metrics
  const { data: topPodMetrics } = useTopPodMetrics(resourceRefreshIntervalMs)
  const { data: topNodeMetrics } = useTopNodeMetrics(resourceRefreshIntervalMs)

  // Certificate expiry
  const { data: certExpiry, isError: certExpiryError } = useSecretCertExpiry()

  // Pinned kinds
  const { pinned, togglePin, isPinned } = usePinnedKinds()

  // Dock actions
  const openLogs = useOpenLogs()
  const openWorkloadLogs = useOpenWorkloadLogs()

  // Navigation adapter. k8s-ui constructs paths from `basePath` (which
  // includes the router basename so they line up with window.location.pathname
  // for path-equality checks) and from `window.location.pathname` directly.
  // React Router's navigate() applies the basename itself, so handing it a
  // path that already contains the basename double-prefixes it
  // (e.g. /c/abc/c/abc/resources/pods). Under that URL, getViewFromPath()
  // sees 'c' as the first segment and falls through to 'home' — which
  // manifests as "click a resource → bounced to the home dashboard" in
  // any host that mounts RadarApp under a non-empty basename (Radar Cloud).
  // Strip the basename here so react-router can re-apply it cleanly.
  const handleNavigate = useMemo(() => {
    const base = getBasename()
    return (path: string, options?: { replace?: boolean }) => {
      let p = path
      if (base && (p === base || p.startsWith(base + '/') || p.startsWith(base + '?'))) {
        p = p.slice(base.length) || '/'
      }
      navigate(p, { replace: options?.replace })
    }
  }, [navigate])

  // Create resource dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createDialogYaml, setCreateDialogYaml] = useState('')
  const [createDialogTitle, setCreateDialogTitle] = useState<string | undefined>()

  const handleCreateResource = useCallback((kind: { name: string; kind: string; group: string } | null) => {
    if (kind?.kind) {
      setCreateDialogYaml(getSkeletonYaml(kind.kind, kind.group))
      setCreateDialogTitle(`Create ${kind.kind}`)
    } else {
      setCreateDialogYaml('')
      setCreateDialogTitle(undefined)
    }
    setCreateDialogOpen(true)
  }, [])

  return (
    <>
    <BaseResourcesView
      namespaces={namespaces}
      selectedResource={selectedResource}
      onResourceClick={onResourceClick}
      onResourceClickYaml={onResourceClickYaml}
      onKindChange={onKindChange}
      // Injected data
      apiResources={resourcesWithKarpenterDashboard}
      // Lightweight counts for sidebar (replaces 233 parallel queries)
      resourceCounts={{
        ...(countsData?.counts || {}),
        'karpenter.sh/Dashboard': resourcesWithKarpenterDashboard?.some(resource => resource === KARPENTER_DASHBOARD_RESOURCE) ? 1 : 0,
      }}
      resourceForbidden={countsData?.forbidden}
      selectedKindQuery={selectedKindQueryResult}
      onSelectedKindChange={setSelectedKind}
      topPodMetrics={topPodMetrics}
      topNodeMetrics={topNodeMetrics}
      certExpiry={certExpiry}
      certExpiryError={certExpiryError}
      // Pinned kinds
      pinned={pinned}
      togglePin={togglePin}
      isPinned={(kind: string, group?: string) => isPinned(kind, group ?? '')}
      // Navigation. basePath is basename-relative. React Router's useLocation
      // strips the basename from `location.pathname`, so reading the current
      // kind compares basename-relative paths on both sides. URL writes go
      // through `handleNavigate`, which strips any leading basename before
      // handing off to react-router (which re-applies it). Embedding hosts
      // (e.g. Radar Cloud at /c/{cluster}/resources) work without ResourcesView
      // needing to know the basename.
      basePath="/resources"
      locationSearch={location.search}
      locationPathname={location.pathname}
      onNavigate={handleNavigate}
      // Dock actions
      onOpenLogs={openLogs}
      onOpenWorkloadLogs={openWorkloadLogs}
      // Create resource
      onCreateResource={handleCreateResource}
      refreshIntervalMs={resourceRefreshIntervalMs}
      refreshIntervalOptions={RESOURCE_REFRESH_INTERVAL_OPTIONS}
      onRefreshIntervalChange={setResourceRefreshIntervalMs}
      renderCustomKindContent={(kind) => isKarpenterDashboardKind(kind) ? <KarpenterDashboard /> : null}
      resourceColumnSettings={resourceColumnSettings}
      onResourceColumnSettingsChange={persistResourceColumnSettings}
    />
    <CreateResourceDialog
      open={createDialogOpen}
      onClose={() => setCreateDialogOpen(false)}
      initialYaml={createDialogYaml}
      title={createDialogTitle}
      onCreated={(result) => {
        onResourceClick?.({ kind: kindToPlural(result.kind), namespace: result.namespace, name: result.name, group: '' })
      }}
    />
    </>
  )
}
