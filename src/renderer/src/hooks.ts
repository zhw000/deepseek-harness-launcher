import { useCallback, useEffect, useState } from 'react'
import type { ProfileSummary } from '../../shared/types'
import { api } from './api'
import { attempt, useAppState, useStore } from './store'

/** Profiles under DSH_HOME, refetched whenever plugins or the home change. */
export function useProfiles(): ProfileSummary[] {
  const revision = useStore(current => current.pluginsRevision)
  const { paths } = useAppState()
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  useEffect(() => {
    let live = true
    void attempt(() => api.listProfiles()).then((list) => {
      if (live && list) setProfiles(list)
    })
    return () => {
      live = false
    }
  }, [revision, paths.dshHome])
  return profiles
}

const TARGET_KEY = 'dsh-launcher.profile'

function readTarget(): string | null {
  try {
    return sessionStorage.getItem(TARGET_KEY)
  } catch {
    return null
  }
}

/** The profile the Plugins and Market pages act on, shared between them for this session. */
export function useTargetProfile(): [string, (name: string) => void] {
  const { settings } = useAppState()
  const [profile, setProfile] = useState(() => readTarget() ?? settings.launch.profile)
  const choose = useCallback((name: string) => {
    setProfile(name)
    try {
      sessionStorage.setItem(TARGET_KEY, name)
    } catch {
      // Storage unavailable; the choice just is not remembered.
    }
  }, [])
  return [profile, choose]
}
