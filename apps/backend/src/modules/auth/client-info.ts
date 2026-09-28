import type { FastifyRequest } from 'fastify';

export interface ClientInfo {
  ipAddress: string | null;
  userAgent: string | null;
}

export function getClientInfo(req: FastifyRequest): ClientInfo {
  const rawUa = req.headers['user-agent'];
  const userAgent = Array.isArray(rawUa) ? rawUa.join(', ') : (rawUa || null);
  return {
    ipAddress: req.ip || null,
    userAgent,
  };
}
