import { app } from 'electron'
import { join } from 'path'

/** Папка с ядром и наборами правил: в сборке — resources рядом с exe, в разработке — resources проекта. */
export const resDir = (): string =>
  app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')

export const coreBin = (): string => join(resDir(), 'core', 'sing-box.exe')
export const rulesDir = (): string => join(resDir(), 'rules')
export const iconPath = (name: string): string => join(resDir(), 'icons', name)
