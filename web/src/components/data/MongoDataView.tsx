import { useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import { AlertTriangle, Cable, Database, FileJson, HardDrive, KeyRound, Loader2, RefreshCw, Search, Server, Shield, Table2, Unplug } from 'lucide-react'
import {
  type MongoCredentialRef,
  type MongoInstance,
  type MongoSession,
  useConnectMongo,
  useDisconnectMongo,
  useMongoCollections,
  useMongoDatabases,
  useMongoDocuments,
  useMongoIndexes,
  useMongoInstances,
  useMongoSessions,
  useUpdateMongoDocument,
} from '../../api/client'

function statusTone(phase?: string) {
  if (phase === 'Running') return 'status-healthy'
  if (phase === 'Failed') return 'status-unhealthy'
  if (phase === 'Pending') return 'status-degraded'
  return 'status-unknown'
}

function formatJSON(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function mongoDocumentID(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return undefined
  return (doc as Record<string, unknown>)._id
}

function mongoDocumentTitle(doc: unknown, index: number) {
  const id = mongoDocumentID(doc)
  if (id && typeof id === 'object' && '$oid' in id) return String((id as Record<string, unknown>).$oid)
  if (id !== undefined) return String(id)
  return `Document ${index + 1}`
}

function credentialLabel(ref?: MongoCredentialRef | null) {
  if (!ref) return 'Manual credentials'
  const key = ref.usernameKey ? `${ref.usernameKey}/${ref.passwordKey}` : ref.passwordKey
  return `${ref.namespace}/${ref.name}${key ? ` (${key})` : ''}`
}

interface MongoDataViewState {
  selectedInstanceID: string
  selectedCredentialKey: string
  username: string
  password: string
  authSource: string
  session: MongoSession | null
  selectedDatabase: string
  selectedCollection: string
}

let mongoDataViewState: MongoDataViewState = {
  selectedInstanceID: '',
  selectedCredentialKey: 'manual',
  username: '',
  password: '',
  authSource: 'admin',
  session: null,
  selectedDatabase: '',
  selectedCollection: '',
}

function InstanceCard({
  instance,
  selected,
  onSelect,
}: {
  instance: MongoInstance
  selected: boolean
  onSelect: () => void
}) {
  const ready = `${instance.readyReplicas ?? 0}/${instance.replicas ?? instance.pods.length}`
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-xl border p-3 transition-colors ${
        selected
          ? 'selection-strong border-skyhook-500/50'
          : 'bg-theme-surface border-theme-border hover:bg-theme-hover'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-accent-text shrink-0" />
            <div className="font-medium text-theme-text-primary truncate">{instance.name}</div>
          </div>
          <div className="mt-1 text-xs text-theme-text-tertiary truncate">
            {instance.namespace}/{instance.serviceName}:{instance.port}
          </div>
        </div>
        <span className="badge status-neutral shrink-0">{ready}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {instance.architecture && <span className="badge status-violet">{instance.architecture}</span>}
        {instance.version && <span className="badge status-healthy">Mongo {instance.version}</span>}
        {instance.helmChart && <span className="badge status-neutral">{instance.helmChart}</span>}
      </div>
      {instance.warnings && instance.warnings.length > 0 && (
        <div className="mt-2 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3" />
          {instance.warnings[0]}
        </div>
      )}
    </button>
  )
}

function ExplorerTree({
  session,
  selectedDatabase,
  selectedCollection,
  onDatabase,
  onCollection,
}: {
  session: MongoSession | null
  selectedDatabase: string
  selectedCollection: string
  onDatabase: (name: string) => void
  onCollection: (name: string) => void
}) {
  const databases = useMongoDatabases(session?.id)
  const collections = useMongoCollections(session?.id, selectedDatabase)

  return (
    <div className="bg-theme-surface border border-theme-border rounded-xl overflow-hidden min-h-[420px] h-full">
      <div className="px-4 py-3 border-b border-theme-border flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-theme-text-primary">
          <Server className="w-4 h-4 text-accent-text" />
          Explorer
        </div>
        {(databases.isFetching || collections.isFetching) && <Loader2 className="w-4 h-4 animate-spin text-theme-text-tertiary" />}
      </div>
      {!session ? (
        <div className="p-6 text-sm text-theme-text-secondary">
          Connect to a MongoDB instance to browse databases and collections.
        </div>
      ) : (
        <div className="grid grid-cols-2 h-[calc(100%-49px)] min-h-[370px]">
          <div className="border-r border-theme-border p-2 overflow-auto">
            <div className="px-2 pb-2 text-xs uppercase tracking-wide text-theme-text-tertiary">Databases</div>
            {(databases.data ?? []).map(db => (
              <button
                key={db.name}
                onClick={() => onDatabase(db.name)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-left ${
                  selectedDatabase === db.name ? 'selection' : 'hover:bg-theme-hover text-theme-text-secondary'
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                <span className="truncate">{db.name}</span>
              </button>
            ))}
          </div>
          <div className="p-2 overflow-auto">
            <div className="px-2 pb-2 text-xs uppercase tracking-wide text-theme-text-tertiary">Collections</div>
            {!selectedDatabase && <div className="px-2 text-sm text-theme-text-tertiary">Select a database.</div>}
            {(collections.data ?? []).map(collection => (
              <button
                key={collection.name}
                onClick={() => onCollection(collection.name)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-left ${
                  selectedCollection === collection.name ? 'selection' : 'hover:bg-theme-hover text-theme-text-secondary'
                }`}
              >
                <Table2 className="w-3.5 h-3.5" />
                <span className="truncate">{collection.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DocumentsPanel({
  session,
  database,
  collection,
}: {
  session: MongoSession | null
  database: string
  collection: string
}) {
  const [filter, setFilter] = useState('{}')
  const [appliedFilter, setAppliedFilter] = useState('{}')
  const [tab, setTab] = useState<'documents' | 'indexes'>('documents')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [editedDocument, setEditedDocument] = useState('')
  const [editError, setEditError] = useState('')
  const documents = useMongoDocuments(session?.id, database, collection, appliedFilter, 50)
  const indexes = useMongoIndexes(session?.id, database, collection)
  const updateDocument = useUpdateMongoDocument()
  const selectedDocument = documents.data?.documents[selectedIndex]
  const selectedDocumentJSON = selectedDocument ? formatJSON(selectedDocument) : ''
  const isDirty = !!selectedDocument && editedDocument !== selectedDocumentJSON

  useEffect(() => {
    setSelectedIndex(0)
  }, [session?.id, database, collection, appliedFilter])

  useEffect(() => {
    setEditedDocument(selectedDocumentJSON)
    setEditError('')
  }, [selectedDocumentJSON])

  const handleSaveDocument = async () => {
    if (!session || !database || !collection || !selectedDocument) return
    let parsed: unknown
    try {
      parsed = JSON.parse(editedDocument)
    } catch (error) {
      setEditError(error instanceof Error ? error.message : 'Invalid JSON')
      return
    }
    const id = mongoDocumentID(selectedDocument)
    if (id === undefined) {
      setEditError('Selected document has no _id')
      return
    }
    const nextID = mongoDocumentID(parsed)
    if (formatJSON(id) !== formatJSON(nextID)) {
      setEditError('Changing _id is not supported')
      return
    }
    setEditError('')
    await updateDocument.mutateAsync({ sessionID: session.id, database, collection, id, document: parsed })
  }

  return (
    <div className="bg-theme-surface border border-theme-border rounded-xl overflow-hidden min-h-[420px] h-full flex flex-col">
      <div className="px-4 py-3 border-b border-theme-border flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium text-theme-text-primary">
            <FileJson className="w-4 h-4 text-accent-text" />
            {database && collection ? `${database}.${collection}` : 'Documents'}
          </div>
          <div className="text-xs text-theme-text-tertiary">Compass-style read-only document browser</div>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-theme-elevated p-1">
          {(['documents', 'indexes'] as const).map(value => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`px-2 py-1 rounded-md text-xs capitalize ${tab === value ? 'bg-theme-surface text-theme-text-primary shadow-theme-sm' : 'text-theme-text-secondary'}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {tab === 'documents' && (
        <div className="p-4 border-b border-theme-border">
          <div className="flex items-start gap-2">
            <textarea
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="flex-1 min-h-[72px] rounded-lg border border-theme-border bg-theme-base px-3 py-2 font-mono text-xs text-theme-text-primary outline-none focus:ring-2 focus:ring-skyhook-500/30"
              spellCheck={false}
              placeholder='{ "status": "active" }'
            />
            <button
              onClick={() => { setSelectedIndex(0); setAppliedFilter(filter) }}
              disabled={!session || !database || !collection}
              className="btn-brand inline-flex items-center gap-2 px-3 py-2 text-sm disabled:opacity-50"
            >
              <Search className="w-4 h-4" />
              Run
            </button>
          </div>
          <div className="mt-2 text-xs text-theme-text-tertiary">Filter is Mongo extended JSON. Results are capped at 50 documents.</div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!session || !database || !collection ? (
          <div className="p-8 text-sm text-theme-text-secondary">Select a collection to view documents and indexes.</div>
        ) : tab === 'documents' ? (
          documents.isLoading ? (
            <div className="p-8 flex items-center gap-2 text-sm text-theme-text-secondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading documents…
            </div>
          ) : documents.error ? (
            <div className="m-4 p-3 rounded-lg bg-red-500/10 text-sm text-red-600 dark:text-red-400">{documents.error.message}</div>
          ) : (
            <div className="grid min-h-full xl:grid-cols-[260px_minmax(0,1fr)]">
              <div className="border-r border-theme-border bg-theme-base/40 p-2">
                <div className="mb-2 px-2 text-xs uppercase tracking-wide text-theme-text-tertiary">
                  {documents.data?.documents.length ?? 0} documents
                </div>
                <div className="space-y-1">
                  {(documents.data?.documents ?? []).map((doc, idx) => (
                    <button
                      key={idx}
                      onClick={() => setSelectedIndex(idx)}
                      className={`w-full rounded-lg px-2 py-2 text-left text-xs transition-colors ${
                        selectedIndex === idx ? 'selection' : 'text-theme-text-secondary hover:bg-theme-hover'
                      }`}
                    >
                      <div className="font-mono truncate">{mongoDocumentTitle(doc, idx)}</div>
                      <div className="mt-1 text-[11px] text-theme-text-tertiary">Document {idx + 1}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-w-0 p-3">
                {selectedDocument ? (
                  <div className="flex h-full min-h-[520px] flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-sm font-medium text-theme-text-primary truncate">
                          {mongoDocumentTitle(selectedDocument, selectedIndex)}
                        </div>
                        <div className="text-xs text-theme-text-tertiary">Edit JSON in place, then save to replace this document.</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isDirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
                        <button
                          onClick={() => { setEditedDocument(selectedDocumentJSON); setEditError('') }}
                          disabled={!isDirty || updateDocument.isPending}
                          className="rounded-lg border border-theme-border bg-theme-elevated px-3 py-1.5 text-xs text-theme-text-secondary hover:bg-theme-hover disabled:opacity-50"
                        >
                          Revert
                        </button>
                        <button
                          onClick={handleSaveDocument}
                          disabled={!isDirty || updateDocument.isPending}
                          className="btn-brand inline-flex items-center gap-2 px-3 py-1.5 text-xs disabled:opacity-50"
                        >
                          {updateDocument.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          Save
                        </button>
                      </div>
                    </div>
                    {(editError || updateDocument.error) && (
                      <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">
                        {editError || updateDocument.error?.message}
                      </div>
                    )}
                    <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-theme-border">
                      <Editor
                        value={editedDocument}
                        defaultLanguage="json"
                        theme="vs-dark"
                        onChange={(value) => setEditedDocument(value ?? '')}
                        options={{
                          automaticLayout: true,
                          folding: true,
                          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                          fontSize: 13,
                          formatOnPaste: true,
                          formatOnType: true,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          tabSize: 2,
                          wordWrap: 'on',
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="p-8 text-sm text-theme-text-secondary">Select a document to edit it.</div>
                )}
              </div>
              {documents.data?.documents.length === 0 && (
                <div className="p-8 text-sm text-theme-text-secondary">No documents matched the filter.</div>
              )}
            </div>
          )
        ) : indexes.isLoading ? (
          <div className="p-8 flex items-center gap-2 text-sm text-theme-text-secondary">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading indexes…
          </div>
        ) : (
          <div className="divide-y divide-theme-border-subtle">
            {(indexes.data ?? []).map((idx, i) => (
              <pre key={i} className="p-4 text-xs font-mono text-theme-text-secondary whitespace-pre-wrap break-words">
                {formatJSON(idx)}
              </pre>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function MongoDataView() {
  const instances = useMongoInstances()
  const activeSessions = useMongoSessions()
  const connect = useConnectMongo()
  const disconnect = useDisconnectMongo()
  const [viewState, setViewState] = useState<MongoDataViewState>(() => mongoDataViewState)

  const updateViewState = (patch: Partial<MongoDataViewState>) => {
    mongoDataViewState = { ...mongoDataViewState, ...patch }
    setViewState(mongoDataViewState)
  }

  const {
    selectedInstanceID,
    selectedCredentialKey,
    username,
    password,
    authSource,
    session,
    selectedDatabase,
    selectedCollection,
  } = viewState

  const selectedInstance = useMemo(() => {
    return (instances.data ?? []).find(instance => instance.id === selectedInstanceID) ?? instances.data?.[0]
  }, [instances.data, selectedInstanceID])

  useEffect(() => {
    if (!selectedInstanceID && selectedInstance?.id) {
      updateViewState({ selectedInstanceID: selectedInstance.id })
    }
  }, [selectedInstance?.id, selectedInstanceID])

  useEffect(() => {
    if (!selectedInstance) return
    const credentialKeys = selectedInstance.credentials.map(credentialKey)
    if (selectedCredentialKey !== 'manual' && !credentialKeys.includes(selectedCredentialKey)) {
      updateViewState({
        selectedCredentialKey: selectedInstance.credentials[0] ? credentialKey(selectedInstance.credentials[0]) : 'manual',
      })
    }
  }, [selectedCredentialKey, selectedInstance])

  useEffect(() => {
    if (!activeSessions.data) return
    if (session && activeSessions.data.some(active => active.id === session.id)) return

    const restored = activeSessions.data.find(active => active.instanceId === selectedInstanceID) ?? activeSessions.data[0] ?? null
    if (restored) {
      updateViewState({
        session: restored,
        selectedInstanceID: restored.instanceId || selectedInstanceID,
      })
    } else if (session) {
      updateViewState({ session: null })
    }
  }, [activeSessions.data, selectedInstanceID, session])

  const selectedCredential = useMemo(() => {
    if (!selectedInstance || selectedCredentialKey === 'manual') return null
    return selectedInstance.credentials.find(ref => credentialKey(ref) === selectedCredentialKey) ?? null
  }, [selectedCredentialKey, selectedInstance])
  const missingManualCredentials = selectedCredentialKey === 'manual' && (!username.trim() || !password)

  const grouped = useMemo(() => {
    const groups = new Map<string, MongoInstance[]>()
    for (const instance of instances.data ?? []) {
      const key = `${instance.context || 'current cluster'} / ${instance.namespace}`
      groups.set(key, [...(groups.get(key) ?? []), instance])
    }
    return Array.from(groups.entries())
  }, [instances.data])

  const handleConnect = async () => {
    if (!selectedInstance) return
    if (missingManualCredentials) return
    const next = await connect.mutateAsync({
      instanceId: selectedInstance.id,
      namespace: selectedInstance.namespace,
      serviceName: selectedInstance.serviceName,
      port: selectedInstance.port,
      credential: selectedCredential ?? undefined,
      username: selectedCredential ? undefined : username,
      password: selectedCredential ? undefined : password,
      authSource,
    })
    updateViewState({
      session: next,
      selectedInstanceID: next.instanceId || selectedInstance.id,
      selectedDatabase: '',
      selectedCollection: '',
    })
  }

  const handleDisconnect = async () => {
    if (session) await disconnect.mutateAsync(session.id)
    updateViewState({
      session: null,
      selectedDatabase: '',
      selectedCollection: '',
    })
  }

  return (
    <div className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden p-4">
      <div className="flex flex-col gap-4 min-w-0">
      <div className="bg-theme-surface border border-theme-border rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-semibold text-theme-text-primary">
            <Database className="w-5 h-5 text-accent-text" />
            Data Explorer
          </div>
          <div className="text-sm text-theme-text-secondary">
            Discover MongoDB per cluster and namespace, then browse databases, collections, documents, and indexes.
          </div>
        </div>
        <button
          onClick={() => instances.refetch()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-theme-border bg-theme-elevated text-sm text-theme-text-secondary hover:bg-theme-hover"
        >
          <RefreshCw className={`w-4 h-4 ${instances.isFetching ? 'animate-spin' : ''}`} />
          Rescan
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(280px,0.9fr)_minmax(420px,1.4fr)] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <div className="bg-theme-surface border border-theme-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-theme-border flex items-center justify-between">
              <div className="font-medium text-theme-text-primary">Mongo Instances</div>
              {instances.isLoading && <Loader2 className="w-4 h-4 animate-spin text-theme-text-tertiary" />}
            </div>
            <div className="p-3 space-y-4 max-h-[360px] xl:max-h-[calc(100vh-250px)] overflow-auto">
              {instances.error && <div className="text-sm text-red-600 dark:text-red-400">{instances.error.message}</div>}
              {grouped.map(([group, items]) => (
                <div key={group}>
                  <div className="mb-2 text-xs uppercase tracking-wide text-theme-text-tertiary">{group}</div>
                  <div className="space-y-2">
                    {items.map(instance => (
                      <InstanceCard
                        key={instance.id}
                        instance={instance}
                        selected={selectedInstance?.id === instance.id}
                        onSelect={() => updateViewState({
                          selectedInstanceID: instance.id,
                          selectedCredentialKey: instance.credentials[0] ? credentialKey(instance.credentials[0]) : 'manual',
                          selectedDatabase: '',
                          selectedCollection: '',
                        })}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {!instances.isLoading && grouped.length === 0 && (
                <div className="p-4 text-sm text-theme-text-secondary">No MongoDB services were discovered in this cluster.</div>
              )}
            </div>
          </div>

          <div className="bg-theme-surface border border-theme-border rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 font-medium text-theme-text-primary">
              <KeyRound className="w-4 h-4 text-accent-text" />
              Connection
            </div>
            {selectedInstance ? (
              <>
                <select
                  value={selectedCredentialKey}
                  onChange={e => updateViewState({ selectedCredentialKey: e.target.value })}
                  className="w-full rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm text-theme-text-primary"
                >
                  {selectedInstance.credentials.map(ref => (
                    <option key={credentialKey(ref)} value={credentialKey(ref)}>{credentialLabel(ref)}</option>
                  ))}
                  <option value="manual">Manual credentials</option>
                </select>
                {selectedCredentialKey === 'manual' && (
                  <div className="space-y-2">
                    <input value={username} onChange={e => updateViewState({ username: e.target.value })} placeholder="Username" className="w-full rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm" />
                    <input value={password} onChange={e => updateViewState({ password: e.target.value })} type="password" placeholder="Password" className="w-full rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm" />
                    <input value={authSource} onChange={e => updateViewState({ authSource: e.target.value })} placeholder="Auth source" className="w-full rounded-lg border border-theme-border bg-theme-base px-3 py-2 text-sm" />
                    {missingManualCredentials && (
                      <div className="text-xs text-amber-600 dark:text-amber-400">
                        Enter both username and password, or select a discovered Kubernetes secret.
                      </div>
                    )}
                  </div>
                )}
                <div className="flex gap-2">
                  {!session ? (
                    <button onClick={handleConnect} disabled={connect.isPending || missingManualCredentials} className="btn-brand flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-sm disabled:opacity-50">
                      {connect.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cable className="w-4 h-4" />}
                      Connect
                    </button>
                  ) : (
                    <button onClick={handleDisconnect} disabled={disconnect.isPending} className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-theme-border bg-theme-elevated text-sm hover:bg-theme-hover disabled:opacity-50">
                      <Unplug className="w-4 h-4" />
                      Disconnect
                    </button>
                  )}
                </div>
                {session && (
                  <div className="rounded-lg bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300">
                    Connected via localhost:{session.localPort}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-theme-text-secondary">Select a MongoDB instance first.</div>
            )}
          </div>

          {selectedInstance && (
            <div className="bg-theme-surface border border-theme-border rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 font-medium text-theme-text-primary">
                <Shield className="w-4 h-4 text-accent-text" />
                Tenancy Signals
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="card-inner">
                  <div className="text-theme-text-tertiary">Namespace</div>
                  <div className="font-medium text-theme-text-primary">{selectedInstance.namespace}</div>
                </div>
                <div className="card-inner">
                  <div className="text-theme-text-tertiary">Service</div>
                  <div className="font-medium text-theme-text-primary">{selectedInstance.serviceName}</div>
                </div>
                <div className="card-inner">
                  <div className="text-theme-text-tertiary">Pods</div>
                  <div className="font-medium text-theme-text-primary">{selectedInstance.pods.length}</div>
                </div>
                <div className="card-inner">
                  <div className="text-theme-text-tertiary">Secrets</div>
                  <div className="font-medium text-theme-text-primary">{selectedInstance.credentials.length}</div>
                </div>
              </div>
              <div className="space-y-1">
                {selectedInstance.pods.map(pod => (
                  <div key={pod.name} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-theme-text-secondary">{pod.name}</span>
                    <span className={`badge ${statusTone(pod.phase)}`}>{pod.ready}</span>
                  </div>
                ))}
              </div>
              {selectedInstance.backups.length > 0 && (
                <div className="pt-2 border-t border-theme-border">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-theme-text-tertiary mb-2">
                    <HardDrive className="w-3 h-3" />
                    Backup Jobs
                  </div>
                  {selectedInstance.backups.slice(0, 5).map(backup => (
                    <div key={`${backup.kind}/${backup.name}`} className="text-xs text-theme-text-secondary truncate">
                      {backup.kind} {backup.name} {backup.schedule ? `(${backup.schedule})` : backup.status ? `(${backup.status})` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <ExplorerTree
          session={session}
          selectedDatabase={selectedDatabase}
          selectedCollection={selectedCollection}
          onDatabase={(name) => updateViewState({ selectedDatabase: name, selectedCollection: '' })}
          onCollection={(name) => updateViewState({ selectedCollection: name })}
        />

        <DocumentsPanel session={session} database={selectedDatabase} collection={selectedCollection} />
      </div>
      </div>
    </div>
  )
}

function credentialKey(ref: MongoCredentialRef) {
  return `${ref.namespace}/${ref.name}/${ref.usernameKey ?? ''}/${ref.passwordKey ?? ''}/${ref.authSourceKey ?? ''}`
}
