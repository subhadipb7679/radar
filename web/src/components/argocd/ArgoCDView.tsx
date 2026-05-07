import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Server,
  XCircle,
} from 'lucide-react'
import {
  fetchJSON,
  useContexts,
  useTopology,
  useArgoRefresh,
  useArgoResume,
  useArgoSuspend,
  useArgoSync,
  useArgoTerminate,
} from '../../api/client'
import type { ArgoSyncOptions } from '../../api/client'
import { formatAge } from '../resources/resource-utils'
import {
  getArgoApplicationHealth,
  getArgoApplicationRepo,
  getArgoApplicationStatus,
  getArgoApplicationSync,
} from '../resources/resource-utils-argo'
import { routePath } from '../../api/config'
import type { ContextInfo, SelectedResource } from '../../types'

interface ArgoNavigateOptions {
  contextName?: string
}

interface ArgoCDViewProps {
  namespaces: string[]
  onNavigateToResource: (resource: SelectedResource, options?: ArgoNavigateOptions) => void
}

interface StatCardProps {
  label: string
  value: number
  tone: 'healthy' | 'warning' | 'danger' | 'neutral' | 'info'
}

interface ArgoCDAdminResponse {
  contextName: string
  currentContext: string
  applications: any[]
  applicationSets: any[]
  appProjects: any[]
  availableContexts: string[]
  errors?: Record<string, string>
}

interface ArgoDestinationPodsResponse {
  contextName: string
  namespace: string
  pods: any[]
}

const ARGO_GROUP = 'argoproj.io'
const ARGO_VIEW_STATE_STORAGE_KEY = 'radar-argocd-view-state'

interface ArgoViewState {
  search: string
  projectFilter: string
  selectedKey: string | null
}

function ArgoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <path d="M12 3v4.2M12 16.8V21M3 12h4.2M16.8 12H21M5.6 5.6l3 3M15.4 15.4l3 3M18.4 5.6l-3 3M8.6 15.4l-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function buildResourcesPath(kind: string, namespaces: string[]) {
  const params = new URLSearchParams()
  params.set('apiGroup', ARGO_GROUP)
  if (namespaces.length > 0) params.set('namespaces', namespaces.join(','))
  return `/resources/${kind}?${params.toString()}`
}

function getAppName(app: any) {
  return app.metadata?.name || ''
}

function getAppNamespace(app: any) {
  return app.metadata?.namespace || ''
}

function getProject(app: any) {
  return app.spec?.project || 'default'
}

function getDestination(app: any) {
  const destination = app.spec?.destination || {}
  return destination.namespace || destination.name || destination.server || 'default'
}

function getDestinationNamespace(app: any) {
  return app?.spec?.destination?.namespace ||
    app?.status?.resources?.find((resource: any) => resource.namespace)?.namespace ||
    'default'
}

function getDestinationCluster(app: any) {
  const destination = app.spec?.destination || {}
  return destination.name || destination.server || 'in-cluster'
}

function normalizeServerURL(value?: string) {
  return String(value || '').replace(/\/+$/, '').toLowerCase()
}

function resolveDestinationContext(app: any, contexts: ContextInfo[] = []) {
  const destination = app?.spec?.destination || {}
  const destinationName = String(destination.name || '').toLowerCase()
  const destinationServer = normalizeServerURL(destination.server)

  if (destinationName) {
    const byName = contexts.find(ctx =>
      ctx.name.toLowerCase() === destinationName ||
      ctx.cluster.toLowerCase() === destinationName ||
      ctx.name.toLowerCase().endsWith(`/${destinationName}`) ||
      ctx.name.toLowerCase().endsWith(`:${destinationName}`)
    )
    if (byName) return byName.name
  }

  if (destinationServer) {
    const byServer = contexts.find(ctx => normalizeServerURL(ctx.server) === destinationServer)
    if (byServer) return byServer.name
  }

  return undefined
}

function getOperationPhase(app: any) {
  return app.status?.operationState?.phase || ''
}

function getSyncRevision(app: any) {
  return app.spec?.source?.targetRevision || app.spec?.sources?.[0]?.targetRevision || app.status?.sync?.revision || ''
}

function getLastReconciled(app: any) {
  return app.status?.reconciledAt || app.status?.operationState?.finishedAt || app.metadata?.creationTimestamp
}

function isSuspended(app: any) {
  const annotations = app.metadata?.annotations || {}
  return !app.spec?.syncPolicy?.automated && (
    annotations['radarhq.io/suspended-prune'] !== undefined ||
    annotations['skyhook.io/suspended-prune'] !== undefined
  )
}

function summarize(applications: any[]) {
  return {
    total: applications.length,
    synced: applications.filter(app => app.status?.sync?.status === 'Synced').length,
    outOfSync: applications.filter(app => app.status?.sync?.status === 'OutOfSync').length,
    healthy: applications.filter(app => app.status?.health?.status === 'Healthy').length,
    degraded: applications.filter(app => ['Degraded', 'Missing'].includes(app.status?.health?.status)).length,
    syncing: applications.filter(app => getOperationPhase(app) === 'Running').length,
  }
}

interface ProjectRow {
  name: string
  appCount: number
  namespace?: string
  description?: string
}

function buildProjectRows(applications: any[], appProjects: any[]) {
  const rows = new Map<string, ProjectRow>()
  for (const app of applications) {
    const name = getProject(app)
    const current: ProjectRow = rows.get(name) || { name, appCount: 0 }
    current.appCount += 1
    rows.set(name, current)
  }
  for (const project of appProjects) {
    const name = project.metadata?.name
    if (!name) continue
    const current: ProjectRow = rows.get(name) || { name, appCount: 0 }
    current.namespace = project.metadata?.namespace
    current.description = project.spec?.description
    rows.set(name, current)
  }
  return Array.from(rows.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function appManagedResourcesFromTopology(topology: any, app: any) {
  if (!topology || !app) return []
  const appID = `application/${getAppNamespace(app)}/${getAppName(app)}`
  const nodeByID = new Map((topology.nodes || []).map((node: any) => [node.id, node]))
  const roots = new Set<string>()
  const appResourceNames = new Set<string>()

  if (nodeByID.has(appID)) roots.add(appID)

  for (const resource of app.status?.resources || []) {
    if (resource.name) appResourceNames.add(String(resource.name))
    for (const node of topology.nodes || []) {
      const data = node.data || {}
      if (
        node.kind === resource.kind &&
        node.name === resource.name &&
        (data.namespace || '') === (resource.namespace || '')
      ) {
        roots.add(node.id)
      }
    }
  }

  const neighborsByID = new Map<string, string[]>()
  for (const edge of topology.edges || []) {
    neighborsByID.set(edge.source, [...(neighborsByID.get(edge.source) || []), edge.target])
    neighborsByID.set(edge.target, [...(neighborsByID.get(edge.target) || []), edge.source])
  }

  const visited = new Set<string>()
  const queue = Array.from(roots)
  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of neighborsByID.get(id) || []) {
      if (!visited.has(next)) queue.push(next)
    }
  }

  return Array.from(visited)
    .map(id => nodeByID.get(id))
    .filter((node: any) => node && !['Application', 'Internet', 'Namespace'].includes(node.kind))
    .concat(matchAppPodGroups(topology.nodes || [], appResourceNames))
}

function matchAppPodGroups(nodes: any[], resourceNames: Set<string>) {
  const syntheticGroups: any[] = []
  const workloads = Array.from(resourceNames).sort((a, b) => b.length - a.length)
  if (workloads.length === 0) return syntheticGroups

  for (const node of nodes) {
    if (node.kind !== 'PodGroup') continue
    const data = node.data || {}
    const pods = Array.isArray(data.pods) ? data.pods : []
    for (const workloadName of workloads) {
      const matchingPods = pods.filter((pod: any) => String(pod.name || '').startsWith(`${workloadName}-`))
      if (matchingPods.length === 0) continue
      syntheticGroups.push({
        ...node,
        id: `argocd-podgroup/${data.namespace || ''}/${workloadName}`,
        name: workloadName,
        data: {
          ...data,
          podCount: matchingPods.length,
          pods: matchingPods,
          ownerKind: 'Deployment',
        },
      })
    }
  }

  return syntheticGroups
}

function appResourceNames(app: any): string[] {
  return Array.from(new Set<string>(
    (app?.status?.resources || [])
      .map((resource: any) => String(resource.name || ''))
      .filter(Boolean),
  ))
}

function podGroupsFromDestinationPods(response: ArgoDestinationPodsResponse | undefined, resourceNames: string[]) {
  if (!response?.pods?.length || resourceNames.length === 0) return []
  const workloads = [...resourceNames].sort((a, b) => b.length - a.length)
  return workloads.flatMap(workloadName => {
    const matchingPods = response.pods.filter((pod: any) => String(pod.name || '').startsWith(`${workloadName}-`))
    if (matchingPods.length === 0) return []
    const healthy = matchingPods.every((pod: any) => pod.phase === 'Running')
    return [{
      kind: 'PodGroup',
      name: workloadName,
      namespace: response.namespace,
      status: 'Managed',
      health: { status: healthy ? 'Healthy' : 'Degraded' },
      group: '',
      version: 'v1',
      podCount: matchingPods.length,
      pods: matchingPods,
    }]
  })
}

function normalizeResourceFromTopology(node: any) {
  const data = node?.data || {}
  return {
    kind: node.kind,
    name: node.name,
    namespace: data.namespace || '',
    status: data.syncStatus || 'Managed',
    health: { status: node.status === 'healthy' ? 'Healthy' : node.status === 'unhealthy' ? 'Degraded' : node.status || 'Unknown' },
    group: data.apiGroup || '',
    version: data.apiVersion || '',
    podCount: data.podCount,
    pods: data.pods,
  }
}

function resourceID(resource: any) {
  return `${resource.kind}/${resource.namespace || '_'}/${resource.name}`.toLowerCase()
}

function kindLower(resource: any) {
  return String(resource.kind || '').toLowerCase()
}

function resourceToNavigationTarget(resource: any): SelectedResource | null {
  if (kindLower(resource) === 'podgroup') {
    const pods = Array.isArray(resource.pods) ? resource.pods : []
    const pod = pods.find((item: any) => item?.name)
    if (!pod) return null
    return {
      kind: 'Pod',
      namespace: pod.namespace || resource.namespace || '',
      name: pod.name,
      group: '',
    }
  }

  return {
    kind: resource.kind,
    namespace: resource.namespace || '',
    name: resource.name,
    group: resource.group || '',
  }
}

function hasNameAffinity(parent: any, child: any) {
  if ((parent.namespace || '') !== (child.namespace || '')) return false
  const parentName = String(parent.name || '').toLowerCase()
  const childName = String(child.name || '').toLowerCase()
  return parentName === childName || parentName.startsWith(childName) || childName.startsWith(parentName)
}

function findRelated(resources: any[], child: any, parentKinds: string[]) {
  const sameKind = resources.filter(resource => parentKinds.includes(kindLower(resource)) && resourceID(resource) !== resourceID(child))
  return sameKind.find(resource => hasNameAffinity(resource, child)) ||
    sameKind.find(resource => (resource.namespace || '') === (child.namespace || ''))
}

function inferResourceParent(resources: any[], resource: any) {
  const kind = kindLower(resource)

  if (['endpoints', 'endpointslice', 'endpointslices'].includes(kind)) {
    return findRelated(resources, resource, ['service'])
  }
  if (['deployment', 'statefulset', 'daemonset', 'rollout', 'job', 'cronjob'].includes(kind)) {
    return findRelated(resources, resource, ['service']) || findRelated(resources, resource, ['ingress', 'httproute', 'virtualservice'])
  }
  if (['replicaset', 'pod', 'podgroup'].includes(kind)) {
    return findRelated(resources, resource, ['deployment', 'statefulset', 'daemonset', 'rollout', 'job'])
  }
  if (['serviceaccount', 'configmap', 'secret'].includes(kind)) {
    return findRelated(resources, resource, ['deployment', 'statefulset', 'daemonset', 'rollout', 'job', 'cronjob', 'externalsecret'])
  }
  if (['horizontalpodautoscaler', 'hpa', 'poddisruptionbudget', 'pdb', 'networkpolicy'].includes(kind)) {
    return findRelated(resources, resource, ['deployment', 'statefulset', 'daemonset', 'rollout'])
  }
  if (['service'].includes(kind)) {
    return findRelated(resources, resource, ['ingress', 'httproute', 'virtualservice', 'gateway'])
  }

  return null
}

function buildResourceTree(resources: any[]) {
  const deduped = Array.from(new Map(resources.map(resource => [resourceID(resource), resource])).values())
  const visible = deduped.slice(0, 32)
  const visibleIDs = new Set(visible.map(resourceID))
  const edges: Array<{ source: string; target: string }> = []
  const incoming = new Set<string>()

  for (const resource of visible) {
    const parent = inferResourceParent(visible, resource)
    if (!parent) continue
    const source = resourceID(parent)
    const target = resourceID(resource)
    if (!visibleIDs.has(source) || source === target) continue
    edges.push({ source, target })
    incoming.add(target)
  }

  for (const resource of visible) {
    const id = resourceID(resource)
    if (!incoming.has(id)) {
      edges.push({ source: 'app', target: id })
    }
  }

  const childrenBySource = new Map<string, string[]>()
  for (const edge of edges) {
    childrenBySource.set(edge.source, [...(childrenBySource.get(edge.source) || []), edge.target])
  }

  const resourceByID = new Map(visible.map(resource => [resourceID(resource), resource]))
  const podCountsByID = new Map<string, number>()
  for (const resource of visible) {
    const id = resourceID(resource)
    const queue = [...(childrenBySource.get(id) || [])]
    const seen = new Set<string>()
    let count = 0
    while (queue.length > 0) {
      const childID = queue.shift()!
      if (seen.has(childID)) continue
      seen.add(childID)
      const child = resourceByID.get(childID)
      if (child && kindLower(child) === 'pod') count += 1
      if (child && kindLower(child) === 'podgroup') count += Number(child.podCount || child.pods?.length || 0)
      queue.push(...(childrenBySource.get(childID) || []))
    }
    if (count > 0) podCountsByID.set(id, count)
  }

  return { resources: visible, edges, podCountsByID, remaining: Math.max(0, deduped.length - visible.length) }
}

function StatCard({ label, value, tone }: StatCardProps) {
  const toneClass = {
    healthy: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
    warning: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
    danger: 'text-red-500 bg-red-500/10 border-red-500/20',
    neutral: 'text-theme-text-secondary bg-theme-surface border-theme-border',
    info: 'text-sky-500 bg-sky-500/10 border-sky-500/20',
  }[tone]

  return (
    <div className={clsx('rounded-xl border p-3', toneClass)}>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs font-medium opacity-80">{label}</div>
    </div>
  )
}

function StatusBadge({ text, color }: { text: string; color: string }) {
  return <span className={clsx('badge whitespace-nowrap', color)}>{text}</span>
}

function defaultSyncOptions(app: any): ArgoSyncOptions {
  return {
    revision: getSyncRevision(app),
    prune: true,
    dryRun: false,
    applyOnly: false,
    force: false,
    skipSchemaValidation: false,
    autoCreateNamespace: true,
    pruneLast: true,
    applyOutOfSyncOnly: false,
    respectIgnoreDifferences: false,
    serverSideApply: false,
    prunePropagationPolicy: 'foreground',
    replace: false,
  }
}

function getInitialArgoViewState(): ArgoViewState {
  if (typeof window === 'undefined') {
    return { search: '', projectFilter: 'all', selectedKey: null }
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(ARGO_VIEW_STATE_STORAGE_KEY) || '{}')
    return {
      search: typeof parsed.search === 'string' ? parsed.search : '',
      projectFilter: typeof parsed.projectFilter === 'string' && parsed.projectFilter ? parsed.projectFilter : 'all',
      selectedKey: typeof parsed.selectedKey === 'string' ? parsed.selectedKey : null,
    }
  } catch {
    return { search: '', projectFilter: 'all', selectedKey: null }
  }
}

export function ArgoCDView({ namespaces, onNavigateToResource }: ArgoCDViewProps) {
  const [viewState, setViewState] = useState(getInitialArgoViewState)
  const { search, projectFilter, selectedKey } = viewState
  const [syncDialogApp, setSyncDialogApp] = useState<any | null>(null)
  const [syncOptions, setSyncOptions] = useState<ArgoSyncOptions | null>(null)

  const adminQuery = useQuery<ArgoCDAdminResponse>({
    queryKey: ['argocd', 'admin-resources'],
    queryFn: () => fetchJSON('/argocd/resources'),
    staleTime: 5000,
    refetchInterval: 15000,
  })
  const { data: contexts } = useContexts()
  const topologyQuery = useTopology(namespaces, 'resources')

  const syncMutation = useArgoSync()
  const refreshMutation = useArgoRefresh()
  const suspendMutation = useArgoSuspend()
  const resumeMutation = useArgoResume()
  const terminateMutation = useArgoTerminate()

  const applications = adminQuery.data?.applications || []
  const appSets = adminQuery.data?.applicationSets || []
  const projects = adminQuery.data?.appProjects || []
  const stats = useMemo(() => summarize(applications), [applications])
  const projectRows = useMemo(() => buildProjectRows(applications, projects), [applications, projects])

  useEffect(() => {
    try {
      window.localStorage.setItem(ARGO_VIEW_STATE_STORAGE_KEY, JSON.stringify(viewState))
    } catch {
      // Ignore unavailable storage.
    }
  }, [viewState])

  useEffect(() => {
    if (!adminQuery.data || projectRows.length === 0) return
    if (projectFilter === 'all') return
    if (projectRows.some(project => project.name === projectFilter)) return
    setViewState(current => ({ ...current, projectFilter: 'all' }))
  }, [adminQuery.data, projectFilter, projectRows])

  useEffect(() => {
    if (!adminQuery.data || !selectedKey) return
    if (applications.some(app => `${getAppNamespace(app)}/${getAppName(app)}` === selectedKey)) return
    setViewState(current => ({ ...current, selectedKey: null }))
  }, [adminQuery.data, applications, selectedKey])

  const filteredApps = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return applications
      .filter(app => projectFilter === 'all' || getProject(app) === projectFilter)
      .filter(app => {
        if (!needle) return true
        return [
          getAppName(app),
          getAppNamespace(app),
          getProject(app),
          getArgoApplicationRepo(app),
          getDestination(app),
        ].some(value => String(value).toLowerCase().includes(needle))
      })
      .sort((a, b) => {
        const aScore = (a.status?.health?.status === 'Degraded' ? 0 : a.status?.sync?.status === 'OutOfSync' ? 1 : 2)
        const bScore = (b.status?.health?.status === 'Degraded' ? 0 : b.status?.sync?.status === 'OutOfSync' ? 1 : 2)
        return aScore - bScore || getAppName(a).localeCompare(getAppName(b))
      })
  }, [applications, projectFilter, search])

  const selectedApp = useMemo(() => {
    if (!filteredApps.length) return null
    return filteredApps.find(app => `${getAppNamespace(app)}/${getAppName(app)}` === selectedKey) || filteredApps[0]
  }, [filteredApps, selectedKey])

  const refetchApps = () => {
    adminQuery.refetch()
    topologyQuery.refetch()
  }

  const runAppMutation = (
    mutation: any,
    app: any,
    vars?: Record<string, unknown>,
  ) => {
    mutation.mutate(
      { namespace: getAppNamespace(app), name: getAppName(app), contextName: adminQuery.data?.contextName, ...vars } as any,
      { onSettled: refetchApps },
    )
  }
  const openSyncDialog = (app: any) => {
    setSyncDialogApp(app)
    setSyncOptions(defaultSyncOptions(app))
  }
  const submitSync = () => {
    if (!syncDialogApp || !syncOptions) return
    runAppMutation(syncMutation, syncDialogApp, syncOptions)
    setSyncDialogApp(null)
  }

  const isLoading = adminQuery.isLoading
  const selectedSync = selectedApp ? getArgoApplicationSync(selectedApp) : null
  const selectedHealth = selectedApp ? getArgoApplicationHealth(selectedApp) : null
  const selectedStatus = selectedApp ? getArgoApplicationStatus(selectedApp) : null
  const selectedDestinationContext = useMemo(
    () => resolveDestinationContext(selectedApp, contexts),
    [selectedApp, contexts],
  )
  const selectedDestinationNamespace = selectedApp ? getDestinationNamespace(selectedApp) : ''
  const selectedAppResourceNames = useMemo(() => appResourceNames(selectedApp), [selectedApp])
  const destinationPodsQuery = useQuery<ArgoDestinationPodsResponse>({
    queryKey: ['argocd', 'destination-pods', selectedDestinationContext, selectedDestinationNamespace, selectedAppResourceNames],
    queryFn: () => {
      const params = new URLSearchParams()
      if (selectedDestinationContext) params.set('context', selectedDestinationContext)
      params.set('namespace', selectedDestinationNamespace)
      if (selectedAppResourceNames.length > 0) params.set('workloads', selectedAppResourceNames.join(','))
      return fetchJSON(`/argocd/destination-pods?${params.toString()}`)
    },
    staleTime: 5000,
    enabled: Boolean(selectedApp && selectedDestinationNamespace),
  })
  const topologyManagedResources = useMemo(
    () => appManagedResourcesFromTopology(topologyQuery.data, selectedApp).map(normalizeResourceFromTopology),
    [topologyQuery.data, selectedApp],
  )
  const destinationPodGroups = useMemo(
    () => podGroupsFromDestinationPods(destinationPodsQuery.data, selectedAppResourceNames),
    [destinationPodsQuery.data, selectedAppResourceNames],
  )
  const selectedResources = useMemo(() => {
    const merged = new Map<string, any>()
    for (const resource of selectedApp?.status?.resources || []) {
      merged.set(resourceID(resource), resource)
    }
    for (const resource of [...topologyManagedResources, ...destinationPodGroups]) {
      const id = resourceID(resource)
      const existing = merged.get(id)
      merged.set(id, existing
        ? {
            ...resource,
            ...existing,
            group: existing.group || resource.group,
            version: existing.version || resource.version,
            health: existing.health || resource.health,
            podCount: resource.podCount ?? existing.podCount,
            pods: resource.pods ?? existing.pods,
          }
        : resource)
    }
    return Array.from(merged.values())
  }, [selectedApp, topologyManagedResources, destinationPodGroups])
  const selectedSources = selectedApp ? (selectedApp.spec?.sources?.length ? selectedApp.spec.sources : selectedApp.spec?.source ? [selectedApp.spec.source] : []) : []

  return (
    <div className="flex-1 min-w-0 bg-theme-base overflow-hidden flex flex-col">
      <div className="shrink-0 border-b border-theme-border bg-theme-surface/60">
        <div className="px-5 py-4 flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 text-orange-500 flex items-center justify-center">
              <ArgoIcon className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-theme-text-primary">ArgoCD</h1>
              <p className="text-sm text-theme-text-secondary">
                Global admin view from {adminQuery.data?.contextName || 'admin cluster'}. Resource clicks switch to the Application destination cluster.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={routePath(buildResourcesPath('applications', namespaces))}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated"
            >
              Resources
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={refetchApps}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
        <div className="px-5 pb-4 grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard label="Applications" value={stats.total} tone="neutral" />
          <StatCard label="Healthy" value={stats.healthy} tone="healthy" />
          <StatCard label="Synced" value={stats.synced} tone="healthy" />
          <StatCard label="Out Of Sync" value={stats.outOfSync} tone="warning" />
          <StatCard label="Degraded" value={stats.degraded} tone="danger" />
          <StatCard label="Syncing" value={stats.syncing} tone="info" />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="w-[440px] shrink-0 border-r border-theme-border bg-theme-surface/40 flex flex-col min-h-0">
          <div className="p-3 border-b border-theme-border space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-theme-elevated border border-theme-border p-2">
                <div className="flex items-center gap-1.5 text-xs text-theme-text-tertiary">
                  <Boxes className="w-3.5 h-3.5" /> ApplicationSets
                </div>
                <div className="text-lg font-semibold text-theme-text-primary">{appSets.length}</div>
              </div>
              <div className="rounded-lg bg-theme-elevated border border-theme-border p-2">
                <div className="flex items-center gap-1.5 text-xs text-theme-text-tertiary">
                  <FolderGit2 className="w-3.5 h-3.5" /> Projects
                </div>
                <div className="text-lg font-semibold text-theme-text-primary">{projectRows.length}</div>
              </div>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-tertiary" />
              <input
                value={search}
                onChange={(event) => setViewState(current => ({ ...current, search: event.target.value }))}
                placeholder="Search apps, repos, destinations..."
                className="w-full pl-8 pr-3 py-2 rounded-lg bg-theme-base border border-theme-border text-sm text-theme-text-primary placeholder:text-theme-text-tertiary focus:outline-none focus:ring-1 focus:ring-skyhook-500"
              />
            </div>
            <div className="rounded-lg bg-theme-base border border-theme-border overflow-hidden">
              <button
                onClick={() => setViewState(current => ({ ...current, projectFilter: 'all' }))}
                className={clsx(
                  'w-full flex items-center justify-between px-3 py-2 text-sm border-b border-theme-border',
                  projectFilter === 'all' ? 'bg-skyhook-500/10 text-theme-text-primary' : 'text-theme-text-secondary hover:bg-theme-hover'
                )}
              >
                <span>All projects</span>
                <span className="text-xs text-theme-text-tertiary">{applications.length}</span>
              </button>
              <div className="max-h-36 overflow-y-auto">
                {projectRows.map(project => (
                  <button
                    key={project.name}
                    onClick={() => setViewState(current => ({ ...current, projectFilter: project.name }))}
                    className={clsx(
                      'w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-left',
                      projectFilter === project.name ? 'bg-skyhook-500/10 text-theme-text-primary' : 'text-theme-text-secondary hover:bg-theme-hover'
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{project.name}</span>
                      {project.description && <span className="block text-[11px] text-theme-text-tertiary truncate">{project.description}</span>}
                    </span>
                    <span className="text-xs text-theme-text-tertiary tabular-nums">{project.appCount}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {isLoading ? (
              <div className="h-full flex items-center justify-center text-theme-text-tertiary">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                Loading ArgoCD applications...
              </div>
            ) : adminQuery.error ? (
              <div className="m-4 p-4 rounded-xl border border-red-500/20 bg-red-500/10 text-red-500 text-sm">
                Failed to load ArgoCD Applications from the admin cluster: {(adminQuery.error as Error).message}
              </div>
            ) : filteredApps.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-theme-text-tertiary px-8 text-center">
                <ArgoIcon className="w-10 h-10 mb-3 opacity-50" />
                <p className="text-sm">No ArgoCD Applications match this view.</p>
              </div>
            ) : filteredApps.map(app => {
              const key = `${getAppNamespace(app)}/${getAppName(app)}`
              const sync = getArgoApplicationSync(app)
              const health = getArgoApplicationHealth(app)
              const operation = getOperationPhase(app)
              return (
                <button
                  key={key}
                  onClick={() => setViewState(current => ({ ...current, selectedKey: key }))}
                  className={clsx(
                    'w-full text-left px-4 py-3 border-b border-theme-border/70 hover:bg-theme-hover transition-colors',
                    selectedApp === app && 'bg-skyhook-500/10'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-theme-text-primary truncate">{getAppName(app)}</div>
                      <div className="text-xs text-theme-text-tertiary mt-0.5">
                        {getAppNamespace(app)} / {getProject(app)}
                      </div>
                    </div>
                    {operation === 'Running' ? (
                      <StatusBadge text="Syncing" color="bg-sky-500/20 text-sky-500" />
                    ) : (
                      <StatusBadge text={sync.status} color={sync.color} />
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <StatusBadge text={health.status} color={health.color} />
                    <span className="text-xs text-theme-text-tertiary truncate">{getArgoApplicationRepo(app)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto">
          {!selectedApp ? (
            <div className="h-full flex items-center justify-center text-theme-text-tertiary">
              Select an Application to inspect.
            </div>
          ) : (
            <div className="p-5 space-y-4">
              <div className="rounded-xl border border-theme-border bg-theme-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <ArgoIcon className="w-5 h-5 text-orange-500" />
                      <h2 className="text-xl font-semibold text-theme-text-primary truncate">{getAppName(selectedApp)}</h2>
                    </div>
                    <div className="text-sm text-theme-text-secondary">
                      {getAppNamespace(selectedApp)} / project {getProject(selectedApp)}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {selectedSync && <StatusBadge text={selectedSync.status} color={selectedSync.color} />}
                    {selectedHealth && <StatusBadge text={selectedHealth.status} color={selectedHealth.color} />}
                    {selectedStatus?.text === 'Suspended' && <StatusBadge text="Suspended" color="bg-amber-500/20 text-amber-500" />}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => openSyncDialog(selectedApp)}
                    disabled={syncMutation.isPending || isSuspended(selectedApp)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm btn-brand disabled:opacity-50"
                  >
                    {syncMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Sync
                  </button>
                  <button
                    onClick={() => runAppMutation(refreshMutation as any, selectedApp)}
                    disabled={refreshMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated disabled:opacity-50"
                  >
                    {refreshMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Refresh
                  </button>
                  <button
                    onClick={() => runAppMutation(refreshMutation as any, selectedApp, { hard: true })}
                    disabled={refreshMutation.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated disabled:opacity-50"
                  >
                    Hard refresh
                  </button>
                  {isSuspended(selectedApp) ? (
                    <button
                      onClick={() => runAppMutation(resumeMutation, selectedApp)}
                      disabled={resumeMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      {resumeMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      Resume auto-sync
                    </button>
                  ) : (
                    <button
                      onClick={() => runAppMutation(suspendMutation, selectedApp)}
                      disabled={suspendMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 disabled:opacity-50"
                    >
                      {suspendMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pause className="w-3.5 h-3.5" />}
                      Suspend auto-sync
                    </button>
                  )}
                  {getOperationPhase(selectedApp) === 'Running' && (
                    <button
                      onClick={() => runAppMutation(terminateMutation, selectedApp)}
                      disabled={terminateMutation.isPending}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-red-500/15 text-red-500 hover:bg-red-500/25 disabled:opacity-50"
                    >
                      {terminateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <XCircle className="w-3.5 h-3.5" />}
                      Terminate
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <section className="rounded-xl border border-theme-border bg-theme-surface p-4">
                  <h3 className="text-sm font-semibold text-theme-text-primary mb-3 flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-theme-text-tertiary" />
                    Source
                  </h3>
                  <div className="space-y-2 text-sm">
                    {selectedSources.length === 0 ? (
                      <div className="text-theme-text-tertiary">No source configured</div>
                    ) : selectedSources.map((source: any, index: number) => (
                      <div key={index} className="rounded-lg bg-theme-elevated border border-theme-border p-3 space-y-1">
                        <div className="font-medium text-theme-text-primary truncate">{source.repoURL || '-'}</div>
                        <div className="text-xs text-theme-text-tertiary">
                          {source.path || source.chart || 'root'} @ {source.targetRevision || 'HEAD'}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="rounded-xl border border-theme-border bg-theme-surface p-4">
                  <h3 className="text-sm font-semibold text-theme-text-primary mb-3 flex items-center gap-2">
                    <Server className="w-4 h-4 text-theme-text-tertiary" />
                    Destination
                  </h3>
                  <div className="space-y-2 text-sm">
                    <Row label="Cluster" value={selectedApp.spec?.destination?.name || selectedApp.spec?.destination?.server || '-'} />
                    <Row label="Namespace" value={selectedApp.spec?.destination?.namespace || 'default'} />
                    <Row label="Last reconciled" value={getLastReconciled(selectedApp) ? `${formatAge(getLastReconciled(selectedApp))} ago` : '-'} />
                  </div>
                </section>

                <section className="rounded-xl border border-theme-border bg-theme-surface p-4">
                  <h3 className="text-sm font-semibold text-theme-text-primary mb-3 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-theme-text-tertiary" />
                    Sync Policy
                  </h3>
                  <div className="space-y-2 text-sm">
                    <Row label="Automated" value={selectedApp.spec?.syncPolicy?.automated ? 'Enabled' : 'Disabled'} />
                    <Row label="Prune" value={selectedApp.spec?.syncPolicy?.automated?.prune ? 'Yes' : 'No'} />
                    <Row label="Self heal" value={selectedApp.spec?.syncPolicy?.automated?.selfHeal ? 'Yes' : 'No'} />
                  </div>
                </section>
              </div>

              {selectedApp.status?.conditions?.length > 0 && (
                <section className="rounded-xl border border-theme-border bg-theme-surface p-4">
                  <h3 className="text-sm font-semibold text-theme-text-primary mb-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    Conditions
                  </h3>
                  <div className="space-y-2">
                    {selectedApp.status.conditions.map((condition: any, index: number) => (
                      <div key={index} className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
                        <div className="text-sm font-medium text-theme-text-primary">{condition.type}</div>
                        <div className="text-xs text-theme-text-secondary mt-1">{condition.message || condition.status}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <ResourceMap
                app={selectedApp}
                sources={selectedSources}
                resources={selectedResources}
                destinationContextName={selectedDestinationContext}
                onNavigateToResource={onNavigateToResource}
              />

              <section className="rounded-xl border border-theme-border bg-theme-surface overflow-hidden">
                <div className="px-4 py-3 border-b border-theme-border flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-theme-text-primary">Managed Resources</h3>
                  <span className="text-xs text-theme-text-tertiary">{selectedResources.length} resources</span>
                </div>
                <div className="divide-y divide-theme-border">
                  {selectedResources.length === 0 ? (
                    <div className="p-4 text-sm text-theme-text-tertiary">
                      ArgoCD did not report child resources in the Application CRD. The map above still shows the app source and destination; managed child nodes appear when `status.resources` is populated or Radar can infer topology edges.
                    </div>
                  ) : selectedResources.map((resource: any, index: number) => (
                    <button
                      key={`${resource.group || ''}/${resource.kind}/${resource.namespace || '_'}/${resource.name}/${index}`}
                      onClick={() => {
                        const target = resourceToNavigationTarget(resource)
                        if (target) onNavigateToResource(target, { contextName: selectedDestinationContext })
                      }}
                      className="w-full px-4 py-2.5 text-left grid grid-cols-[1fr_120px_120px_120px] gap-3 hover:bg-theme-hover text-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-theme-text-primary truncate">{resource.name}</div>
                        <div className="text-xs text-theme-text-tertiary">{resource.kind} {resource.namespace ? `in ${resource.namespace}` : ''}</div>
                      </div>
                      <div><StatusBadge text={resource.status || '-'} color={resource.status === 'Synced' ? 'status-healthy' : 'status-degraded'} /></div>
                      <div><StatusBadge text={resource.health?.status || '-'} color={resource.health?.status === 'Healthy' ? 'status-healthy' : resource.health?.status === 'Degraded' ? 'status-unhealthy' : 'status-unknown'} /></div>
                      <div className="text-xs text-theme-text-tertiary truncate">{resource.version || resource.group || 'core'}</div>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
      {syncDialogApp && syncOptions && (
        <ArgoSyncDialog
          app={syncDialogApp}
          options={syncOptions}
          isPending={syncMutation.isPending}
          onChange={setSyncOptions}
          onClose={() => setSyncDialogApp(null)}
          onSubmit={submitSync}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-theme-text-tertiary">{label}</span>
      <span className="text-theme-text-primary text-right truncate">{value}</span>
    </div>
  )
}

function ArgoSyncDialog({
  app,
  options,
  isPending,
  onChange,
  onClose,
  onSubmit,
}: {
  app: any
  options: ArgoSyncOptions
  isPending: boolean
  onChange: (options: ArgoSyncOptions) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const setOption = <K extends keyof ArgoSyncOptions>(key: K, value: ArgoSyncOptions[K]) => {
    onChange({ ...options, [key]: value })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-theme-border flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-theme-text-primary">Synchronize {getAppName(app)}</h2>
            <p className="text-sm text-theme-text-secondary">
              Synchronizing application manifests from {getArgoApplicationRepo(app) || 'configured source'}.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-theme-text-tertiary hover:text-theme-text-primary hover:bg-theme-elevated">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[75vh] overflow-y-auto">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-theme-text-tertiary mb-1">Revision</span>
            <input
              value={options.revision || ''}
              onChange={event => setOption('revision', event.target.value)}
              placeholder="HEAD"
              className="w-full px-3 py-2 rounded-lg bg-theme-base border border-theme-border text-sm text-theme-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
          </label>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SyncOptionCheckbox label="Prune" checked={options.prune} onChange={v => setOption('prune', v)} />
            <SyncOptionCheckbox label="Dry run" checked={options.dryRun} onChange={v => setOption('dryRun', v)} />
            <SyncOptionCheckbox label="Apply only" checked={options.applyOnly} onChange={v => setOption('applyOnly', v)} />
            <SyncOptionCheckbox label="Force" checked={options.force} onChange={v => setOption('force', v)} />
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-theme-text-tertiary mb-3">Sync Options</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <SyncOptionCheckbox label="Skip schema validation" checked={options.skipSchemaValidation} onChange={v => setOption('skipSchemaValidation', v)} />
              <SyncOptionCheckbox label="Auto-create namespace" checked={options.autoCreateNamespace} onChange={v => setOption('autoCreateNamespace', v)} />
              <SyncOptionCheckbox label="Prune last" checked={options.pruneLast} onChange={v => setOption('pruneLast', v)} />
              <SyncOptionCheckbox label="Apply out of sync only" checked={options.applyOutOfSyncOnly} onChange={v => setOption('applyOutOfSyncOnly', v)} />
              <SyncOptionCheckbox label="Respect ignore differences" checked={options.respectIgnoreDifferences} onChange={v => setOption('respectIgnoreDifferences', v)} />
              <SyncOptionCheckbox label="Server-side apply" checked={options.serverSideApply} onChange={v => setOption('serverSideApply', v)} />
            </div>
          </div>

          <label className="grid grid-cols-[180px_1fr] items-center gap-3">
            <span className="text-sm text-theme-text-secondary">Prune propagation policy</span>
            <select
              value={options.prunePropagationPolicy}
              onChange={event => setOption('prunePropagationPolicy', event.target.value as ArgoSyncOptions['prunePropagationPolicy'])}
              className="px-3 py-2 rounded-lg bg-theme-base border border-theme-border text-sm text-theme-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            >
              <option value="">Default</option>
              <option value="foreground">foreground</option>
              <option value="background">background</option>
              <option value="orphan">orphan</option>
            </select>
          </label>

          <div className="space-y-2">
            <SyncOptionCheckbox label="Replace" checked={options.replace} onChange={v => setOption('replace', v)} />
            {options.replace && (
              <div className="rounded-lg border-l-4 border-red-500 bg-red-500/10 p-3 text-sm text-theme-text-secondary">
                Resources will be synced using replace/create semantics. This is potentially destructive and can recreate resources.
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-theme-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isPending}
            className="px-4 py-2 rounded-lg text-sm border border-theme-border text-theme-text-secondary hover:text-theme-text-primary hover:bg-theme-elevated disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={isPending}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm btn-brand disabled:opacity-50"
          >
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Synchronize
          </button>
        </div>
      </div>
    </div>
  )
}

function SyncOptionCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-theme-text-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        className="w-4 h-4 rounded border-theme-border accent-blue-500"
      />
      {label}
    </label>
  )
}

function ResourceMap({
  app,
  sources,
  resources,
  destinationContextName,
  onNavigateToResource,
}: {
  app: any
  sources: any[]
  resources: any[]
  destinationContextName?: string
  onNavigateToResource: (resource: SelectedResource, options?: ArgoNavigateOptions) => void
}) {
  const tree = useMemo(() => buildResourceTree(resources), [resources])
  const levelByID = useMemo(() => {
    const childrenBySource = new Map<string, string[]>()
    for (const edge of tree.edges) {
      childrenBySource.set(edge.source, [...(childrenBySource.get(edge.source) || []), edge.target])
    }
    const levels = new Map<string, number>()
    const queue = [{ id: 'app', level: 0 }]
    while (queue.length > 0) {
      const current = queue.shift()!
      for (const child of childrenBySource.get(current.id) || []) {
        const nextLevel = current.level + 1
        if ((levels.get(child) ?? 0) >= nextLevel) continue
        levels.set(child, nextLevel)
        queue.push({ id: child, level: nextLevel })
      }
    }
    for (const resource of tree.resources) {
      const id = resourceID(resource)
      if (!levels.has(id)) levels.set(id, 1)
    }
    return levels
  }, [tree.edges, tree.resources])
  const levels = useMemo(() => {
    const columns = new Map<number, any[]>()
    for (const resource of tree.resources) {
      const level = levelByID.get(resourceID(resource)) || 1
      columns.set(level, [...(columns.get(level) || []), resource])
    }
    return Array.from(columns.entries()).sort(([a], [b]) => a - b)
  }, [levelByID, tree.resources])

  const sourceCount = Math.max(1, sources.length)
  const maxColumnCount = Math.max(sourceCount, 1, ...levels.map(([, items]) => items.length))
  const cardWidth = 190
  const cardHeight = 64
  const sourceX = 24
  const appX = 270
  const resourceStartX = 520
  const columnGap = 245
  const rowGap = 88
  const canvasHeight = Math.max(300, maxColumnCount * rowGap + 48)
  const appY = Math.round((canvasHeight - cardHeight) / 2)
  const maxLevel = levels.length ? Math.max(...levels.map(([level]) => level)) : 0
  const canvasWidth = Math.max(820, resourceStartX + Math.max(0, maxLevel - 1) * columnGap + cardWidth + 32)

  const sourcePositions = sources.length === 0
    ? [{ id: 'source-empty', x: sourceX, y: appY }]
    : sources.map((_: any, index: number) => ({
        id: `source-${index}`,
        x: sourceX,
        y: Math.round((canvasHeight - sources.length * rowGap) / 2 + index * rowGap + (rowGap - cardHeight) / 2),
      }))

  const nodePositions = new Map<string, { x: number; y: number }>()
  for (const [level, items] of levels) {
    const x = resourceStartX + (level - 1) * columnGap
    const startY = Math.round((canvasHeight - items.length * rowGap) / 2)
    items.forEach((resource, index) => {
      nodePositions.set(resourceID(resource), {
        x,
        y: startY + index * rowGap + Math.round((rowGap - cardHeight) / 2),
      })
    })
  }

  const appPosition = { x: appX, y: appY }

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface overflow-hidden">
      <div className="px-4 py-3 border-b border-theme-border flex items-center justify-between">
        <h3 className="text-sm font-semibold text-theme-text-primary">Resource Map</h3>
        <span className="text-xs text-theme-text-tertiary">ArgoCD-style dependency tree</span>
      </div>
      <div className="p-4 overflow-x-auto">
        <div className="relative" style={{ width: canvasWidth, height: canvasHeight }}>
          <svg className="absolute inset-0 pointer-events-none text-theme-text-tertiary" width={canvasWidth} height={canvasHeight}>
            <defs>
              <marker id="argo-map-arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" opacity="0.65" />
              </marker>
            </defs>
            {sourcePositions.map(position => (
              <ArgoMapEdge
                key={position.id}
                from={{ x: position.x + cardWidth, y: position.y + cardHeight / 2 }}
                to={{ x: appPosition.x, y: appPosition.y + cardHeight / 2 }}
              />
            ))}
            {tree.edges.map(edge => {
              const from = edge.source === 'app' ? appPosition : nodePositions.get(edge.source)
              const to = nodePositions.get(edge.target)
              if (!from || !to) return null
              return (
                <ArgoMapEdge
                  key={`${edge.source}->${edge.target}`}
                  from={{ x: from.x + cardWidth, y: from.y + cardHeight / 2 }}
                  to={{ x: to.x, y: to.y + cardHeight / 2 }}
                />
              )
            })}
          </svg>

          <div className="absolute top-0 text-[11px] uppercase tracking-wide text-theme-text-tertiary font-medium" style={{ left: sourceX }}>
            Sources
          </div>
          <div className="absolute top-0 text-[11px] uppercase tracking-wide text-theme-text-tertiary font-medium" style={{ left: appX }}>
            Application
          </div>
          <div className="absolute top-0 text-[11px] uppercase tracking-wide text-theme-text-tertiary font-medium" style={{ left: resourceStartX }}>
            Managed Resources
          </div>

          {sources.length === 0 ? (
            <MapNode style={{ left: sourceX, top: appY }} icon={GitBranch} title="No source" subtitle="spec.source empty" tone="neutral" />
          ) : sources.map((source: any, index: number) => (
            <MapNode
              key={index}
              style={{ left: sourcePositions[index].x, top: sourcePositions[index].y }}
              icon={GitBranch}
              title={source.repoURL || 'Repository'}
              subtitle={`${source.path || source.chart || 'root'} @ ${source.targetRevision || 'HEAD'}`}
              tone="info"
            />
          ))}

          <div
            className="absolute rounded-2xl border border-orange-500/25 bg-orange-500/10 text-orange-600 dark:text-orange-400 px-4 py-3 shadow-theme-md text-center"
            style={{ left: appPosition.x, top: appPosition.y, width: cardWidth, minHeight: cardHeight }}
          >
            <ArgoIcon className="w-6 h-6 mx-auto mb-1" />
            <div className="font-semibold text-theme-text-primary truncate">{getAppName(app)}</div>
            <div className="text-xs text-theme-text-tertiary truncate">{getAppNamespace(app)} / {getProject(app)}</div>
          </div>

          {tree.resources.length === 0 && (
            <div className="absolute rounded-xl border border-dashed border-theme-border bg-theme-elevated/50 px-4 py-3 text-center text-xs text-theme-text-tertiary" style={{ left: resourceStartX, top: appY, width: 260 }}>
              No child resources available from the Application CRD yet.
            </div>
          )}

          {tree.resources.map(resource => {
            const id = resourceID(resource)
            const position = nodePositions.get(id)
            const ownPodCount = kindLower(resource) === 'podgroup' ? Number(resource.podCount || resource.pods?.length || 0) : 0
            const podCount = ownPodCount || tree.podCountsByID.get(id) || 0
            if (!position) return null
            return (
              <button
                key={id}
                onClick={() => {
                  const target = resourceToNavigationTarget(resource)
                  if (target) onNavigateToResource(target, { contextName: destinationContextName })
                }}
                className="absolute rounded-xl border border-theme-border bg-theme-base hover:bg-theme-hover px-3 py-2 text-left shadow-theme-sm transition-colors"
                style={{ left: position.x, top: position.y, width: cardWidth, minHeight: cardHeight }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-theme-text-primary truncate">{resource.name}</span>
                  <span className="text-[10px] text-theme-text-tertiary shrink-0">{resource.kind === 'PodGroup' ? 'Pods' : resource.kind}</span>
                </div>
                <div className="mt-1 text-[11px] text-theme-text-tertiary truncate">{resource.namespace || 'cluster-scoped'}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  {resource.status && <span className="badge-sm status-neutral">{resource.status}</span>}
                  {resource.health?.status && <span className="badge-sm status-healthy">{resource.health.status}</span>}
                  {podCount > 0 && <span className="badge-sm bg-sky-500/10 text-sky-600 dark:text-sky-400">{podCount} pod{podCount === 1 ? '' : 's'}</span>}
                </div>
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-theme-text-tertiary">
          <span>Destination: {getDestinationCluster(app)} / namespace {app.spec?.destination?.namespace || 'default'}</span>
          {tree.remaining > 0 && <span>+{tree.remaining} more resources in the table below</span>}
        </div>
      </div>
    </section>
  )
}

function ArgoMapEdge({ from, to }: { from: { x: number; y: number }; to: { x: number; y: number } }) {
  const midX = Math.round((from.x + to.x) / 2)
  return (
    <path
      d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - 8} ${to.y}`}
      fill="none"
      className="text-theme-text-tertiary"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeOpacity="0.5"
      markerEnd="url(#argo-map-arrow)"
    />
  )
}

function MapNode({
  icon: Icon,
  title,
  subtitle,
  tone,
  style,
}: {
  icon: typeof GitBranch
  title: string
  subtitle: string
  tone: 'healthy' | 'info' | 'neutral'
  style?: CSSProperties
}) {
  const toneClass = {
    healthy: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500',
    info: 'border-sky-500/20 bg-sky-500/10 text-sky-500',
    neutral: 'border-theme-border bg-theme-elevated text-theme-text-tertiary',
  }[tone]

  return (
    <div className={clsx('absolute rounded-xl border p-3 shadow-theme-sm', toneClass)} style={{ width: 190, minHeight: 64, ...style }}>
      <div className="flex items-start gap-2">
        <Icon className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-theme-text-primary truncate">{title}</div>
          <div className="text-xs text-theme-text-tertiary truncate">{subtitle}</div>
        </div>
      </div>
    </div>
  )
}
