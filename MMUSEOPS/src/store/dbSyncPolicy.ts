type SyncVersion = { serverRevision?: unknown; updatedAt?: unknown }

export function shouldUseRemoteSummary(local: SyncVersion, remote: SyncVersion): boolean {
  const localRevision = Number(local?.serverRevision)
  const remoteRevision = Number(remote?.serverRevision)
  if (Number.isSafeInteger(localRevision) && Number.isSafeInteger(remoteRevision)) {
    return localRevision !== remoteRevision
  }
  return new Date(String(remote?.updatedAt || 0)).getTime() > new Date(String(local?.updatedAt || 0)).getTime()
}
