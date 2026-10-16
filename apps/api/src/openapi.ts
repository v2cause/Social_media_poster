import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { z } from 'zod';

import { AuditLogPageDto, AuditLogQueryDto } from './modules/audit/audit.controller';
import * as channelDtos from './modules/channels/channels.dto';
import * as contentDtos from './modules/content/content.dto';
import { MeDto } from './modules/identity/me.controller';
import * as mediaDtos from './modules/media/media.dto';
import * as tenancyDtos from './modules/tenancy/tenancy.dto';

// The OpenAPI document of the API. packages/api-client generates the typed TanStack Query client
// from it (Orval, ADR 0013). The integration tests keep packages/api-client/openapi.json current.

/** Every DTO of the API. A test fails if a schema of the document has no entry here. */
export const OPENAPI_DTOS: { name: string; schema: z.ZodType }[] = [
  MeDto,
  AuditLogPageDto,
  AuditLogQueryDto,
  ...Object.values(tenancyDtos),
  ...Object.values(contentDtos),
  ...Object.values(mediaDtos),
  ...Object.values(channelDtos),
];

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** Operation ids like "organizationMembers": readable hook names in the generated client. */
const operationId = (controllerKey: string, methodKey: string): string => {
  const controller = controllerKey.replace(/Controller$/, '');
  return `${controller.charAt(0).toLowerCase()}${controller.slice(1)}${capitalize(methodKey)}`;
};

/**
 * The component schemas, generated from the zod schemas themselves. nestjs-zod hands nullable
 * properties to Nest's swagger module as type arrays, which it reads as arrays: a nullable string
 * would become string[]. zod's own OpenAPI 3.0 output describes them as nullable.
 */
function schemasFromZod(document: OpenAPIObject): void {
  const schemas = document.components?.schemas ?? {};
  for (const dto of OPENAPI_DTOS) {
    for (const [name, io] of [
      [dto.name, 'input'],
      [`${dto.name}_Output`, 'output'],
    ] as const) {
      if (name in schemas) {
        const schema: Record<string, unknown> = {
          ...z.toJSONSchema(dto.schema, { target: 'openapi-3.0', io }),
        };
        delete schema['$schema'];
        schemas[name] = schema;
      }
    }
  }
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Social Media Poster API')
    .setVersion('0.0.0')
    .addCookieAuth('smp.session_token')
    .build();
  const document = cleanupOpenApiDoc(
    SwaggerModule.createDocument(app, config, { operationIdFactory: operationId }),
    {
      version: '3.0',
    },
  );
  schemasFromZod(document);
  return document;
}
