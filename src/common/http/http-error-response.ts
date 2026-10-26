import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { AuthError, UserError } from '../../interfaces/error';

export function writeHttpError(res: Response, error: unknown): Response {
  if (error instanceof AuthError) return res.status(403).json({ code: 'AUTH_ERROR', message: error.message });
  if (error instanceof UserError && error.message === 'RECIPIENT_DISCOVERY_DISABLED') return res.status(404).send('Not Found');
  if (error instanceof UserError && error.message.startsWith('STALE_OWNABLE')) {
    return res.status(409).json({ code: 'STALE_OWNABLE', message: error.message });
  }
  if (error instanceof UserError) return res.status(400).send(error.message);

  console.error(error);
  return res.status(500).send('Unexpected error');
}

export function throwHttpError(error: unknown): never {
  if (error instanceof AuthError) throw new ForbiddenException({ code: 'AUTH_ERROR', message: error.message });
  if (error instanceof UserError && error.message === 'RECIPIENT_DISCOVERY_DISABLED') throw new NotFoundException();
  if (error instanceof UserError) throw new BadRequestException(error.message);
  throw error;
}
