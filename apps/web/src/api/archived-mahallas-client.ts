import {
  ListArchivedMahallasResponse,
  ListArchivedMahallasResponseSchema,
  DeleteArchivedMahallaRequest,
  DeleteArchivedMahallaResponse,
  DeleteArchivedMahallaResponseSchema,
} from '@mahalla-ovozi/api-contracts';
import { request } from '../lib/api-client.js';
export const archivedMahallasClient = {
  listArchivedMahallas(): Promise<ListArchivedMahallasResponse> {
    return request<ListArchivedMahallasResponse>(
      '/api/v1/admin/archived-mahallas',
      {
        method: 'GET',
      },
      ListArchivedMahallasResponseSchema
    );
  },

  deleteArchivedMahalla(
    topicId: string,
    payload: DeleteArchivedMahallaRequest
  ): Promise<DeleteArchivedMahallaResponse> {
    return request<DeleteArchivedMahallaResponse>(
      `/api/v1/admin/archived-mahallas/${encodeURIComponent(topicId)}`,
      {
        method: 'DELETE',
        body: JSON.stringify(payload),
      },
      DeleteArchivedMahallaResponseSchema
    );
  },
};
