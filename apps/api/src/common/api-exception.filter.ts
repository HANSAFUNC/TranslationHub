import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ErrorCode, LocaleHubError, type ApiFailure } from '@localehub/contracts';
import type { Response } from 'express';
import { Prisma } from '@localehub/database';
import { contextRequestId } from './request-context';

/**
 * Single error shape for every endpoint (spec §8.4):
 *   { success: false, error: { code, message, details, requestId } }
 * Internal details are never leaked to the client; they are logged instead.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = contextRequestId();
    const { status, body } = this.toResponse(exception, requestId);
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId ?? '-'}] ${status} ${body.error.code}: ${body.error.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    response.status(status).json(body);
  }

  private toResponse(exception: unknown, requestId?: string): { status: number; body: ApiFailure } {
    if (exception instanceof LocaleHubError) {
      return {
        status: exception.status,
        body: { success: false, error: { code: exception.code, message: exception.message, details: exception.details, requestId } },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : Array.isArray((payload as { message?: unknown }).message)
            ? ((payload as { message: string[] }).message).join('; ')
            : ((payload as { message?: string }).message ?? exception.message);
      return {
        status,
        body: {
          success: false,
          error: {
            code: status === 404 ? ErrorCode.NOT_FOUND : status === 403 ? ErrorCode.ROLE_INSUFFICIENT : ErrorCode.VALIDATION_ERROR,
            message,
            requestId,
          },
        },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          body: {
            success: false,
            error: { code: ErrorCode.CONFLICT, message: 'A record with these values already exists', details: exception.meta, requestId },
          },
        };
      }
      if (exception.code === 'P2025') {
        return { status: HttpStatus.NOT_FOUND, body: { success: false, error: { code: ErrorCode.NOT_FOUND, message: 'Record not found', requestId } } };
      }
      if (exception.code === 'P2021' || exception.code === 'P2010') {
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          body: { success: false, error: { code: ErrorCode.INTERNAL_ERROR, message: 'Database schema is out of date; run migrations', requestId } },
        };
      }
    }
    const message = exception instanceof Error ? exception.message : 'Unexpected error';
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { success: false, error: { code: ErrorCode.INTERNAL_ERROR, message, requestId } },
    };
  }
}
