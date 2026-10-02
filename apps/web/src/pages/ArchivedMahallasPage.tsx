import React, { useState, useCallback } from 'react';
import {
  Card,
  Typography,
  Table,
  Button,
  Empty,
  Alert,
  App as AntdApp,
} from 'antd';
import { DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArchivedMahallaListItemDto } from '@mahalla-ovozi/api-contracts';
import { archivedMahallasClient } from '../api/archived-mahallas-client.js';
import { archivedMahallaQueryKeys } from '../district/query-keys.js';
import { DeleteArchivedMahallaModal } from '../components/archived/DeleteArchivedMahallaModal.js';
import { ApiError } from '../lib/api-client.js';
import { formatTashkentDate } from '../lib/formatters.js';

const { Title, Paragraph } = Typography;

export const ArchivedMahallasPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { message } = AntdApp.useApp();

  const [deleteTarget, setDeleteTarget] = useState<ArchivedMahallaListItemDto | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: archivedMahallaQueryKeys.list(),
    queryFn: () => archivedMahallasClient.listArchivedMahallas(),
  });

  const items = data?.items ?? [];

  const deleteMutation = useMutation({
    mutationFn: async ({
      topicId,
      confirmMahallaName,
    }: {
      topicId: string;
      confirmMahallaName: string;
    }) => {
      return archivedMahallasClient.deleteArchivedMahalla(topicId, {
        confirmMahallaName,
      });
    },
    onSuccess: async () => {
      message.success('Архивланган маҳалла бутунлай ўчирилди.');
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: archivedMahallaQueryKeys.all });
    },
    onError: (err: Error) => {
      if (err instanceof ApiError) {
        // 409: someone else deleted it, or the mahalla was reactivated. 404: already gone.
        // Both mean the row on screen is stale — refresh the list so it disappears.
        if (err.statusCode === 409 || err.statusCode === 404) {
          message.error(err.message || 'Маҳалла ҳолати ўзгарган. Рўйхат янгиланди.');
          setDeleteTarget(null);
          void queryClient.invalidateQueries({ queryKey: archivedMahallaQueryKeys.all });
          return;
        }

        // 400: the typed name did not match on the server. Keep the modal open so the
        // owner can retype it; the modal renders this error on the field.
        if (err.statusCode === 400) {
          return;
        }
      }

      message.error(err.message || 'Маҳаллани ўчиришда хатолик юз берди.');
    },
  });

  const handleDeleteConfirm = useCallback(
    async (confirmMahallaName: string) => {
      if (!deleteTarget) {
        return;
      }
      await deleteMutation.mutateAsync({
        topicId: deleteTarget.topicId,
        confirmMahallaName,
      });
    },
    [deleteTarget, deleteMutation]
  );

  const columns = [
    {
      title: 'Туман',
      dataIndex: 'districtName',
      key: 'districtName',
      render: (districtName: string) => districtName || '—',
    },
    {
      title: 'Маҳалла',
      dataIndex: 'mahallaName',
      key: 'mahallaName',
      render: (mahallaName: string) => <strong>{mahallaName}</strong>,
    },
    {
      title: 'Архивланган сана',
      dataIndex: 'archivedAt',
      key: 'archivedAt',
      render: (archivedAt: string | null) => formatTashkentDate(archivedAt),
    },
    {
      title: 'Далиллар сони',
      dataIndex: 'evidenceCount',
      key: 'evidenceCount',
      align: 'right' as const,
    },
    {
      title: 'Проекциялар сони',
      dataIndex: 'projectionCount',
      key: 'projectionCount',
      align: 'right' as const,
    },
    {
      title: 'Амаллар',
      key: 'actions',
      render: (_: unknown, record: ArchivedMahallaListItemDto) => (
        <Button
          type="link"
          danger
          icon={<DeleteOutlined />}
          aria-label={`Бутунлай ўчириш: ${record.mahallaName}`}
          onClick={() => setDeleteTarget(record)}
          style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}
        >
          Бутунлай ўчириш
        </Button>
      ),
    },
  ];

  return (
    <Card
      variant="borderless"
      style={{ borderRadius: 12 }}
      title={
        <div>
          <Title level={3} style={{ margin: 0 }}>Архивланган маҳаллалар</Title>
          <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
            Телеграм гуруҳи ўчирилган маҳаллалар рўйхати. Бу ердан маҳаллани бутунлай ўчириш мумкин.
          </Paragraph>
        </div>
      }
    >
      {isError ? (
        <div style={{ padding: '24px 0' }}>
          <Alert
            type="error"
            showIcon
            message="Архивланган маҳаллалар рўйхатини юклаб бўлмади"
            description="Сервер билан боғланишда хатолик юз берди. Илтимос, қайта уриниб кўринг."
            action={
              <Button type="primary" danger onClick={() => void refetch()}>
                Қайта уриниш
              </Button>
            }
          />
        </div>
      ) : !isLoading && items.length === 0 ? (
        <div style={{ padding: '48px 0', textAlign: 'center' }}>
          <Empty
            image={<InboxOutlined style={{ fontSize: 48, color: '#bfbfbf' }} />}
            description={
              <div>
                <Title level={4} style={{ marginBottom: 8 }}>
                  Ҳозирча архивланган маҳаллалар йўқ
                </Title>
                <Paragraph type="secondary">
                  Телеграм гуруҳи ўчирилган маҳаллалар шу ерда пайдо бўлади.
                </Paragraph>
              </div>
            }
          />
        </div>
      ) : (
        <div role="region" aria-label="Архивланган маҳаллалар рўйхати">
          <Table
            dataSource={items}
            columns={columns}
            rowKey="topicId"
            loading={isLoading}
            pagination={
              items.length > 10
                ? {
                    defaultPageSize: 10,
                    showSizeChanger: true,
                    pageSizeOptions: ['10', '20', '50'],
                    showTotal: (total, range) =>
                      `${total} та маҳалладан ${range[0]}–${range[1]} кўрсатилмоқда`,
                  }
                : false
            }
            scroll={{ x: 'max-content' }}
          />
        </div>
      )}

      <DeleteArchivedMahallaModal
        open={!!deleteTarget}
        topicId={deleteTarget?.topicId ?? ''}
        mahallaName={deleteTarget?.mahallaName ?? ''}
        districtName={deleteTarget?.districtName ?? ''}
        isPending={deleteMutation.isPending}
        onConfirm={handleDeleteConfirm}
        onClose={() => setDeleteTarget(null)}
      />
    </Card>
  );
};
