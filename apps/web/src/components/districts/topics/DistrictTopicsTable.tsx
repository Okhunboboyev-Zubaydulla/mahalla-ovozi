import React from 'react';
import { Table, Tag, Button, Typography, Empty, Space } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  MessageOutlined,
  FileTextOutlined,
  UserOutlined,
  DownOutlined,
  ClockCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { TopicCardItem, QualifyingLane } from '@mahalla-ovozi/api-contracts';
import { formatTashkentActivityTime } from '../../../lib/formatters.js';
import { LANE_LABELS, LANE_STYLES } from '../../topics/TopicCard.js';

const { Text, Paragraph } = Typography;

export interface DistrictTopicsTableProps {
  topics: TopicCardItem[];
  totalCount: number;
  isLoading: boolean;
  isFetching?: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNextPage: () => void;
  onOpenEvidence: (topic: TopicCardItem, triggerElement: HTMLElement) => void;
  hasActiveFilters?: boolean;
}

export const DistrictTopicsTable: React.FC<DistrictTopicsTableProps> = ({
  topics,
  totalCount,
  isLoading,
  isFetching = false,
  hasNextPage,
  isFetchingNextPage,
  onFetchNextPage,
  onOpenEvidence,
  hasActiveFilters = false,
}) => {
  const columns: ColumnsType<TopicCardItem> = [
    {
      title: 'Маҳалла',
      dataIndex: 'mahallaName',
      key: 'mahallaName',
      width: 150,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Мавзу хулосаси',
      dataIndex: 'summary',
      key: 'summary',
      render: (summary: string | null) => {
        if (summary === null) {
          return (
            <Tag
              color="processing"
              icon={<SyncOutlined spin />}
              style={{ borderRadius: 4, margin: 0, fontSize: 12 }}
            >
              Тайёрланмоқда...
            </Tag>
          );
        }
        return (
          <Paragraph
            ellipsis={{ rows: 2, tooltip: summary }}
            style={{ marginBottom: 0, fontSize: 13, lineHeight: '1.4' }}
          >
            {summary}
          </Paragraph>
        );
      },
    },
    {
      title: 'Сана',
      dataIndex: 'calendarDay',
      key: 'calendarDay',
      width: 110,
      render: (day: string) => (
        <Tag style={{ borderRadius: 4, margin: 0, fontSize: 12 }}>{day}</Tag>
      ),
    },
    {
      title: 'Йўналишлар',
      dataIndex: 'lanes',
      key: 'lanes',
      width: 180,
      render: (lanes: QualifyingLane[], record) => (
        <Space size={[0, 4]} wrap>
          {(lanes || []).map((lane, index) => {
            const style = LANE_STYLES[lane] || {
              bg: '#F1F5F9',
              text: '#475569',
              border: '#E2E8F0',
            };
            return (
              <Tag
                key={`${record.id}-${lane}-${index}`}
                style={{
                  backgroundColor: style.bg,
                  color: style.text,
                  borderColor: style.border,
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  margin: 0,
                }}
              >
                {LANE_LABELS[lane] || lane}
              </Tag>
            );
          })}
        </Space>
      ),
    },
    {
      title: 'Фаоллик',
      dataIndex: 'latestMeaningfulActivityTimestamp',
      key: 'latestMeaningfulActivityTimestamp',
      width: 120,
      render: (ts: string) => (
        <Space size={4} style={{ fontSize: 12, color: '#64748B' }}>
          <ClockCircleOutlined style={{ fontSize: 11 }} />
          <span>{formatTashkentActivityTime(ts)}</span>
        </Space>
      ),
    },
    {
      title: 'Далиллар',
      dataIndex: 'evidenceCount',
      key: 'evidenceCount',
      width: 90,
      align: 'center',
      render: (count: number) => (
        <Tag
          icon={<MessageOutlined />}
          style={{
            borderRadius: 12,
            padding: '2px 8px',
            fontSize: 12,
            fontWeight: 600,
            backgroundColor: '#F1F5F9',
            borderColor: '#CBD5E1',
            color: '#334155',
            margin: 0,
          }}
        >
          {count}
        </Tag>
      ),
    },
    {
      title: 'Қидирув мослиги',
      dataIndex: 'searchMatchBadge',
      key: 'searchMatchBadge',
      width: 130,
      align: 'center',
      render: (badge: 'evidence' | 'author' | null | undefined) => {
        if (badge === 'author') {
          return (
            <Tag color="purple" icon={<UserOutlined />} style={{ margin: 0 }}>
              Муаллиф
            </Tag>
          );
        }
        if (badge === 'evidence') {
          return (
            <Tag color="blue" icon={<FileTextOutlined />} style={{ margin: 0 }}>
              Далил матни
            </Tag>
          );
        }
        return <Text type="secondary">—</Text>;
      },
    },
    {
      title: 'Амаллар',
      key: 'actions',
      width: 110,
      align: 'center',
      render: (_, record: TopicCardItem) => (
        <Button
          type="link"
          icon={<FileTextOutlined />}
          onClick={(e) => onOpenEvidence(record, e.currentTarget)}
          style={{
            padding: '4px 8px',
            height: 'auto',
            fontSize: 13,
            fontWeight: 500,
          }}
          aria-label={
            record.summary === null
              ? 'Далилларни кўриш (хулоса тайёрланмоқда)'
              : `Далилларни кўриш: ${record.summary}`
          }
        >
          Далиллар
        </Button>
      ),
    },
  ];

  const emptyText = hasActiveFilters
    ? 'Танланган шартлар бўйича мавзулар топилмади.'
    : 'Ҳозирча мавзулар мавжуд эмас.';

  return (
    <div role="region" aria-label="Туман мавзулари жадвали">
      <Table
        dataSource={topics}
        columns={columns}
        rowKey="id"
        loading={isLoading || (isFetching && !isFetchingNextPage)}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <div style={{ padding: '32px 0', textAlign: 'center' }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Text style={{ color: '#64748B', fontSize: 13 }}>
                    {emptyText}
                  </Text>
                }
              />
            </div>
          ),
        }}
      />

      {/* Keyset Progressive Loading Footer Controls */}
      {topics.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '16px 0',
            marginTop: 8,
          }}
        >
          <Text type="secondary" style={{ fontSize: 13 }}>
            {totalCount > 0
              ? `${totalCount} тадан ${topics.length} та кўрсатилмоқда`
              : `${topics.length} та мавзу кўрсатилмоқда`}
          </Text>

          {hasNextPage && (
            <Button
              onClick={onFetchNextPage}
              loading={isFetchingNextPage}
              icon={!isFetchingNextPage ? <DownOutlined style={{ fontSize: 12 }} /> : undefined}
              style={{
                height: 38,
                padding: '0 24px',
                borderRadius: 6,
                fontWeight: 600,
                fontSize: 13,
              }}
              aria-label="Кўпроқ мавзуларни юклаш"
            >
              {isFetchingNextPage ? 'Юкланмоқда...' : 'Кўпроқ юклаш'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
