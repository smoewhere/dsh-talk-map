export interface TrashResult {
  requestId: string
  sessionId?: string
  entryId?: string
  affectedSessionIds: string[]
  status: 'trashed' | 'restored' | 'purged' | 'failed'
  error?: { code: string; message: string; blockingSessionIds?: string[]; activityKinds?: string[] }
}

export interface TrashEntry {
  entryId: string
  sessionId: string
  title: string
  sessionCount: number
  workspace: string
  deletedAt: number
  state: string
  sizeBytes?: number | null
  error?: string
}

export interface TrashListing {
  capabilities?: { stopActivity: boolean }
  entries: TrashEntry[]
}

export interface StorageSize { sizeBytes: number; complete: boolean }
export interface StorageUsage {
  categories: Record<'sessions' | 'projectionCache' | 'trash' | 'attachments', StorageSize>
  measuredAt: number
  complete: boolean
}
