import type { FastifyInstance } from 'fastify';
import { ok } from '@pegasus/shared';
import type { Deps } from '../deps.js';
import { disabledBooksView } from '../services/books.js';

/** The six paper books (docs/proposals/paper-books-2026-11.md). It answers on every stack; where they do not run the view says so. */
export async function registerBooksRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  app.get('/api/books', async () => ok(deps.books ? deps.books.view() : disabledBooksView()));
}
