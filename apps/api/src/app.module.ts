import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SyncService } from '@localehub/domain';
import { PrismaService } from './common/prisma.service';
import { AuthGuard } from './common/auth';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response.interceptor';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { AuditService } from './common/audit.service';
import { QueueService } from './common/queue.service';
import { HealthController } from './modules/health/health.controller';
import { AuthController } from './modules/auth/auth.controller';
import { ProjectsController } from './modules/projects/projects.controller';
import { ProjectsService } from './modules/projects/projects.service';
import { TranslationsController } from './modules/translations/translations.controller';
import { TranslationsService } from './modules/translations/translations.service';
import { SyncController } from './modules/sync/sync.controller';
import { TokensController } from './modules/tokens/tokens.controller';
import { QaController } from './modules/qa/qa.controller';
import { QaService } from './modules/qa/qa.service';
import { ContentController } from './modules/misc/content.controller';
import { PlatformController } from './modules/misc/platform.controller';
import { McpController } from './modules/mcp/mcp.controller';

@Module({
  controllers: [
    HealthController,
    AuthController,
    ProjectsController,
    TranslationsController,
    SyncController,
    TokensController,
    QaController,
    ContentController,
    PlatformController,
    McpController,
  ],
  providers: [
    PrismaService,
    AuditService,
    QueueService,
    ProjectsService,
    TranslationsService,
    QaService,
    { provide: SyncService, useFactory: (prisma: PrismaService) => new SyncService(prisma, prisma.tenant), inject: [PrismaService] },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
  exports: [PrismaService, AuditService, QueueService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
