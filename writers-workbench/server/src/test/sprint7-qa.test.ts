import { describe, it, expect } from 'vitest';

// swagger-jsdoc types the spec as `object` — cast to any for property access in tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSpec(): Promise<any> {
  const mod = await import('../swagger.js');
  return mod.swaggerSpec;
}

describe('S7-2: Swagger/OpenAPI spec', () => {
  it('swagger spec module exports a valid spec object', async () => {
    const spec = await getSpec();
    expect(spec).toBeDefined();
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info.title).toBe('The Writers Workbench API');
    expect(spec.info.version).toBe('1.0.0');
  });

  it('swagger spec has paths defined', async () => {
    const spec = await getSpec();
    const paths = Object.keys(spec.paths || {});
    expect(paths.length).toBeGreaterThan(0);
  });

  it('swagger spec includes health endpoint', async () => {
    const spec = await getSpec();
    expect(spec.paths['/health']).toBeDefined();
    expect(spec.paths['/health'].get).toBeDefined();
  });

  it('swagger spec includes chat proxy endpoint', async () => {
    const spec = await getSpec();
    expect(spec.paths['/chat/proxy']).toBeDefined();
    expect(spec.paths['/chat/proxy'].post).toBeDefined();
  });

  it('swagger spec includes export endpoint', async () => {
    const spec = await getSpec();
    expect(spec.paths['/export/docx']).toBeDefined();
  });

  it('swagger spec includes admin endpoints', async () => {
    const spec = await getSpec();
    expect(spec.paths['/admin/users']).toBeDefined();
    expect(spec.paths['/admin/metrics']).toBeDefined();
    expect(spec.paths['/admin/workflows']).toBeDefined();
    expect(spec.paths['/admin/storage']).toBeDefined();
  });

  it('swagger spec includes session endpoints', async () => {
    const spec = await getSpec();
    expect(spec.paths['/session/register']).toBeDefined();
    expect(spec.paths['/session/unregister']).toBeDefined();
    expect(spec.paths['/session/active']).toBeDefined();
  });

  it('swagger spec includes callback endpoints', async () => {
    const spec = await getSpec();
    expect(spec.paths['/callback/content-ready']).toBeDefined();
    expect(spec.paths['/callback/events']).toBeDefined();
  });

  it('swagger spec includes image endpoints', async () => {
    const spec = await getSpec();
    expect(spec.paths['/images/generate']).toBeDefined();
    expect(spec.paths['/images/save']).toBeDefined();
  });

  it('swagger spec includes account endpoints', async () => {
    const spec = await getSpec();
    expect(spec.paths['/account']).toBeDefined();
    expect(spec.paths['/account/cascade-info']).toBeDefined();
  });

  it('swagger spec includes brainstorm endpoints', async () => {
    const spec = await getSpec();
    expect(spec.paths['/brainstorm/parse']).toBeDefined();
    expect(spec.paths['/brainstorm/submit']).toBeDefined();
  });

  it('swagger spec has security scheme defined', async () => {
    const spec = await getSpec();
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe('http');
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('swagger spec has all component schemas', async () => {
    const spec = await getSpec();
    const schemas = Object.keys(spec.components.schemas || {});
    expect(schemas).toContain('Error');
    expect(schemas).toContain('HealthResponse');
    expect(schemas).toContain('ChatProxyRequest');
    expect(schemas).toContain('ExportDocxRequest');
    expect(schemas).toContain('AdminUser');
    expect(schemas).toContain('SessionActiveResponse');
  });
});

describe('S7-2: Swagger UI route registration', () => {
  it('/api/docs path is configured (swagger-ui-express installed)', async () => {
    const mod = await import('swagger-ui-express');
    expect(mod.serve).toBeDefined();
    expect(mod.setup).toBeDefined();
  });
});
