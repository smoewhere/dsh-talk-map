export interface TrashResult {
  requestId: string
  sessionId?: string
  entryId?: string
  affectedSessionIds: string[]
  status: 'trashed' | 'restored' | 'purged' | 'failed'
  error?: { code: string; message: string }
}

export interface TrashEntry {
  entryId: string
  sessionId: string
  title: string
  sessionCount: number
  workspace: string
  deletedAt: number
  state: string
  error?: string
}

export interface TrashListing {
  entries: TrashEntry[]
}
