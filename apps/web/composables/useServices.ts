/**
 * Access to the application services.
 *
 * The local core is asynchronous (opening IndexedDB), so this resolves once and
 * is shared. A failure to open is surfaced as a message, never as a crash on a
 * page that would otherwise work.
 */
import { AppError, toAppError } from '@clinote/shared'
import { getLocalCore } from '~/database'
import {
  AppointmentService,
  ClientService,
  ExportService,
  FileService,
  ImportService,
  WorkService,
} from '~/services'

export interface Services {
  appointments: AppointmentService
  clients: ClientService
  works: WorkService
  files: FileService
  exports: ExportService
  imports: ImportService
}

let servicesPromise: Promise<Services> | null = null

export function useServices(): Promise<Services> {
  servicesPromise ??= getLocalCore().then((core) => {
    const appVersion = useRuntimeConfig().public.appVersion as string
    const exports = new ExportService(core, appVersion)
    return {
      appointments: new AppointmentService(core),
      clients: new ClientService(core),
      works: new WorkService(core),
      files: new FileService(core),
      exports,
      imports: new ImportService(core, exports),
    }
  })
  return servicesPromise
}

/** Turns any thrown value into a message that is safe and useful to show. */
export function describeError(error: unknown): string {
  const appError: AppError = error instanceof AppError ? error : toAppError(error)
  return appError.message
}
