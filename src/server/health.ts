import { Request, Response } from 'express';
import { Store } from '../core/ports/store.js';
import { Clock } from '../core/ports/clock.js';

export interface HealthCheckOptions {
  store?: Store;
  clock?: Clock;
  getWorkerStatus?: () => { activeJobs: number; listening: boolean };
  getSchedulerHolder?: () => Promise<string | null>;
  identity?: string;
  target?: { projectId?: string; databaseId?: string };
}

const REQUIRED_ENV_VARS = [
  'CLOVER_APP_ID',
  'CLOVER_APP_SECRET',
  'CLOVER_WEBHOOK_SECRET',
  'ADMIN_TOKEN',
  'CLOVER_ENV',
  'PUBLIC_BASE_URL',
  'DEMO_MERCHANT_ID',
];

export function createHealthCheckHandler(options: HealthCheckOptions = {}) {
  return async (_req: Request, res: Response): Promise<void> => {
    const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

    let dbConnected = true;
    let dbError: string | null = null;
    let dbCode: number | string | null = null;

    if (options.store) {
      try {
        // Real store round trip: read meta/health
        await options.store.doc('meta', 'health').get();
      } catch (err: any) {
        dbConnected = false;
        dbError = err.message || 'Store check failed';
        dbCode = err.code ?? (err.status ?? 503);
      }
    }

    const worker = options.getWorkerStatus
      ? options.getWorkerStatus()
      : { activeJobs: 0, listening: false };

    let schedulerLeader: string | null = null;
    if (options.getSchedulerHolder) {
      try {
        schedulerLeader = await options.getSchedulerHolder();
      } catch {
        schedulerLeader = null;
      }
    }

    if (!dbConnected) {
      res.status(503).json({
        status: 'UNHEALTHY',
        service: 'Vecta-what',
        identity: options.identity,
        target: options.target,
        error: dbError,
        code: dbCode,
        timestamp: options.clock ? options.clock.now() : Date.now(),
        missingEnvVars,
        database: {
          connected: false,
          error: dbError,
          code: dbCode,
        },
        worker,
        schedulerLeader,
      });
      return;
    }

    res.status(200).json({
      status: 'ok',
      service: 'Vecta-what',
      identity: options.identity,
      target: options.target,
      timestamp: options.clock ? options.clock.now() : Date.now(),
      missingEnvVars,
      database: {
        connected: true,
        error: null,
      },
      worker,
      schedulerLeader,
    });
  };
}
