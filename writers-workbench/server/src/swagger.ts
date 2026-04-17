import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'The Writers Workbench API',
      version: '1.0.0',
      description:
        'Backend API for The Writers Workbench — dashboard for The Author Agent AI writing automation system. ' +
        'All protected routes require a Supabase Auth JWT in the Authorization header.',
      contact: { email: 'eric@agileadtesting.com' },
    },
    servers: [
      { url: '/api', description: 'API base path' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase Auth access token',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            service: { type: 'string', example: 'writers-workbench-api' },
            timestamp: { type: 'string', format: 'date-time' },
            checks: {
              type: 'object',
              properties: {
                supabase: { type: 'string', enum: ['ok', 'error', 'skipped'] },
              },
            },
          },
        },
        ChatProxyRequest: {
          type: 'object',
          required: ['user_message_request', 'user_id'],
          properties: {
            user_message_request: { type: 'string', maxLength: 5000 },
            user_id: { type: 'string', description: 'Phone number in E.164 format' },
          },
        },
        ExportDocxRequest: {
          type: 'object',
          required: ['project_id'],
          properties: {
            project_id: { type: 'string', format: 'uuid' },
            page_size: {
              type: 'string',
              enum: ['5x8', '5.5x8.5', '6x9', '8.5x11', 'A4', 'A5'],
              default: '6x9',
            },
          },
        },
        AdminUser: {
          type: 'object',
          properties: {
            user_id: { type: 'string' },
            display_name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['user', 'admin', 'editor', 'viewer'] },
            content_count: { type: 'integer' },
            project_count: { type: 'integer' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        AdminCreateUserRequest: {
          type: 'object',
          required: ['phone', 'display_name'],
          properties: {
            phone: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$', description: 'E.164 format' },
            display_name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['user', 'admin', 'editor', 'viewer'], default: 'user' },
          },
        },
        AdminMetrics: {
          type: 'object',
          properties: {
            totalUsers: { type: 'integer' },
            totalContent: { type: 'integer' },
            totalProjects: { type: 'integer' },
            totalResearch: { type: 'integer' },
            totalImages: { type: 'integer' },
            totalSocialPosts: { type: 'integer' },
            contentByStatus: { type: 'object', additionalProperties: { type: 'integer' } },
            contentByType: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
        SessionActiveResponse: {
          type: 'object',
          properties: {
            active: { type: 'boolean' },
            channel: { type: 'string', nullable: true, enum: ['web', null] },
          },
        },
        ContentReadyRequest: {
          type: 'object',
          required: ['user_id'],
          properties: {
            user_id: { type: 'string' },
            content_title: { type: 'string' },
            content_type: { type: 'string' },
            content_id: { type: 'string', format: 'uuid' },
          },
        },
        BrainstormSubmitRequest: {
          type: 'object',
          required: ['content_text', 'title', 'genre_slug'],
          properties: {
            content_text: { type: 'string' },
            title: { type: 'string' },
            genre_slug: { type: 'string' },
            story_arc: { type: 'string' },
            target_chapter_count: { type: 'integer' },
            themes: { type: 'array', items: { type: 'string' } },
          },
        },
        ImageGenerateRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            reference_image_url: { type: 'string', format: 'uri' },
            project_id: { type: 'string', format: 'uuid' },
            genre_slug: { type: 'string' },
          },
        },
        ImageSaveRequest: {
          type: 'object',
          required: ['image_url', 'prompt'],
          properties: {
            image_url: { type: 'string', format: 'uri' },
            prompt: { type: 'string' },
            project_id: { type: 'string', format: 'uuid' },
            genre_slug: { type: 'string' },
            title: { type: 'string' },
          },
        },
        DeleteAccountRequest: {
          type: 'object',
          required: ['confirmation'],
          properties: {
            confirmation: { type: 'string', enum: ['DELETE'] },
          },
        },
        CascadeInfo: {
          type: 'object',
          properties: {
            projects: { type: 'integer' },
            content: { type: 'integer' },
            research: { type: 'integer' },
            storyBible: { type: 'integer' },
            images: { type: 'integer' },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
