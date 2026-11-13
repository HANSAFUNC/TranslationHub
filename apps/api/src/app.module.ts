import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SyncService } from '@localehub/domain';
import { PrismaService } from './common/prisma.service';
import { AuthGuard } from './common/auth';
import { RateLimitGuard, RateLimitService } from './common/rate-limit';
import { CsrfGuard } from './common/csrf';
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
import { MockupsController } from './modules/mockups/mockups.controller';
import { MockupsService } from './modules/mockups/mockups.service';
import { QaService } from './modules/qa/qa.service';
import { ContentController } from './modules/misc/content.controller';
import { PlatformController } from './modules/misc/platform.controller';
import { McpController } from './modules/mcp/mcp.controller';
import { OrganizationsController } from './modules/organizations/organizations.controller';
import { OrganizationsService } from './modules/organizations/organizations.service';
import { UsersController } from './modules/users/users.controller';
import { OpenApiController } from './openapi/openapi.controller';
import { WebhooksController } from './modules/webhooks/webhooks.controller';
import { WebhooksService } from './modules/webhooks/webhooks.service';
import { UsersService } from './modules/users/users.service';

@Module({
  controllers: [
    HealthController,
    AuthController,
    ProjectsController,
    TranslationsController,
    SyncController,
    TokensController,
    QaController,
    MockupsController,
    ContentController,
    PlatformController,
    McpController,
    OrganizationsController,
    UsersController,
    OpenApiController,
    WebhooksController,
  ],
  providers: [
    PrismaService,
    AuditService,
    QueueService,
    ProjectsService,
    TranslationsService,
    QaService,
    MockupsService,
    OrganizationsService,
    UsersService,
    WebhooksService,
    {
      provide: SyncService,
      useFactory: (prisma: PrismaService) => new SyncService(prisma, prisma.tenant),
      inject: [PrismaService],
    },
    RateLimitService,
    // Order matters: Nest runs global guards in registration order. Authentication resolves the
    // actor, so the limiter can key on it (and on IP for the public credential routes), and CSRF
    // verification needs to know whether the credential was a cookie.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
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
