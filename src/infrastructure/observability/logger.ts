import type { LoggerService } from '@nestjs/common';

/** Campos de correlação permitidos nos logs. Nada de valores ou payloads financeiros. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** Logger estruturado: uma linha JSON por evento (fácil de indexar no Loki/ELK/CloudWatch). */
export class JsonLogger implements LoggerService {
  constructor(private readonly minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info') {}

  info(msg: string, ctx: LogContext = {}): void {
    this.write('info', msg, ctx);
  }
  warn(msg: string, ctx: LogContext = {}): void {
    this.write('warn', msg, ctx);
  }
  error(msg: string, ctx: LogContext = {}): void {
    this.write('error', msg, ctx);
  }
  debug(msg: string, ctx: LogContext = {}): void {
    this.write('debug', msg, ctx);
  }

  // ---- interface LoggerService do Nest (mensagens internas do framework)
  log(message: unknown, context?: unknown): void {
    this.write('info', String(message), typeof context === 'string' ? { component: context } : {});
  }
  verbose(message: unknown): void {
    this.write('debug', String(message), {});
  }

  private write(level: Level, msg: string, ctx: LogContext): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...ctx });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function errorInfo(err: unknown): { error: string; errorName?: string } {
  const e = err as any;
  return { error: String(e?.message ?? err), errorName: e?.name };
}
