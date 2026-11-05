import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/** GET /api/books: the five paper books; answers on every stack (`enabled` false where they do not run). */
export function useBooks() {
  return useQuery({ queryKey: ['books'], queryFn: () => api.books(), staleTime: 30_000, refetchInterval: 60_000 });
}
