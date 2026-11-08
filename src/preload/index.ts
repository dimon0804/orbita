import { contextBridge, ipcRenderer } from 'electron'

type Res<T> = { ok: true; data: T } | { ok: false; error: string }

const call = async <T = unknown>(ch: string, ...args: unknown[]): Promise<T> => {
  const r = (await ipcRenderer.invoke(ch, ...args)) as Res<T>
  if (!r.ok) throw new Error(r.error)
  return r.data
}

const on = (ch: string, fn: (payload: unknown) => void): (() => void) => {
  const l = (_e: unknown, p: unknown): void => fn(p)
  ipcRenderer.on(ch, l)
  return () => ipcRenderer.removeListener(ch, l)
}

contextBridge.exposeInMainWorld('orbita', { call, on })
