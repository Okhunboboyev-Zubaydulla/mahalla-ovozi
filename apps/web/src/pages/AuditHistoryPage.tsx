import React, { useState, useRef, useMemo, useCallback } from 'react';
import {
  Card,
  Typography,
  Table,
  Tag,
  Button,
  Space,
  Flex,
  Alert,
  Tooltip,
  theme,
} from 'antd';
import {
  ReloadOutlined,
  EyeOutlined,
  LeftOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
  GlobalOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import {
  AuditHistoryItem,
  AuditActorRole,
  AuditHistoryQuery,
} from '@mahalla-ovozi/api-contracts';
import { useAuditHistory } from '../api/audit-client.js';
import { AuditFilterBar, AuditFilters } from '../components/audit/AuditFilterBar.js';
import { AuditEventDetailDrawer } from '../components/audit/AuditEventDetailDrawer.js';
import { formatTashkentDate, getActionDisplayNameUz } from '../lib/formatters.js';

const { Title, Paragraph, Text } = Typography;

const getActorRoleTag = (role: AuditActorRole | null | undefined) => {
  switch (role) {
    case 'PRODUCT_OWNER':
      return (
        <Tag color="blue" icon={<SafetyCertificateOutlined />}>
          Маҳсулот эгаси
        </Tag>
      );
    case 'DISTRICT_HOKIM':
      return (
        <Tag color="green" icon={<UserOutlined />}>
          Туман ҳокими
        </Tag>
      );
    case 'SYSTEM':
      return (
        <Tag color="purple" icon={<GlobalOutlined />}>
          Тизим
        </Tag>
      );
    default:
      return <Tag color="default">{role || 'Номаълум'}</Tag>;
  }
};

export const AuditHistoryPage: React.FC = () => {
  const { token } = theme.useToken();

  // Filters state
  const [filters, setFilters] = useState<AuditFilters>({});

  // Pagination state: cursor and direction
  const [paginationState, setPaginationState] = useState<{
    cursor?: string;
    direction: 'forward' | 'backward';
  }>({
    cursor: undefined,
    direction: 'forward',
  });

  // Selected event for detail drawer
  const [selectedEvent, setSelectedEvent] = useState<AuditHistoryItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const lastActiveElementRef = useRef<HTMLElement | null>(null);

  // Build query
  const queryParams: AuditHistoryQuery = useMemo(
    () => ({
      limit: 25,
      cursor: paginationState.cursor,
      direction: paginationState.direction,
      recordType: filters.recordType || 'ALL',
      districtId: filters.districtId,
      startDate: filters.startDate,
      endDate: filters.endDate,
      category: filters.category,
      actorRole: filters.actorRole,
      outcome: filters.outcome,
      action: filters.action,
      search: filters.search,
    }),
    [filters, paginationState],
  );

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    dataUpdatedAt,
    refetch,
  } = useAuditHistory(queryParams);

  const items = data?.items || [];
  const pagination = data?.pagination;

  // Handle filter changes (resets pagination to top)
  const handleFilterChange = (newFilters: AuditFilters) => {
    setFilters(newFilters);
    setPaginationState({
      cursor: undefined,
      direction: 'forward',
    });
  };

  const handleResetFilters = () => {
    setFilters({});
    setPaginationState({
      cursor: undefined,
      direction: 'forward',
    });
  };

  // Pagination actions
  const handleNextPage = () => {
    if (!pagination?.nextCursor) return;
    setPaginationState({
      cursor: pagination.nextCursor,
      direction: 'forward',
    });
  };

  const handlePrevPage = () => {
    if (!pagination?.prevCursor) return;
    setPaginationState({
      cursor: pagination.prevCursor,
      direction: 'backward',
    });
  };

  // Open detail drawer with focus save (FE4)
  const handleOpenDetail = useCallback((event: AuditHistoryItem, e: React.MouseEvent<HTMLElement>) => {
    lastActiveElementRef.current = e.currentTarget;
    setSelectedEvent(event);
    setDrawerOpen(true);
  }, []);

  // Close detail drawer with focus restoration (FE4)
  const handleCloseDetail = useCallback(() => {
    setDrawerOpen(false);
    setSelectedEvent(null);
    if (lastActiveElementRef.current) {
      lastActiveElementRef.current.focus();
    }
  }, []);

  const columns = useMemo(() => [
    {
      title: 'Сана ва вақт',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (val: string) => (
        <Text style={{ fontSize: 13 }}>{formatTashkentDate(val)}</Text>
      ),
    },
    {
      title: 'Бажарувчи (Актор)',
      key: 'actor',
      width: 190,
      render: (_: unknown, record: AuditHistoryItem) => {
        if (record.recordType === 'PERMANENT_DELETION_PROOF') {
          return (
            <Space direction="vertical" size={2}>
              {record.cancelledById ? (
                <Tag color="blue" icon={<SafetyCertificateOutlined />}>
                  Маҳсулот эгаси
                </Tag>
              ) : (
                <Tag color="purple" icon={<GlobalOutlined />}>
                  Тизим
                </Tag>
              )}
              {record.cancelledById && (
                <Text type="secondary" code style={{ fontSize: 11 }}>
                  {record.cancelledById}
                </Text>
              )}
            </Space>
          );
        }
        return (
          <Space direction="vertical" size={2}>
            {getActorRoleTag(record.actorRole)}
            {record.actorId && (
              <Text type="secondary" code style={{ fontSize: 11 }}>
                {record.actorId}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Туман',
      dataIndex: 'districtName',
      key: 'district',
      width: 180,
      render: (name: string | null, record: AuditHistoryItem) =>
        name ? (
          <Text strong>{name}</Text>
        ) : record.districtId ? (
          <Text code>{record.districtId}</Text>
        ) : (
          <Tag color="purple">Глобал</Tag>
        ),
    },
    {
      title: 'Ҳаракат ва Тоифа',
      key: 'action',
      render: (_: unknown, record: AuditHistoryItem) => {
        if (record.recordType === 'PERMANENT_DELETION_PROOF') {
          return (
            <Space direction="vertical" size={2}>
              <Tag color="purple" icon={<SafetyCertificateOutlined />}>
                Ўчирилганлик маълумотномаси
              </Tag>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {record.lifecycleComplete
                  ? 'Тўлиқ якунланган'
                  : record.backupExpiryStatus === 'FAILED' ||
                      record.restoreReconciliationStatus === 'FAILED'
                    ? 'Хатолик юз берган'
                    : 'Заҳира муддати кутилмоқда'}
              </Text>
            </Space>
          );
        }
        return (
          <Space direction="vertical" size={2}>
            <Text strong>{getActionDisplayNameUz(record.action)}</Text>
            <Text type="secondary" code style={{ fontSize: 11 }}>
              {record.action}
            </Text>
          </Space>
        );
      },
    },
    {
      title: 'Натижа',
      key: 'outcome',
      width: 140,
      render: (_: unknown, record: AuditHistoryItem) => {
        if (record.recordType === 'PERMANENT_DELETION_PROOF') {
          const isFailed =
            record.liveDeletionStatus === 'FAILED' ||
            record.backupExpiryStatus === 'FAILED' ||
            record.restoreReconciliationStatus === 'FAILED';
          return !isFailed && record.liveDeletionStatus === 'COMPLETED' ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              Ўчирилган
            </Tag>
          ) : (
            <Tag color="error" icon={<CloseCircleOutlined />}>
              Хатолик
            </Tag>
          );
        }
        return record.outcome === 'SUCCESS' ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            Муваффақиятли
          </Tag>
        ) : (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            Хатолик
          </Tag>
        );
      },
    },
    {
      title: 'Амаллар',
      key: 'actions',
      width: 110,
      render: (_: unknown, record: AuditHistoryItem) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={(e) => handleOpenDetail(record, e)}
          aria-label={`Тафсилот: ${record.id}`}
        >
          Тафсилот
        </Button>
      ),
    },
  ], [handleOpenDetail]);

  return (
    <Card
      variant="borderless"
      style={{
        borderRadius: 12,
        background: token.colorBgContainer,
      }}
      role="region"
      aria-label="Аудит тарихи саҳифаси"
    >
      <Flex justify="space-between" align="flex-start" wrap="wrap" gap="middle" style={{ marginBottom: token.marginMD }}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
            Аудит тарихи
          </Title>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            Тизимдаги барча маъмурий амаллар, хавфсизлик ҳодисалари, ҳолат ўзгаришлари ва қайта уринишларнинг ўзгармас тарихи
          </Paragraph>
        </div>

        <Tooltip title="Маълумотларни янгилаш">
          <Button
            icon={<ReloadOutlined spin={isFetching} />}
            onClick={() => refetch()}
            loading={isFetching}
            aria-label="Маълумотларни янгилаш"
          >
            Янгилаш
          </Button>
        </Tooltip>
      </Flex>

      {/* Offline / Stale Data Banner (AC 10) */}
      {isError && items.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Тармоқ алоқасида узилиш ёки сўровда хатолик юз берди"
          description={
            <Flex justify="space-between" align="center" wrap="wrap">
              <span>
                {error instanceof Error && error.message ? `${error.message}. ` : ''}
                Кўрсатилаётган маълумотлар кэшдан олинган.
                {dataUpdatedAt > 0 && ` Охирги муваффақиятли янгиланиш: ${formatTashkentDate(new Date(dataUpdatedAt).toISOString())}.`}
              </span>
              <Button size="small" type="primary" onClick={() => refetch()} style={{ marginTop: 4 }}>
                Қайта уриниш
              </Button>
            </Flex>
          }
          style={{ marginBottom: token.marginMD }}
        />
      )}

      {/* Initial load error with no cached data */}
      {isError && items.length === 0 && (
        <Alert
          type="error"
          showIcon
          message="Аудит маълумотларини юклашда хатолик юз берди"
          description={
            error instanceof Error ? error.message : 'Сервер билан алоқа мавжуд эмас.'
          }
          action={
            <Button size="small" danger onClick={() => refetch()}>
              Қайта уриниш
            </Button>
          }
          style={{ marginBottom: token.marginMD }}
        />
      )}

      {/* Filters Bar */}
      <div style={{ marginBottom: token.marginMD }}>
        <AuditFilterBar
          filters={filters}
          onChange={handleFilterChange}
          onReset={handleResetFilters}
        />
      </div>

      {/* Audit Events Table */}
      <Table
        dataSource={items}
        columns={columns}
        rowKey="id"
        loading={isLoading || isFetching}
        pagination={false}
        size="middle"
        aria-label="Аудит тарихи жадвали"
        locale={{
          emptyText: 'Аудит ёзувлари топилмади',
        }}
        scroll={{ x: 800 }}
      />

      {/* Keyset Pagination Footer Controls */}
      <Flex
        justify="space-between"
        align="center"
        wrap="wrap"
        gap="middle"
        style={{
          marginTop: token.marginMD,
          paddingTop: token.paddingSM,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Text type="secondary" style={{ fontSize: 13 }}>
          {items.length > 0
            ? `Кўрсатилмоқда: ${items.length} та ёзув`
            : 'Ёзувлар мавжуд эмас'}
        </Text>

        <Space size="small">
          <Button
            icon={<LeftOutlined />}
            onClick={handlePrevPage}
            disabled={!pagination?.hasPrevPage || isFetching}
            aria-label="Олдинги саҳифа"
          >
            Олдинги
          </Button>

          <Button
            icon={<RightOutlined />}
            iconPosition="end"
            onClick={handleNextPage}
            disabled={!pagination?.hasNextPage || isFetching}
            aria-label="Кейинги саҳифа"
          >
            Кейинги
          </Button>
        </Space>
      </Flex>

      {/* Audit Event Detail Drawer */}
      <AuditEventDetailDrawer
        open={drawerOpen}
        event={selectedEvent}
        onClose={handleCloseDetail}
      />
    </Card>
  );
};

export default AuditHistoryPage;
