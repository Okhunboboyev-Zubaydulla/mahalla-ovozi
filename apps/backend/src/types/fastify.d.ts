import type { ActorContext } from '@mahalla-ovozi/api-contracts';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: ActorContext;
  }
}
