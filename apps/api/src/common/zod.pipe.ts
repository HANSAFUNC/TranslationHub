import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import type { ZodSchema } from 'zod';

/** Validate a request payload against a zod schema and return the parsed value. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new LocaleHubError(
        ErrorCode.VALIDATION_ERROR,
        result.error.issues.map((issue) => `${issue.path.join('.') || '<body>'}: ${issue.message}`).join('; '),
        422,
        result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    return result.data;
  }
}

export function zodBody<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
