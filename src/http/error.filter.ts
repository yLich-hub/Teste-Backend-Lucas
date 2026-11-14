import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../application/errors';
import { DomainError, ValidationError } from '../domain/errors';
import { isTransientDbError } from '../infrastructure/database/database';
import { errorInfo, JsonLogger } from '../infrastructure/observability/logger';

/**
 * Mapeamento ÚNICO de erro -> HTTP, igual para todos os endpoints:
 *
 *  400 VALIDATION_ERROR      payload inválido            (corrigir antes de reenviar)
 *  404 *_NOT_FOUND           recurso inexistente
 *  409 IDEMPOTENCY_CONFLICT  mesma key, payload diferente (não reenviar)
 *  409 WALLET_ALREADY_EXISTS
 *  503 SERVICE_UNAVAILABLE   falha transitória            (reenviar com a MESMA key)
 *  500 INTERNAL_ERROR        bug / inesperado
 *
 * Resultados de transação (200/202/422) não são erros: ver WageringController.
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message } = this.map(err);
    if (status === 503) res.setHeader('Retry-After', '1');
    if (status >= 500) this.logger.error('request failed', { status, code, ...errorInfo(err) });
    res.status(status).json({ code, message });
  }

  private map(err: unknown): { status: number; code: string; message: string } {
    if (err instanceof ValidationError) return { status: 400, code: err.code, message: err.message };
    if (err instanceof AppError) {
      const status = { validation: 400, not_found: 404, conflict: 409, transient: 503 }[err.category];
      return { status, code: err.code, message: err.message };
    }
    if (err instanceof DomainError) return { status: 422, code: err.code, message: err.message };
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return { status, code: status === 400 ? 'VALIDATION_ERROR' : 'HTTP_ERROR', message: err.message };
    }
    if (isTransientDbError(err)) {
      return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'temporarily unavailable, retry later' };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error' };
  }
}
